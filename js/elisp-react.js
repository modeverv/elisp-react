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

// DOM methods Lisp may call on a node (`react-invoke'), with arguments.
const INVOCABLE = new Set([
  "focus", "blur", "select", "click", "scrollIntoView", "scrollTo", "scrollBy",
  "setSelectionRange", "showModal", "show", "close", "requestSubmit", "reset",
  "reportValidity", "setCustomValidity", "play", "pause", "load", "requestFullscreen", "showPicker",
]);
// DOM properties Lisp may set (`react-set-property'; :value and :checked
// are props).  Nothing that takes markup or code.
const SETTABLE = new Set([
  "value", "checked", "indeterminate", "selectedIndex", "open", "muted", "volume", "currentTime",
  "playbackRate", "loop", "scrollTop", "scrollLeft",
]);

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

// HTML from elsewhere (a description, a comment, Markdown made HTML) put in
// a node with :inner-html, cleaned: elements outside this list are taken
// out (their text stays), these are dropped with their content, and only
// these attributes are kept, script URLs not.
const HTML_TAGS = new Set([
  "a", "abbr", "b", "bdi", "bdo", "blockquote", "br", "caption", "cite", "code", "col", "colgroup",
  "dd", "del", "details", "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p", "picture", "pre", "q",
  "rp", "rt", "ruby", "s", "samp", "small", "source", "span", "strong", "sub", "summary", "sup",
  "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var", "wbr",
]);
const HTML_DROPPED = new Set([
  "script", "style", "iframe", "frame", "frameset", "object", "embed", "applet", "template", "noscript",
  "link", "meta", "base", "form", "input", "button", "textarea", "select", "option", "svg", "math",
  "audio", "video", "canvas", "dialog", "slot",
]);
const HTML_ATTRIBUTES = new Set([
  "href", "src", "srcset", "sizes", "alt", "title", "class", "width", "height", "colspan", "rowspan",
  "lang", "dir", "start", "reversed", "type", "datetime", "cite", "open", "loading", "headers", "scope",
]);

function cleanHtml(parent) {
  for (const node of [...parent.childNodes]) {
    if (node.nodeType === Node.TEXT_NODE) continue;
    if (node.nodeType !== Node.ELEMENT_NODE) { node.remove(); continue; }
    const tag = node.localName;
    if (HTML_DROPPED.has(tag) || node.namespaceURI !== "http://www.w3.org/1999/xhtml") { node.remove(); continue; }
    cleanHtml(node);
    if (!HTML_TAGS.has(tag)) { node.replaceWith(...node.childNodes); continue; }
    for (const { name, value } of [...node.attributes]) {
      if (!HTML_ATTRIBUTES.has(name) || !isSafeAttribute(name, value)
          || (name === "srcset" && /(?:javascript|vbscript):/i.test(value))) node.removeAttribute(name);
    }
    if (tag === "a" && node.hasAttribute("href")) node.setAttribute("rel", "noopener noreferrer");
  }
}

export function sanitizedHtml(html) {
  // A <template>'s content is inert: nothing in it runs or loads.
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "");
  cleanHtml(template.content);
  return template.content;
}

// An SVG animation can set an attribute to a value later: <animate
// attributeName="href" to="javascript:...">.  Its values are URLs too.
const ANIMATIONS = new Set(["animate", "set", "animateMotion", "animateTransform"]);
function isScriptAnimation(element, name, value) {
  return element.namespaceURI === "http://www.w3.org/2000/svg" && ANIMATIONS.has(element.localName)
    && ["to", "from", "values", "by"].includes(name.toLowerCase())
    && /(^|;)\s*(?:javascript|vbscript):/i.test(value.replace(/[\t\r\n]/g, ""));
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
    const point = event.touches?.[0] || event.changedTouches?.[0] || event;
    let owner = target;
    while (owner && owner.__elispReactId === undefined) owner = owner.parentNode;
    return {
      type: event.type,
      value: typeof target?.value === "string" ? target.value : null,
      checked: typeof target?.checked === "boolean" ? target.checked : null,
      key: typeof event.key === "string" ? event.key : null,
      code: typeof event.code === "string" ? event.code : null,
      alt: Boolean(event.altKey), ctrl: Boolean(event.ctrlKey), meta: Boolean(event.metaKey), shift: Boolean(event.shiftKey),
      repeat: Boolean(event.repeat),
      // An input method is still composing: the key is not the visitor's
      // last word (Enter that confirms a conversion).
      composing: Boolean(event.isComposing),
      button: typeof event.button === "number" ? event.button : null,
      x: typeof point.clientX === "number" ? point.clientX : null,
      y: typeof point.clientY === "number" ? point.clientY : null,
      // The node (as Lisp numbers it) where the event happened.
      target: owner?.__elispReactId ?? null,
      // A file input: what the visitor chose.  The files themselves stay in
      // the page; `react-fetch' can send one (:file).
      files: target?.files ? [...target.files].map((file) => ({ name: file.name, size: file.size, type: file.type })) : null,
      // A submitted form: its fields, [[name, value]...] (a file by its name).
      form: event.type === "submit" && target instanceof HTMLFormElement
        ? [...new FormData(target, event.submitter || null)].map(([name, value]) => [name, typeof value === "string" ? value : value.name])
        : null,
    };
  };

  // Input events of a node whose answer has not been applied yet: a value
  // that Lisp sends in the answer to an older event (or a timer) is older
  // than what the visitor has typed since, and is not written.
  const inFlight = new Map();   // DOM id -> number of input/change events waiting for Lisp
  let applying = null;          // { id, seq } of the event whose answer is being applied
  const operations = {
    create(id, tag, namespace) {
      register(id, namespace === "svg" ? document.createElementNS("http://www.w3.org/2000/svg", tag) : document.createElement(tag));
    },
    text(id, text) { register(id, document.createTextNode(text)); },
    "set-text"(id, text) { node(id).data = text; },
    attr(id, name, value) {
      const element = node(id);
      name = String(name);
      if (value === null || value === false) element.removeAttribute(name);
      else {
        const text = value === true ? "" : String(value);
        if (isSafeAttribute(name, text) && !isScriptAnimation(element, name, text)) element.setAttribute(name, text);
        else {
          // Remove an older value too. Keep applying the batch so Lisp's
          // mounted tree and the DOM do not diverge after a rejected value.
          element.removeAttribute(name);
          console.warn("[elisp-react] ignored unsafe DOM attribute", name);
        }
      }
    },
    prop(id, name, value) {
      if (!SETTABLE.has(name)) {
        console.warn("[elisp-react] ignored a DOM property Lisp may not set", name);
        return;
      }
      const element = node(id);
      const next = ["checked", "indeterminate", "open", "muted", "loop"].includes(name) ? Boolean(value) : value ?? "";
      if (name === "value" && (inFlight.get(id) || 0) > (applying?.id === id ? 1 : 0)) return;
      if (element[name] !== next) element[name] = next;
    },
    // OPTIONS (from `react-handler'), decided here because Lisp answers
    // too late: keys (only these event.key), self (only events of this
    // node itself), prevent, stop, capture, passive, throttle.
    listen(id, name, options = null) {
      const key = `${id}:${name}`;
      const signature = JSON.stringify(options);
      const old = listeners.get(key);
      if (old?.signature === signature) return;
      if (old) operations.unlisten(id, name);
      const { keys, self, prevent, stop, capture, passive, throttle } = options || {};
      let last = 0, trailing = null;
      const send = (event) => {
        last = performance.now();
        const typed = name === "input" || name === "change";
        if (typed) inFlight.set(id, (inFlight.get(id) || 0) + 1);
        dispatch(id, name, describe(event), typed ? id : null);
      };
      const listener = (event) => {
        if (keys?.length && !keys.includes(event.key)) return;
        if (self && event.target !== event.currentTarget) return;
        // A form handled in Lisp is not also submitted by the browser.
        if (prevent || name === "submit") event.preventDefault();
        if (stop) event.stopPropagation();
        if (!throttle) { send(event); return; }
        clearTimeout(trailing);
        const wait = last + throttle - performance.now();
        if (wait <= 0) send(event);
        else trailing = setTimeout(() => send(event), wait);
      };
      listeners.set(key, { listener, signature, capture: Boolean(capture), stop: () => clearTimeout(trailing) });
      node(id).addEventListener(name, listener, { capture: Boolean(capture), passive: Boolean(passive) });
    },
    unlisten(id, name) {
      const key = `${id}:${name}`;
      const entry = listeners.get(key);
      if (!entry) return;
      entry.stop();
      node(id).removeEventListener(name, entry.listener, { capture: entry.capture });
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
    // :inner-html: HTML from elsewhere, cleaned; Lisp leaves the node's
    // children alone.
    html(id, html) { node(id).replaceChildren(sanitizedHtml(html)); },
    invoke(id, method, ...args) {
      if (!INVOCABLE.has(method)) throw new Error(`elisp-react: ${method} cannot be invoked from Lisp`);
      const element = node(id);
      if (typeof element[method] !== "function") {
        console.warn(`[elisp-react] ${method} is not a method of this node`);
        return;
      }
      // play() and requestFullscreen() may be refused (autoplay, no gesture).
      Promise.resolve(element[method](...args)).catch((error) => console.warn(`[elisp-react] ${method}:`, error?.message || error));
    },
    call(request, command, argument) { host.call(request, command, argument, (id) => nodes.get(id)); },
    tell(command, argument) { host.tell(command, argument, (id) => nodes.get(id)); },
    cancel(request) { host.cancel(request); },
  };

  return {
    // Apply OPS, the answer to an input or change event of the node FROM
    // (a DOM id) when given.
    apply(ops, from = null) {
      applying = from === null ? null : { id: from };
      try {
        for (const [name, ...args] of ops || []) {
          const operation = operations[name];
          if (!operation) throw new Error(`elisp-react: unknown DOM operation ${name}`);
          operation(...args);
        }
      } finally {
        if (from !== null) inFlight.set(from, Math.max(0, (inFlight.get(from) || 1) - 1));
        applying = null;
      }
    },
    // The answer to an input event of FROM failed: it waits no more.
    settled(from) { if (from !== null) inFlight.set(from, Math.max(0, (inFlight.get(from) || 1) - 1)); },
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

// What Lisp gets to know about an event of the window or the document: the
// event's own fields, and the page's size, scroll position and visibility.
function describePage(event) {
  return {
    type: event.type,
    key: typeof event.key === "string" ? event.key : null,
    width: innerWidth, height: innerHeight, x: scrollX, y: scrollY,
    visibility: document.visibilityState,
  };
}

// The options of fetch that `react-fetch' passes on as they are.
const FETCH_OPTIONS = ["credentials", "cache", "redirect", "mode", "keepalive", "priority", "referrerPolicy"];

function base64(buffer) {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function createHost(reply, fetchFunction, address) {
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
    // Events of the window or the document, answered at each one:
    // {target: "window" | "document", event, keys, prevent, throttle}.
    // keys: only these keys (event.key); prevent: preventDefault for those
    // that are sent; throttle: at most one answer per that many ms (the
    // last one is sent at the end).
    "page-listen"(request, { target, event: name, keys, prevent, throttle }) {
      const on = target === "document" ? document : window;
      let last = 0, trailing = null;
      const send = (event) => {
        last = performance.now();
        if (pending.has(request)) reply(request, true, describePage(event));
      };
      const listener = (event) => {
        if (keys?.length && !keys.includes(event.key)) return;
        if (prevent) event.preventDefault();
        if (!throttle) { send(event); return; }
        clearTimeout(trailing);
        const wait = last + throttle - performance.now();
        if (wait <= 0) send(event);
        else trailing = setTimeout(() => send(event), wait);
      };
      on.addEventListener(name, listener);
      return () => { clearTimeout(trailing); on.removeEventListener(name, listener); };
    },
    // What a node measures: its box, its scrolling, and for media its time.
    measure(request, { node: id }, nodeOf) {
      const element = nodeOf(id);
      queueMicrotask(() => {
        if (!pending.delete(request)) return;
        if (!element) { reply(request, false, "No such node"); return; }
        const box = element.getBoundingClientRect();
        reply(request, true, {
          x: box.x, y: box.y, width: box.width, height: box.height,
          scrollTop: element.scrollTop, scrollLeft: element.scrollLeft,
          scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
          clientWidth: element.clientWidth, clientHeight: element.clientHeight,
          ...(typeof element.currentTime === "number"
            ? { currentTime: element.currentTime, duration: Number.isFinite(element.duration) ? element.duration : null, paused: element.paused }
            : {}),
        });
      });
      return () => {};
    },
    // Whether a CSS media query matches: at once, and at each change.
    media(request, { query }) {
      const list = matchMedia(query);
      const answer = () => { if (pending.has(request)) reply(request, true, { matches: list.matches }); };
      list.addEventListener("change", answer);
      queueMicrotask(answer);
      return () => list.removeEventListener("change", answer);
    },
    // Whether a node is in view (IntersectionObserver): at once, and at
    // each change.
    "observe-visible"(request, { node, margin, threshold }, nodeOf) {
      const element = nodeOf(node);
      if (!element) {
        Promise.resolve().then(() => { if (pending.delete(request)) reply(request, false, "No such node"); });
        return () => {};
      }
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (pending.has(request)) reply(request, true, { visible: entry.isIntersecting, ratio: entry.intersectionRatio });
      }, { rootMargin: margin || "0px", threshold: threshold ?? 0 });
      observer.observe(element);
      return () => observer.disconnect();
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
    navigate({ url, replace }) { address.navigate(url, Boolean(replace)); },
    "history-go"({ delta }) { address.go(delta); },
    title({ text }) { document.title = text; },
    meta({ name, content }) {
      // og:… and twitter:… are properties; the rest are names.
      const attribute = /^(og|article|profile|video|music|book):/.test(name) ? "property" : "name";
      let meta = [...document.head.querySelectorAll(`meta[${attribute}]`)].find((each) => each.getAttribute(attribute) === name);
      if (content === null || content === undefined) { meta?.remove(); return; }
      if (!meta) { meta = document.createElement("meta"); meta.setAttribute(attribute, name); document.head.append(meta); }
      meta.setAttribute("content", content);
    },
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

// ---- the address ----------------------------------------------------------------
// Lisp reads the page's address and moves through its history.  A page in
// elisp-studio's preview (about:srcdoc) has no address of its own: there the
// host keeps one in memory, starting at "/", and follows hash links itself.

function createLocation(mode, changed) {
  const memory = mode === "memory" || (mode !== "browser" && location.href === "about:srcdoc");
  const entries = [new URL(memory ? "/" : location.href, "http://app.invalid").href], at = { index: 0 };
  const current = () => new URL(memory ? entries[at.index] : location.href);
  const describe = () => {
    const url = current();
    return { href: memory ? url.pathname + url.search + url.hash : url.href, pathname: url.pathname, search: url.search, hash: url.hash };
  };
  if (!memory) {
    addEventListener("popstate", () => changed(describe()));
    addEventListener("hashchange", () => changed(describe()));
  } else {
    // A hash link would load the studio into the frame: follow it here.
    document.addEventListener("click", (event) => {
      const link = event.target?.closest?.("a[href]");
      const href = link?.getAttribute("href");
      if (!href || !href.startsWith("#") || event.defaultPrevented) return;
      event.preventDefault();
      navigate(href, false);
    });
  }
  function navigate(url, replace) {
    if (memory) {
      const next = new URL(url, current()).href;
      if (replace) entries[at.index] = next;
      else { entries.splice(at.index + 1, Infinity, next); at.index += 1; }
      changed(describe());
      return;
    }
    const next = new URL(url, location.href);
    if (next.origin !== location.origin) { location.assign(next.href); return; }
    history[replace ? "replaceState" : "pushState"](null, "", next.href);
    changed(describe());
  }
  return {
    describe,
    navigate,
    go(delta) {
      if (!memory) { history.go(delta); return; }
      const index = Math.min(Math.max(at.index + delta, 0), entries.length - 1);
      if (index === at.index) return;
      at.index = index;
      changed(describe());
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
// The kept code is found under a hash of VERSION, of the file loaded
// before (PREVIOUS: its hash) and of TEXT: byte code holds the expansions
// of the macros it used, so it is good only after the same files.
// CACHE false neither reads nor keeps compiled code.
// Resolves with { file, log, hash }: the name the file has inside Emacs
// (the compiler's messages mention it), the compiler's warnings ("" if
// none), and the hash for the next file.  An error that is thrown carries
// the file and the log.
async function loadLisp(emacs, version, name, text, { previous = "", cache = true } = {}) {
  const file = `/tmp/elisp-react/${name.replace(/[^A-Za-z0-9_.-]+/g, "_")}.el`;
  // Compiled code needs the file to say that it uses lexical binding.
  const source = /^.*lexical-binding:/.test(text) ? text : `;;; -*- lexical-binding: t; -*-\n${text}`;
  const hash = cache ? await sourceHash(`${version}\n${previous}\n${source}`) : null;
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
      return { file, log: stored.log || "", hash };
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
      return { file, log, hash };
    }
    // It does not compile: evaluate it, so that the error is the program's.
    console.warn(`[elisp-react] ${name} could not be byte-compiled; evaluating it instead`);
    await emacs.eval(`${text}\nnil`);
    return { file, log, hash };
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
 *   cache     false: compile every file at every start, and keep nothing
 *             (default true: compiled code is kept in localStorage)
 *   location  "browser": the page's address; "memory": one kept by the host
 *             (the default where the page has none, as in elisp-studio's
 *             preview, about:srcdoc)
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
                              fetch: fetchFunction = (...args) => fetch(...args), timeout = lispTimeout(),
                              location: locationMode = "auto", cache = true } = {}) {
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
  const apply = (answer, what, done = () => {}, failed = () => {}, from = null) => {
    const timer = timeout > 0 && setTimeout(() => {
      if (stopped) return;
      stopped = true;
      host.cancelAll();
      emacs.terminate();
      const error = new Error(`Emacs Lisp did not answer ${what} within ${timeout / 1000} s, and Emacs was stopped; reload the page`);
      error.symbol = "timeout";
      reportError(error);
    }, timeout);
    answer.then((ops) => { clearTimeout(timer); if (!stopped) dom.apply(ops, from); done(); })
      .catch((error) => { clearTimeout(timer); dom.settled(from); if (!stopped) reportError(error); failed(error); });
  };
  // Events are answered in the order they happened: the service works on one
  // request at a time, and each answer is applied before the next arrives.
  const dispatch = (id, name, event, from = null) => {
    if (!stopped) apply(emacs.call("react-dispatch-event", id, name, event), `the ${name} event`, undefined, undefined, from);
  };
  // Lisp hears of a new address after the DOM changes it is part of.
  let started = false;
  const address = createLocation(locationMode, (described) => {
    if (started && !stopped) queueMicrotask(() => apply(emacs.call("react--location-changed", described), "a new address"));
  });
  host = createHost((request, ok, value) => {
    if (!stopped) apply(emacs.call("react-host-reply", request, ok, value), "an answer from the page");
  }, fetchFunction, address);
  dom = createDom(dispatch, host);

  if (!sources) {
    sources = await Promise.all([...document.querySelectorAll('script[type="text/emacs-lisp"]')].map(async (script, index) => (
      script.src ? { name: script.src, text: await fetchText(script.src) }
        : { name: `${location.pathname} inline script ${index + 1}`, text: script.textContent }
    )));
  }
  const [info, libraryText] = await Promise.all([emacs.ready, fetchText(library)]);
  let previous = (await loadLisp(emacs, info.version, new URL(library, location.href).href, libraryText, { cache })).hash;
  await emacs.call("react--storage-load", storedEntries());
  await emacs.call("react--location-set", address.describe());
  started = true;
  // Another tab of this page stored or removed a value: Lisp's copy follows,
  // and the functions watching that key run.
  addEventListener("storage", (event) => {
    const prefix = storagePrefix();
    if (stopped || event.storageArea !== localStorage || !event.key?.startsWith(prefix)) return;
    apply(emacs.call("react--storage-changed", event.key.slice(prefix.length), event.newValue), "a change in another tab");
  });
  const compileLogs = [];
  for (const source of sources) {
    const loaded = await loadLisp(emacs, info.version, source.name, source.text, { previous, cache });
    previous = loaded.hash;
    compileLogs.push({ name: source.name, file: loaded.file, log: loaded.log });
  }
  dom.apply(await emacs.call("react-flush"));
  return {
    emacs, dom, version: info.version, bootMs: info.bootMs, cached: info.cached, files: info.files,
    // Evaluate changed source while the page runs (a development tool).
    // Components that are defined again keep the state of their instances.
    // Resolves with { file, log } (see loadLisp); when the source loaded
    // but the render that follows failed, also with renderError: the new
    // definitions are in place, and the error box says what failed.  A
    // good render clears the error box.
    async load(name, text) {
      // Changed source is compiled and not kept: what is kept is for the
      // files of a start, in their order.
      const { hash: _hash, ...loaded } = await loadLisp(emacs, info.version, name, text, { cache: false });
      try {
        dom.apply(await emacs.call("react-flush"));
      } catch (error) {
        reportError(error);
        return { ...loaded, renderError: error };
      }
      document.querySelector("#elisp-react-error")?.remove();
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
