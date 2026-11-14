// elisp-react.js -- the JavaScript host of react.el.
// Copyright (c) 2026 modeverv
// SPDX-License-Identifier: MIT
//
// All of React is in Emacs Lisp (lisp/react.el), running in Emacs, which runs
// in this page as WebAssembly (the wasmacs eval service).  This file is the
// part that has to be JavaScript:
//
//   1. start Emacs and load react.el and the page's Emacs Lisp,
//   2. apply the DOM operations Lisp returns,
//   3. send DOM events to Lisp,
//   4. do what Lisp cannot do from inside a request: wait (timers), talk to
//      the network (fetch), keep things (localStorage), and answer later.
//
// A page loads it as a module and writes its program in Emacs Lisp:
//
//   <div id="app">Loading Emacs…</div>
//   <script type="text/emacs-lisp" src="counter.el"></script>
//   <script type="module" src="../../js/elisp-react.js"></script>
//
// Every <script type="text/emacs-lisp"> (with src, or inline) is evaluated
// in document order.  window.elispReact.ready resolves when the page is up;
// the events "elisp-react:ready" and "elisp-react:error" fire on document.

const DEFAULT_WASMACS = "https://modeverv.github.io/wasmacs/";

// Where the wasmacs eval service is published.  <meta name="elisp-react:wasmacs">
// sets it for a page; ?wasmacs=... overrides it for local development and is
// honoured for loopback addresses only (it names code that the page runs).
function wasmacsBase() {
  const param = new URLSearchParams(location.search).get("wasmacs");
  if (param) {
    const url = new URL(param, location.href);
    if (/^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname)) return url.href;
    console.warn(`elisp-react: ignoring ?wasmacs=${param} (only loopback addresses are accepted)`);
  }
  const meta = document.querySelector('meta[name="elisp-react:wasmacs"]');
  return new URL(meta?.content || DEFAULT_WASMACS, location.href).href;
}

async function fetchText(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

// ---- DOM operations ---------------------------------------------------------
// Lisp names DOM nodes by number (see `react-flush' in react.el).

// DOM methods Lisp may call on a node (`react-invoke').
const INVOCABLE = new Set(["focus", "blur", "select", "click", "scrollIntoView"]);

function createDom(dispatch, host) {
  const nodes = new Map();       // id -> Node
  const listeners = new Map();   // "id:event" -> function

  const node = (id) => {
    const found = nodes.get(id);
    if (!found) throw new Error(`elisp-react: unknown DOM node ${id}`);
    return found;
  };
  const register = (id, created) => {
    created.__elispReactId = id;
    nodes.set(id, created);
  };
  // NODE left the page: forget it and everything below it.
  const forget = (gone) => {
    const id = gone.__elispReactId;
    if (id !== undefined) {
      nodes.delete(id);
      for (const key of listeners.keys()) if (key.startsWith(`${id}:`)) listeners.delete(key);
    }
    gone.childNodes.forEach(forget);
  };
  // What Lisp gets to know about an event.
  const describe = (event) => {
    const target = event.target;
    return {
      type: event.type,
      value: typeof target?.value === "string" ? target.value : null,
      checked: typeof target?.checked === "boolean" ? target.checked : null,
      key: typeof event.key === "string" ? event.key : null,
      // A file input: what the visitor chose.  The files themselves stay in
      // the page; `react-fetch' can send one (:file).
      files: target?.files ? [...target.files].map((file) => ({ name: file.name, size: file.size, type: file.type })) : null,
    };
  };

  const operations = {
    create(id, tag) { register(id, document.createElement(tag)); },
    text(id, text) { register(id, document.createTextNode(text)); },
    "set-text"(id, text) { node(id).data = text; },
    attr(id, name, value) {
      if (value === null || value === false) node(id).removeAttribute(name);
      else node(id).setAttribute(name, value === true ? "" : String(value));
    },
    prop(id, name, value) {
      const element = node(id);
      const next = name === "checked" ? Boolean(value) : value ?? "";
      if (element[name] !== next) element[name] = next;
    },
    listen(id, name) {
      const key = `${id}:${name}`;
      if (listeners.has(key)) return;
      const listener = (event) => {
        // Lisp answers later, too late to decide this: a form handled in
        // Lisp is not also submitted by the browser.
        if (name === "submit") event.preventDefault();
        dispatch(id, name, describe(event));
      };
      listeners.set(key, listener);
      node(id).addEventListener(name, listener);
    },
    unlisten(id, name) {
      const key = `${id}:${name}`;
      const listener = listeners.get(key);
      if (!listener) return;
      node(id).removeEventListener(name, listener);
      listeners.delete(key);
    },
    insert(parentId, id, beforeId) { node(parentId).insertBefore(node(id), beforeId === null ? null : node(beforeId)); },
    replace(oldId, id) {
      const old = node(oldId);
      old.replaceWith(node(id));
      forget(old);
    },
    remove(id) {
      const gone = node(id);
      gone.remove();
      forget(gone);
    },
    mount(selector, id) {
      const container = document.querySelector(selector);
      if (!container) throw new Error(`elisp-react: nothing matches ${selector}`);
      if (node(id).parentNode !== container) container.replaceChildren(node(id));
    },
    invoke(id, method) {
      if (!INVOCABLE.has(method)) throw new Error(`elisp-react: ${method} cannot be invoked from Lisp`);
      node(id)[method]();
    },
    call(request, command, argument) { host.call(request, command, argument, (id) => nodes.get(id)); },
    tell(command, argument) { host.tell(command, argument); },
    cancel(request) { host.cancel(request); },
  };

  return {
    apply(ops) {
      for (const [name, ...args] of ops || []) {
        const operation = operations[name];
        if (!operation) throw new Error(`elisp-react: unknown DOM operation ${name}`);
        operation(...args);
      }
    },
    nodeCount: () => nodes.size,
  };
}

// ---- what Lisp asks of the page -------------------------------------------------
// A request ("call") is answered later through reply(request, ok, value), which
// runs the Lisp function that waits for it.  Starting one returns a function
// that cancels it.

// localStorage keys of this page: Lisp sees them without the prefix.
const storagePrefix = () => `elisp-react:${location.pathname}:`;

function storedEntries() {
  const entries = [];
  try {
    const prefix = storagePrefix();
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.startsWith(prefix)) entries.push([key.slice(prefix.length), localStorage.getItem(key)]);
    }
  } catch (_) { /* no storage (private mode, sandbox): start empty */ }
  return entries;
}

function createHost(reply, fetchFunction) {
  const pending = new Map();   // request -> cancel function
  const commands = {
    timeout(request, milliseconds) {
      const timer = setTimeout(() => { pending.delete(request); reply(request, true, null); }, milliseconds);
      return () => clearTimeout(timer);
    },
    interval(request, milliseconds) {
      const timer = setInterval(() => reply(request, true, null), milliseconds);
      return () => clearInterval(timer);
    },
    fetch(request, { url, method, headers, body, file }, nodeOf) {
      const controller = new AbortController();
      // :file names a file input; its first file is the body, as it is.
      if (file !== undefined && file !== null) {
        body = nodeOf(file)?.files?.[0];
        if (!body) {
          Promise.resolve().then(() => { if (pending.delete(request)) reply(request, false, "No file is chosen"); });
          return () => {};
        }
      }
      // Lisp's header names are keywords: content-type, accept, ...
      fetchFunction(url, { method: method || "GET", headers: headers || {}, body: body ?? undefined, signal: controller.signal })
        .then(async (response) => ({ status: response.status, ok: response.ok, text: await response.text() }))
        .then((value) => { if (pending.delete(request)) reply(request, true, value); },
              (error) => { if (pending.delete(request)) reply(request, false, error?.message || String(error)); });
      return () => controller.abort();
    },
  };
  const notices = {
    "storage-set"({ key, value }) { localStorage.setItem(storagePrefix() + key, value); },
    "storage-remove"({ key }) { localStorage.removeItem(storagePrefix() + key); },
  };
  return {
    call(request, command, argument, nodeOf) {
      if (!commands[command]) throw new Error(`elisp-react: unknown host command ${command}`);
      pending.set(request, commands[command](request, argument, nodeOf));
    },
    tell(command, argument) {
      if (!notices[command]) throw new Error(`elisp-react: unknown host command ${command}`);
      try { notices[command](argument); } catch (error) { console.warn("[elisp-react]", command, error); }
    },
    cancel(request) {
      const cancel = pending.get(request);
      if (!cancel) return;
      pending.delete(request);
      cancel();
    },
  };
}

// ---- loading Emacs Lisp ---------------------------------------------------------
// Source that is only evaluated runs in Emacs's interpreter, which expands
// every macro (jsx) at every call: a render is about 35 times slower than
// with byte-compiled code.  So each file is byte-compiled inside Emacs, and
// the compiled code is kept in localStorage under a hash of the source: the
// next visit loads it without compiling.

const lispString = (text) => `"${String(text).replace(/[\\"]/g, "\\$&")}"`;

async function sourceHash(text) {
  if (!globalThis.crypto?.subtle) return null;    // not a secure context: compile every time
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// What the byte compiler said, without its own chatter.
function compileLog(output) {
  return String(output || "").split("\n")
    .filter((line) => !/^(Compiling |Wrote |Loading |Source file .* newer)/.test(line))
    .join("\n").trim();
}

// Evaluate the Emacs Lisp TEXT, compiled.  NAME identifies it (a URL, or
// "inline script 1"); VERSION is Emacs's, whose byte code it is.
// Resolves with { file, log }: the name the file has inside Emacs (the
// compiler's messages mention it) and the compiler's warnings, "" if none.
// An error that is thrown carries the same two.
async function loadLisp(emacs, version, name, text) {
  const file = `/tmp/elisp-react/${name.replace(/[^A-Za-z0-9_.-]+/g, "_")}.el`;
  // Compiled code needs the file to say that it uses lexical binding.
  const source = /^.*lexical-binding:/.test(text) ? text : `;;; -*- lexical-binding: t; -*-\n${text}`;
  const hash = await sourceHash(`${version}\n${source}`);
  const storageKey = `elisp-react:compiled:${name}`;
  let stored = null;
  let log = "";
  try { stored = hash && JSON.parse(localStorage.getItem(storageKey) || "null"); } catch (_) { /* compile */ }
  try {
    if (stored?.hash === hash) {
      await emacs.eval(`(let ((coding-system-for-write 'no-conversion))
        (make-directory (file-name-directory ${lispString(file)}) t)
        (with-temp-file ${lispString(`${file}c`)}
          (set-buffer-multibyte nil)
          (insert (base64-decode-string ${lispString(stored.code)})))
        (load ${lispString(`${file}c`)} nil t)
        nil)`);
      return { file, log: stored.log || "" };
    }
    // Two steps, so that the compiler's messages are known even when
    // loading the result fails.
    const compiled = await emacs.eval(`(let ((coding-system-for-write 'utf-8-unix))
      (make-directory (file-name-directory ${lispString(file)}) t)
      (with-temp-file ${lispString(file)} (insert ${lispString(source)}))
      (and (byte-compile-file ${lispString(file)})
           (with-temp-buffer
             (set-buffer-multibyte nil)
             (insert-file-contents-literally ${lispString(`${file}c`)})
             (base64-encode-string (buffer-string) t))))`, { detailed: true });
    log = compileLog(compiled.output);
    if (compiled.value) {
      await emacs.eval(`(progn (load ${lispString(`${file}c`)} nil t) nil)`);
      try {
        if (hash) localStorage.setItem(storageKey, JSON.stringify({ hash, code: compiled.value, log }));
      } catch (_) { /* full: compile next time */ }
      return { file, log };
    }
    // It does not compile: evaluate it, so that the error is the program's.
    console.warn(`[elisp-react] ${name} could not be byte-compiled; evaluating it instead`);
    await emacs.eval(`${text}\nnil`);
    return { file, log };
  } catch (error) {
    error.message = `${name}: ${error.message}`;
    error.file = file;
    error.log = log;
    throw error;
  }
}

// ---- start --------------------------------------------------------------------

function reportError(error) {
  console.error("[elisp-react]", error);
  document.dispatchEvent(new CustomEvent("elisp-react:error", { detail: error }));
  let box = document.querySelector("#elisp-react-error");
  if (!box) {
    box = document.createElement("pre");
    box.id = "elisp-react-error";
    box.style.cssText = "position:fixed;left:0;right:0;bottom:0;margin:0;padding:8px 12px;max-height:40vh;overflow:auto;"
      + "background:#5c1010;color:#fff;font:12px/1.4 monospace;white-space:pre-wrap;z-index:99999";
    document.body.append(box);
  }
  const symbol = error?.symbol ? `${error.symbol}: ` : "";
  box.textContent += `${symbol}${error?.message || error}\n`;
}

/**
 * Start Emacs, load react.el and the page's Emacs Lisp, render.
 *   wasmacs   base URL of the wasmacs site (default: see wasmacsBase)
 *   library   URL of react.el (default: ../lisp/react.el next to this file)
 *   sources   [{ name, text }] to evaluate instead of the page's
 *             <script type="text/emacs-lisp"> elements
 *   fetch     a function to use instead of the browser's fetch for
 *             `react-fetch' (a development tool answers some URLs itself)
 * Resolves with { emacs, version, bootMs, dom, load }: `emacs` is the eval
 * service (emacs.eval, emacs.call), for experiments from the console;
 * load(name, text) evaluates changed source in the running page.
 */
export async function start({ wasmacs = wasmacsBase(), library = new URL("../lisp/react.el", import.meta.url), sources = null,
                              fetch: fetchFunction = (...args) => fetch(...args) } = {}) {
  const { createEmacsEvalService } = await import(new URL("app/src/emacs-eval-client.js", wasmacs).href);
  const emacs = createEmacsEvalService({ onOutput: (text) => console.log(`[emacs] ${text.trimEnd()}`) });

  let dom = null;
  // Events are answered in the order they happened: the service works on one
  // request at a time, and each answer is applied before the next arrives.
  const dispatch = (id, name, event) => {
    emacs.call("react-dispatch-event", id, name, event).then((ops) => dom.apply(ops), reportError);
  };
  const host = createHost((request, ok, value) => {
    emacs.call("react-host-reply", request, ok, value).then((ops) => dom.apply(ops), reportError);
  }, fetchFunction);
  dom = createDom(dispatch, host);

  if (!sources) {
    sources = await Promise.all([...document.querySelectorAll('script[type="text/emacs-lisp"]')].map(async (script, index) => (
      script.src ? { name: script.src, text: await fetchText(script.src) }
        : { name: `${location.pathname} inline script ${index + 1}`, text: script.textContent }
    )));
  }
  const [info, libraryText] = await Promise.all([emacs.ready, fetchText(library)]);
  await loadLisp(emacs, info.version, new URL(library, location.href).href, libraryText);
  await emacs.call("react--storage-load", storedEntries());
  const compileLogs = [];
  for (const source of sources) {
    compileLogs.push({ name: source.name, ...(await loadLisp(emacs, info.version, source.name, source.text)) });
  }
  dom.apply(await emacs.call("react-flush"));
  return {
    emacs, dom, version: info.version, bootMs: info.bootMs, cached: info.cached,
    // Evaluate changed source while the page runs (a development tool).
    // Components that are defined again keep the state of their instances.
    // Resolves with { file, log } (see loadLisp).
    async load(name, text) {
      const loaded = await loadLisp(emacs, info.version, name, text);
      dom.apply(await emacs.call("react-flush"));
      return loaded;
    },
    // Evaluate a few forms as they are (not compiled) and render.
    async run(text) {
      await emacs.eval(`${text}\nnil`);
      dom.apply(await emacs.call("react-flush"));
    },
    // What the compiler said about the files loaded at the start:
    // [{ name, file, log }].
    compileLogs,
  };
}

// A page that contains Emacs Lisp starts by itself.
if (typeof document !== "undefined" && document.querySelector('script[type="text/emacs-lisp"]')
    && !document.documentElement.hasAttribute("data-elisp-react-manual")) {
  const ready = start();
  window.elispReact = { ready };
  ready.then((app) => {
    Object.assign(window.elispReact, app);
    document.dispatchEvent(new CustomEvent("elisp-react:ready", { detail: app }));
  }, reportError);
}
