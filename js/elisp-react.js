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

// Block inline handler/srcdoc props and script schemes in URL attributes.
// Page-authored Lisp and deliberately created script elements remain trusted code.
const URL_ATTRIBUTES = new Set([
  "href", "src", "action", "formaction", "data", "xlink:href",
  "background", "cite", "codebase", "longdesc", "manifest", "profile", "usemap",
]);

export function isSafeAttribute(name, value) {
  const attribute = name.toLowerCase();
  if (attribute.startsWith("on") || attribute === "srcdoc") {
    return false;
  }
  if (URL_ATTRIBUTES.has(attribute)) {
    // URL parsing removes TAB, CR and LF anywhere, then leading C0/space.
    // Check that spelling before handing the original value to the browser.
    const url = value.replace(/[\t\r\n]/g, "").replace(/^[\u0000-\u0020]+/, "");
    if (/^(?:javascript|vbscript):/i.test(url)) {
      return false;
    }
  }
  return true;
}

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
      const element = node(id);
      name = String(name);
      if (value === null || value === false) element.removeAttribute(name);
      else {
        const text = value === true ? "" : String(value);
        if (isSafeAttribute(name, text)) element.setAttribute(name, text);
        else {
          // Remove an older value too. Keep applying the batch so Lisp's
          // mounted tree and the DOM do not diverge after a rejected value.
          element.removeAttribute(name);
          console.warn("[elisp-react] ignored unsafe DOM attribute", name);
        }
      }
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
    tell(command, argument) { host.tell(command, argument, (id) => nodes.get(id)); },
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

// The options of fetch that `react-fetch' passes on as they are.
const FETCH_OPTIONS = ["credentials", "cache", "redirect", "mode", "keepalive", "priority", "referrerPolicy"];

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
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
    fetch(request, { url, method, headers, body, file, form, as, ...options }, nodeOf) {
      const controller = new AbortController();
      const fail = (message) => {
        Promise.resolve().then(() => { if (pending.delete(request)) reply(request, false, message); });
        return () => {};
      };
      // :file names a file input; its first file is the body, as it is.
      if (file !== undefined && file !== null) {
        body = nodeOf(file)?.files?.[0];
        if (!body) return fail("No file is chosen");
      }
      // :form: [[name, value]...], a value a string or {file: DOM id}: the
      // body is multipart/form-data, with every file of that input.
      if (form) {
        body = new FormData();
        for (const [name, value] of form) {
          if (value && typeof value === "object") {
            for (const chosen of nodeOf(value.file)?.files || []) body.append(name, chosen);
          } else body.append(name, value ?? "");
        }
      }
      // Lisp's header names are keywords: content-type, accept, ...
      const init = { method: method || "GET", headers: headers || {}, body: body ?? undefined, signal: controller.signal };
      for (const name of FETCH_OPTIONS) if (options[name] !== undefined && options[name] !== null) init[name] = options[name];
      fetchFunction(url, init)
        .then(async (response) => ({
          status: response.status, ok: response.ok, url: response.url, redirected: response.redirected,
          headers: Object.fromEntries(response.headers),
          ...(as === "base64" ? { base64: base64(await response.arrayBuffer()) } : { text: await response.text() }),
        }))
        .then((value) => { if (pending.delete(request)) reply(request, true, value); },
              (error) => { if (pending.delete(request)) reply(request, false, error?.message || String(error)); });
      return () => controller.abort();
    },
    // A connection answers again and again until it closes:
    // {type: "open"}, {type: "message", data}, {type: "close", code, reason},
    // {type: "error"}.
    websocket(request, { url, protocols }) {
      const socket = new WebSocket(new URL(url, location.href).href.replace(/^http/, "ws"), protocols || undefined);
      sockets.set(request, socket);
      const answer = (value) => { if (pending.has(request)) reply(request, true, value); };
      socket.onopen = () => answer({ type: "open" });
      socket.onmessage = (event) => answer({ type: "message", data: typeof event.data === "string" ? event.data : null });
      socket.onerror = () => answer({ type: "error" });
      socket.onclose = (event) => {
        sockets.delete(request);
        answer({ type: "close", code: event.code, reason: event.reason });
        pending.delete(request);
      };
      return () => { sockets.delete(request); socket.close(); };
    },
    "event-source"(request, { url, events, withCredentials }) {
      const source = new EventSource(url, { withCredentials: Boolean(withCredentials) });
      const answer = (event) => {
        if (pending.has(request)) reply(request, true, { type: event.type, data: event.data, id: event.lastEventId || null });
      };
      for (const name of ["message", ...(events || [])]) source.addEventListener(name, answer);
      source.onopen = () => { if (pending.has(request)) reply(request, true, { type: "open" }); };
      // The browser reconnects by itself; CLOSED means it gave up.
      source.onerror = () => {
        if (!pending.has(request)) return;
        reply(request, true, { type: source.readyState === EventSource.CLOSED ? "close" : "error" });
        if (source.readyState === EventSource.CLOSED) pending.delete(request);
      };
      return () => source.close();
    },
  };
  const sockets = new Map();   // request -> WebSocket
  const notices = {
    "websocket-send"({ request, data }) {
      const socket = sockets.get(request);
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("the connection is not open");
      socket.send(data);
    },
    "storage-set"({ key, value }) { localStorage.setItem(storagePrefix() + key, value); },
    "storage-remove"({ key }) { localStorage.removeItem(storagePrefix() + key); },
  };
  // Commands of the page itself: globalThis.elispReactCommands[name] is a
  // function (ARGUMENT, { reply, fail, node }) that may return a function
  // which cancels it; reply(value) answers Lisp, again and again if Lisp
  // keeps the request.  A notice gets (ARGUMENT, { node }).
  const pageCommand = (command) => {
    const own = globalThis.elispReactCommands;
    return own && Object.hasOwn(own, command) && typeof own[command] === "function" ? own[command] : null;
  };
  return {
    call(request, command, argument, nodeOf) {
      if (commands[command]) {
        pending.set(request, commands[command](request, argument, nodeOf));
        return;
      }
      const own = pageCommand(command);
      if (!own) throw new Error(`elisp-react: unknown host command ${command}`);
      pending.set(request, () => {});
      const cancel = own(argument, {
        reply: (value) => { if (pending.has(request)) reply(request, true, value ?? null); },
        fail: (message) => { if (pending.delete(request)) reply(request, false, String(message)); },
        node: (id) => nodeOf(id) || null,
      });
      if (pending.has(request)) pending.set(request, typeof cancel === "function" ? cancel : () => {});
    },
    tell(command, argument, nodeOf) {
      const notice = notices[command] || pageCommand(command);
      if (!notice) throw new Error(`elisp-react: unknown host command ${command}`);
      try { notice(argument, { node: (id) => nodeOf(id) || null }); } catch (error) { console.warn("[elisp-react]", command, error); }
    },
    cancel(request) {
      const cancel = pending.get(request);
      if (!cancel) return;
      pending.delete(request);
      cancel();
    },
    cancelAll() {
      for (const request of [...pending.keys()]) this.cancel(request);
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

// How long Lisp may take to answer an event or a reply before the page
// gives up on it: <meta name="elisp-react:timeout" content="MILLISECONDS">,
// 0 for never.
function lispTimeout() {
  const meta = document.querySelector('meta[name="elisp-react:timeout"]');
  const value = Number(meta?.content);
  return meta && Number.isFinite(value) && value >= 0 ? value : 30_000;
}

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
 *   timeout   milliseconds Lisp may take to answer an event or a reply
 *             (default 30000, or <meta name="elisp-react:timeout">; 0: no
 *             limit).  Lisp that takes longer (an endless loop) cannot be
 *             interrupted: the service is stopped and an error with the
 *             symbol "timeout" is reported.
 * Resolves with { emacs, version, bootMs, dom, load }: `emacs` is the eval
 * service (emacs.eval, emacs.call), for experiments from the console;
 * load(name, text) evaluates changed source in the running page.  `files`
 * says how Emacs gets its own Lisp files: "on demand" (the few it reads) or
 * "all" (the whole package, from a server without range requests).
 */
export async function start({ wasmacs = wasmacsBase(), library = new URL("../lisp/react.el", import.meta.url), sources = null,
                              fetch: fetchFunction = (...args) => fetch(...args), timeout = lispTimeout() } = {}) {
  const { createEmacsEvalService } = await import(new URL("app/src/emacs-eval-client.js", wasmacs).href);
  const emacs = createEmacsEvalService({ onOutput: (text) => console.log(`[emacs] ${text.trimEnd()}`) });

  let dom = null, host = null;
  // Set when Lisp did not answer in time: the service is stopped, and the
  // page sends it nothing more.
  let stopped = false;
  // Apply the DOM operations that ANSWER (a request to Lisp) resolves with.
  // A request that is not answered within TIMEOUT (an endless loop in a
  // handler: the worker cannot be interrupted) stops the service, so that
  // the page does not look alive while nothing reacts.
  const apply = (answer, what, done = () => {}, failed = () => {}) => {
    const timer = timeout > 0 && setTimeout(() => {
      if (stopped) return;
      stopped = true;
      host.cancelAll();
      emacs.terminate();
      const error = new Error(`Emacs Lisp did not answer ${what} within ${timeout / 1000} s, and Emacs was stopped; reload the page`);
      error.symbol = "timeout";
      reportError(error);
    }, timeout);
    answer.then((ops) => { clearTimeout(timer); if (!stopped) dom.apply(ops); done(); })
      .catch((error) => { clearTimeout(timer); if (!stopped) reportError(error); failed(error); });
  };
  // Events are answered in the order they happened: the service works on one
  // request at a time, and each answer is applied before the next arrives.
  const dispatch = (id, name, event) => {
    if (!stopped) apply(emacs.call("react-dispatch-event", id, name, event), `the ${name} event`);
  };
  host = createHost((request, ok, value) => {
    if (!stopped) apply(emacs.call("react-host-reply", request, ok, value), "an answer from the page");
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
  // Another tab of this page stored or removed a value: Lisp's copy follows,
  // and the functions watching that key run.
  addEventListener("storage", (event) => {
    const prefix = storagePrefix();
    if (stopped || event.storageArea !== localStorage || !event.key?.startsWith(prefix)) return;
    apply(emacs.call("react--storage-changed", event.key.slice(prefix.length), event.newValue), "a change in another tab");
  });
  const compileLogs = [];
  for (const source of sources) {
    compileLogs.push({ name: source.name, ...(await loadLisp(emacs, info.version, source.name, source.text)) });
  }
  dom.apply(await emacs.call("react-flush"));
  return {
    emacs, dom, version: info.version, bootMs: info.bootMs, cached: info.cached, files: info.files,
    // Evaluate changed source while the page runs (a development tool).
    // Components that are defined again keep the state of their instances.
    // Resolves with { file, log } (see loadLisp).
    async load(name, text) {
      const loaded = await loadLisp(emacs, info.version, name, text);
      dom.apply(await emacs.call("react-flush"));
      return loaded;
    },
    // Call the Lisp function NAME with ARGS (JSON data) and render what it
    // changed: how page JavaScript talks to Lisp.  Resolves when the page
    // has been updated.
    send(name, ...args) {
      return new Promise((resolve, reject) => {
        if (stopped) { reject(new Error("elisp-react: Emacs was stopped")); return; }
        apply(emacs.call("react-page-call", String(name), args), `the page's call of ${name}`, resolve, reject);
      });
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
