# elisp-react

React, written in Emacs Lisp.

This is an experiment: can the React of 2013 (components with props and state, render functions that return a virtual DOM, a reconciler) be written in Emacs Lisp and drive a real web page? GNU Emacs 30.2 runs in the page as WebAssembly ([wasmacs](https://github.com/modeverv/wasmacs)); components, state and the reconciler are Emacs Lisp; JavaScript only applies the DOM operations Lisp computes.

Live: <https://modeverv.github.io/elisp-react/>. The first visit of an example downloads Emacs, about 5 MB; it is then kept in the browser, and later visits render in about 0.2 s.

What it comes to:

- **A web page whose program is Emacs Lisp.** Put `.el` files next to an HTML file; there is no build step, no bundler and no Node.js. Edit a file, reload.
- **A whole application in Emacs Lisp.** With a native Emacs as the web server ([Emacs on both ends](#emacs-on-both-ends)), the server, the page and the code they share are all Emacs Lisp, and they exchange Lisp data. The only requirements are Emacs and a browser.
- **A view into your own Emacs.** Started inside the Emacs you use, that server can show its buffers, or anything else Emacs knows, in a page written in the same language.

[日本語](README.ja.md)

## A page

```html
<div id="app">Loading Emacs…</div>
<script type="text/emacs-lisp" src="counter.el"></script>
<script type="module" src="https://modeverv.github.io/elisp-react/js/elisp-react.js"></script>
```

```elisp
;;; counter.el  -*- lexical-binding: t; -*-

(react-define-component 'counter
  :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
  :render
  (lambda (self)
    `(div (:class "counter")
       (p () ,(format "Count: %d" (react-state self :count)))
       (button (:on-click ,(lambda (_event)
                             (react-set-state self :count (1+ (react-state self :count)))))
         "+1"))))

(react-mount '(counter (:start 3)) "#app")
```

There is no build step. The page's `<script type="text/emacs-lisp">` elements (with `src`, or inline) are byte-compiled and run by Emacs in document order; the compiled code is kept in the browser until the source, or a file loaded before it (one of whose macros it may use), or `react.el` changes. A first visit thus compiles in the visitor's browser (about 0.5 s on a fast machine, several seconds on a slow one); a site can compile ahead of time instead, with `node tools/compile.mjs -o compiled.json app.el ...` (in the same Emacs 30.2, under Node, from a wasmacs checkout next to this one) and `<meta name="elisp-react:compiled" content="compiled.json">`: files whose source matches are loaded as they are.

The element above is plain data built with backquote. The `jsx` macro writes the same thing without commas: lists that start with an HTML tag or a Capitalized component name are markup, everything else is Lisp.

```elisp
(react-define-component 'Counter
  :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
  :render
  (lambda (self)
    (jsx (div (:class "counter")
           (p (format "Count: %d" (react-state self :count)))
           (button (:on-click (lambda (_event)
                                (react-set-state self :count (1+ (react-state self :count)))))
             "+1")
           (when (> (react-state self :count) 9) (jsx (strong "a lot")))))))

(react-mount (jsx (Counter (:start 3))) "#app")
```

## Settings

A page that starts by itself takes its settings from `<meta>` elements. A page that starts by hand (`data-elisp-react-manual` on `<html>`) passes them to `start()`:

```html
<html data-elisp-react-manual>
<script type="module">
  import { start } from "https://modeverv.github.io/elisp-react/js/elisp-react.js";
  window.elispReact = { ready: start({ timeout: 10000 }) };
</script>
```

| `start({...})` | `<meta name="...">` | |
|---|---|---|
| `wasmacs` | `elisp-react:wasmacs` | Where the wasmacs eval service is published. |
| `timeout` | `elisp-react:timeout` | Milliseconds Lisp may take to answer an event or an answer from the page (default 30000; 0: no limit). Lisp that takes longer, an endless loop say, cannot be interrupted: Emacs is stopped, the page sends it nothing more, and an error with the symbol `timeout` is reported (`elisp-react:error`, the red box). Long work can give the page back now and then: inside `react-async`, `(react-await (react-sleep 0))` every few hundred items; the limit counts from each such return. |
| `bootTimeout` | `elisp-react:boot-timeout` | Milliseconds the start may take (default 120000; 0: no limit). A start that stalls (a download that never ends) stops Emacs and fails with the symbol `boot-timeout`, saying where it was. `signal`, an `AbortSignal`, aborts a start by hand. |
| `onProgress` | | `({ phase, url, bytes, from })`: how the start goes: `"build id"`, `"download"` of each file Emacs needs that is not in the browser yet, `"emacs"`, then `"lisp"` for each file of the page (`from`: compiled ahead, kept, compiled). The same goes to `document` as the event `elisp-react:progress`, for a "Loading…" line. |
| `location` | | `"browser"`: the page's address. `"memory"`: one the host keeps, starting at `/`, with its own history; hash links are followed there. The default is `"browser"`, and `"memory"` where the page has no address (elisp-studio's preview, `about:srcdoc`). |
| `compiled` | `elisp-react:compiled` | A manifest made by `tools/compile.mjs`: files whose source matches are not compiled in the page. |
| `cache` | | `false`: compile every file at every start and keep nothing (a development tool's "restart"). |
| `library`, `sources`, `fetch` | | `react.el`'s URL; Lisp to load instead of the page's scripts; a function to use instead of `fetch` (for development tools). |

If `elisp-react.js` itself cannot be loaded (no network, a blocked CDN), nothing runs, not even the error box. A page that wants to say so can add a few lines:

```html
<script>
  setTimeout(() => { if (!window.elispReact) document.querySelector("#app").textContent = "This page could not load its script."; }, 20000);
</script>
```

## Emacs on both ends

`examples/server/` is an application without any JavaScript or build step of its own: a native Emacs process is the web server and keeps the data, the Emacs in the browser draws the page, and they exchange printed Lisp data instead of JSON.

```sh
examples/server/run.sh          # or: M-x load-file server.el, M-x elisp-react-server-start
# then open the URL it prints: http://127.0.0.1:8017/examples/server/
```

```text
examples/server/server.el   the server: HTTP in Emacs Lisp (make-network-process), files and a small API
examples/server/app.el      the page: components that ask the server with react-fetch / react-async
examples/server/notes.el    loaded by both: the functions that change the list, and the check of a note's text
```

What the example shows:

- **No build, no JavaScript of your own.** The three `.el` files are the application. The browser compiles them when it loads them and keeps the result.
- **One language, one data format.** No JSON mapping between the two sides: a plist printed on one side is the same plist after `read` on the other.
- **Shared code.** `notes.el` runs on both sides: the server uses its functions to change the list, the page uses its check to enable the button, the server uses the same check to refuse.
- **Two tabs stay in step.** The page asks again every two seconds, so a change made elsewhere (another tab, `curl`) appears.

A request body is an action such as `(add "text")`; the server `read`s it as data (it evaluates nothing it is sent), applies it with the shared function, saves the list as an `.eld` file and answers with the new list, which the page `read`s into its state. The server listens on 127.0.0.1 only and refuses requests made by pages of other sites. Run inside the Emacs you are using, `/api/buffers` and friends can show that Emacs's own state to a page.

Saved notes, their backups, the example's `data/` directory, and hidden files are excluded from static serving, including symlink and case aliases. Application files use the same origin check as the API; only public files under the separate `/wasmacs/` mount allow cross-origin asset loading.

It is an example, not a server for an application: no sign-in, no cookies or sessions, no uploads; a request body of 64 KB at most; one request per connection; no limit on connections and no timeouts; a file is read into memory whole to be sent. It does keep to its own machine: a request under another `Host`, or to `/api/` from a page of another site, is refused; a body is read without its names staying in Emacs; a file name in a request is a file under the served directory or nothing (three fixes that came out of [elisp-studio's security check](https://github.com/modeverv/elisp-studio/blob/main/doc/security.md)). A fourth came out of its second check: a visitor who hung up in the middle of an answer ended the server, because an Emacs in batch mode dies of SIGPIPE; `run.sh` now starts Emacs with that signal ignored, so start the server with it. The server with sessions, password hashes, uploads, limits and a reverse proxy in front is the project server of [elisp-studio](https://github.com/modeverv/elisp-studio).

## What is where

```text
lisp/react.el          React: elements, jsx, components, state, keyed reconciler, timers, fetch, storage, async/await (910 lines of Emacs Lisp)
js/elisp-react.js      the host: starts Emacs, applies DOM operations, forwards events, answers requests, compiles and caches the Lisp (350 lines)
examples/counter/      a component with state
examples/counters/     state in a parent, props down, events up, a list, a controlled input
examples/todo/         a TODO list: jsx, keyed rows with state of their own, filters, reordering, localStorage
examples/async/        an interval, a timeout, a countdown and a fetch written with async/await
examples/server/       Emacs on both ends: a native Emacs is the web server and keeps the data
test/react-test.el     tests of the reconciler with a native Emacs, no browser
test/e2e.mjs           the examples in headless Chrome
test/e2e-host.mjs      what the host does for Lisp (test/pages/), in headless Chrome
doc/design.md          how it works
doc/experiment-notes.md  what the experiment shows so far (Japanese)
```

## API

An element is plain Lisp data: `"text"`, `(TAG PROPS CHILD...)` or `(TAG CHILD...)`. `PROPS` is a plist. Among the children `nil` is skipped and a list of elements (the value of `mapcar`) is spliced in.

| | |
|---|---|
| `(react-define-component NAME :render F :initial-state F :did-mount F :did-update F :will-unmount F)` | Define a component. `:render` gets the instance and returns one element. An element `(NAME PROPS CHILD...)` renders it; its children arrive as the prop `:children`. `:did-update` gets the instance, the previous props and the previous state. |
| `:did-catch (lambda (self error) ...)` | An error boundary: a component below failed to render. That component renders nothing, and this one usually sets state to show something else. Without a boundary the error reaches the page as `react-render-error`, which names the component and those above it (`Card < Page < App`); what was waiting to render renders at the next event. |
| `(react-effect SELF KEY DEPS F)` | In a render: run `F` after the render when `DEPS` (any data, compared with `equal`) changed since it last ran; a function that `F` returns cleans up before the next run and when the component is taken off. Stateful logic becomes an ordinary function that several components call. `:did-mount`, `:did-update` and `:will-unmount` also take a list of functions. |
| `(react-props SELF [KEY])`, `(react-state SELF [KEY])` | The props or the state (plists) of an instance, or one value. |
| `(react-set-state SELF :key VALUE ...)` | Install a new state plist with these keys changed and render again. Also takes one function from the old state to the changes. Several calls during one event cause one render. |
| `(react-mount ELEMENT SELECTOR)` | Render into the page element the CSS selector names. |
| `(jsx MARKUP)` | Build an element without backquote. `(TAG ...)` with an HTML or SVG tag, or `(Component ...)` with a Capitalized name, is markup; elements inside `(svg ...)` are created as SVG (inline charts and icons); prop values, children and everything else are evaluated as Lisp. Markup inside such Lisp needs `jsx` again. |
| `(react-provide KEY VALUE CHILD)`, `(react-context SELF KEY [DEFAULT])` | Hand `VALUE` to every component below `CHILD` under `KEY`, however deep, without props in between (the language, the signed-in user). A component reads it with `react-context` and renders again when it changes, even if it or a component above it is `:pure`. |
| `(react-force-update SELF)`, `(react-refresh [TYPE])` | Render one instance, or every mounted one (of a component `TYPE`), again, past `:should-update`: after data they read outside props and state changed. |
| `(react-render-to-string ELEMENT)` | `ELEMENT` as HTML text, without a page: a server's first screen for crawlers, link previews and a fast first paint, in a native Emacs too. Components render with their initial state; nothing runs after the render and nothing stays mounted; text and attributes are escaped. (The page then mounts over it: there is no hydration.) |
| `(react-plist-with PLIST :key VALUE ...)` | A new plist with these keys set; `PLIST` is not modified. For records in the state. |

Lisp runs only while it answers the page: it cannot wait and cannot reach into the page. A component asks the page instead, and the page calls the Lisp function when there is an answer. Such a function usually ends in `react-set-state`.

| | |
|---|---|
| `(react-set-timeout MS F)`, `(react-set-interval MS F)`, `(react-clear-timer TIMER)` | Call `F` later, once or repeatedly. Start an interval in `:did-mount`, clear it in `:will-unmount`. |
| `(react-fetch URL :method :headers :body :then F :catch F)`, `(react-response-json RESPONSE)`, `(react-cancel REQUEST)` | The browser's `fetch`. `:then` gets a plist `(:status 200 :ok t :url "..." :redirected nil :headers (:content-type "..." ...) :text "...")`, also for HTTP error statuses; `:catch` gets a message when there was no response. With `:file (react-ref SELF NAME)` instead of `:body`, the body is the file the visitor chose in that file input: it goes from the page to the server as it is, whatever its size, without passing through Lisp. `:form (list NAME VALUE ...)` sends `multipart/form-data`; a value is a string or a ref to a file input, whose files are sent. `:credentials`, `:cache`, `:redirect`, `:mode`, `:keepalive`, `:priority` and `:referrerPolicy` go to `fetch` as they are. |
| `(react-response-header RESPONSE NAME)`, `:as 'base64` and `(react-response-bytes RESPONSE)` | A header of the response (any case). With `:as 'base64` the body arrives as `:base64` instead of `:text`, and `react-response-bytes` makes it a unibyte string: images, archives, any bytes. (Without it the body is decoded as UTF-8 text, and bytes that are not UTF-8 are lost.) |
| `(react-listen-page TARGET EVENT F :keys KEYS :prevent t :throttle MS)` | Events of the `window` or the `document`: keys pressed anywhere, `resize`, `scroll`, `visibilitychange`. `F` gets `(:type :key :width :height :x :y :visibility)`. `:keys` takes only those keys, `:prevent` keeps the browser from acting on them (a `/` shortcut), `:throttle` sends one event per `MS` at most. `react-cancel` removes it. |
| `(react-media-query QUERY F)`, `(react-observe-visible SELF "name" F :margin M :threshold T)` | `F` gets whether a CSS media query matches (`"(prefers-color-scheme: dark)"`), at once and at each change; or whether the element with that `:ref` is in view, and how much of it (an `IntersectionObserver`: "load more" at the end of a list). `react-cancel` stops them. |
| `(react-location [PART])`, `(react-location-watch F)`, `(react-location-unwatch HANDLE)` | The page's address, `(:href :pathname :search :hash)`, known from the start. `F` gets the new one after a link, Back or Forward, or `react-navigate`. |
| `(react-navigate URL [REPLACE])`, `(react-history-go DELTA)` | A new history entry (or, with `REPLACE`, the current one changed): within the page's origin the page stays and the watchers run; another origin is loaded. `DELTA` -1 is Back. |
| `(react-set-title TEXT)`, `(react-set-meta NAME CONTENT)` | The document's title; a `<meta>` (`"description"`, or `"og:title"` and the other properties), removed with `nil`. |
| `(react-url-query SEARCH)` | A query string as an alist, escapes read as UTF-8: `(react-url-query (react-location :search))`. |
| `(react-websocket URL :on-open F :on-message F :on-close F :on-error F)`, `(react-websocket-send CONNECTION TEXT)` | A WebSocket (`ws:`, `wss:`, or a path of this site). `:on-message` gets each text message, `:on-close` the code and the reason. `react-cancel` closes it: do that in `:will-unmount`. |
| `(react-event-source URL :on-message F :events NAMES :on-open F :on-error F :on-close F)` | Server-sent events. `:on-message` gets `(:type "message" :data "..." :id ...)`, also for the named events listed in `:events`. The browser reconnects by itself; `:on-close` means it gave up. `react-cancel` closes it. |
| `(react-storage-get KEY [DEFAULT])`, `(react-storage-set KEY VALUE)`, `(react-storage-remove KEY)` | The page's `localStorage`, holding any printable Lisp data. Reading is immediate: the host hands Lisp a copy at the start. `react-storage-set` replaces the value, also what another tab of the page stored meanwhile. |
| `(react-storage-watch KEY F)`, `(react-storage-unwatch HANDLE)` | Another tab of the page changed `KEY`: Lisp's copy has the new value, and `F` gets it (nil when it was removed). Merge before writing when tabs share a list, or render again. |
| `:ref "name"` on an element, `(react-focus SELF "name")`, `(react-invoke SELF "name" METHOD ARGS...)` | Call a method on the DOM node of an element the component rendered, after the render's DOM changes (use it in `:did-update` or `:did-mount`): `focus`, `blur`, `select`, `click`, `scrollIntoView`, `scrollTo`, `scrollBy`, `setSelectionRange`, `showModal`, `show`, `close`, `requestSubmit`, `reset`, `reportValidity`, `setCustomValidity`, `play`, `pause`, `load`, `requestFullscreen`, `showPicker`. Arguments are JSON data: `(react-invoke self "list" "scrollTo" '(:top 0))`. |
| `(react-make-ref SELF "name")`, `(react-root SELECTOR)` | A ref that a component hands down to put on an element a component below renders: `(input (:ref (react-props self :input-ref)))` makes it the parent's ref `"name"`. The component instance `react-mount` rendered into `SELECTOR`, for code outside the components. |
| `(react-set-property SELF "name" PROPERTY VALUE)`, `(react-measure SELF "name" F)` | Set a DOM property that is not an attribute: `indeterminate`, `selectedIndex`, `open`, `muted`, `volume`, `currentTime`, `playbackRate`, `loop`, `scrollTop`, `scrollLeft` (nothing that takes markup). Measure a node: `F` gets its box `(:x :y :width :height)`, its scrolling (`:scrollTop` ... `:clientHeight`) and, for audio and video, `:currentTime :duration :paused`. |

What the host cannot do, the page's own script can, and the two can talk:

```html
<script>
  // Commands Lisp can call: (react-host-call "width" ID FUNCTION) and (react-host-tell "set-title" TEXT).
  window.elispReactCommands = {
    width(id, { reply, node }) { reply(node(id).getBoundingClientRect().width); },
    "set-title"(text) { document.title = text; },
  };
  // A Lisp function the script calls; the page shows what it changed when the promise resolves.
  document.addEventListener("elisp-react:ready", () => window.elispReact.send("my-app-resized", innerWidth));
</script>
```

| | |
|---|---|
| `window.elispReactCommands[NAME] = (ARGUMENT, { reply, fail, node }) => CANCEL` | A command of the page. `reply(VALUE)` answers Lisp (again and again if Lisp kept the request), `fail(MESSAGE)` answers with a failure, `node(ID)` is the DOM node Lisp knows by `ID`; a returned function is called by `react-cancel`. A notice gets `(ARGUMENT, { node })`. |
| `(react-host-call NAME ARGUMENT FUNCTION [KEEP])`, `(react-host-tell NAME ARGUMENT)`, `(react-node-id (react-ref SELF "name"))` | Call such a command (`FUNCTION` gets `OK` and the value), or tell it without an answer. `react-node-id` names a node for `node(ID)`. |
| `window.elispReact.send(NAME, ...ARGS)` | Call the Lisp function `NAME` with `ARGS` (JSON data) and render what it changed; resolves when the page is updated. |

Signing in, as far as the page is concerned (tried on 2026-11-15 from Chrome against elisp-studio's project server, a session cookie and a bearer token in one page):

- **Cookies need nothing.** `react-fetch` is the browser's `fetch` with its defaults: a request to the page's own server carries that server's cookies and takes new ones from the answer. A session cookie that is `HttpOnly` never shows up in Lisp. A request to another origin carries no cookies unless it says `:credentials "include"`, and is subject to that server's CORS rules.
- **A token is a header.** `:headers (:authorization "Bearer …")` sends one (a JWT, for instance). The page then has to keep it: in a component's state, where a reload loses it, or with `react-storage-set`, which is `localStorage`: it stays, and every script of the page can read it. The cookie is the safer place.
- **An answer is its status, its headers and its body.** `react-response-header` reads a header (`Link`, `Retry-After`, `ETag`); headers that CORS does not expose to the page stay hidden from Lisp too.
- **Checking is the server's.** The page's Emacs has `secure-hash` and no other cryptography ([wasmacs, doc/eval-service.md](https://github.com/modeverv/wasmacs/blob/master/doc/eval-service.md#hashes-random-bytes-sockets)). It can read what a token says (`base64-decode-string`, `json-parse-string`), but whatever a page checks, its visitor can change.

The same asynchronous code can be written top to bottom. `react-async` runs its body until the first `react-await`, returns to the page, and continues when the page answers (it is built on Emacs's `generator.el`):

```elisp
(react-async
  (react-set-state self :status 'loading)
  (condition-case failure
      (let ((response (react-await (react-fetch-async "quotes.json"))))
        (react-await (react-sleep 300))
        (react-set-state self :status 'loaded :quotes (react-response-json response)))
    (react-async-error (react-set-state self :status 'failed :error (cadr failure)))))
```

| | |
|---|---|
| `(react-async BODY...)`, `(react-await AWAITABLE)` | Loops and conditionals may contain awaits. A failed operation signals `react-async-error` at the await. Read state again after an await: it may have changed. `react-async` returns a task, which is awaitable: its value is the body's. An await inside a `lambda`, `with-temp-buffer`, `save-excursion`, `mapcar` and the like is an error when the body is compiled (generator.el does not reach into them), and a closure made in a loop that awaits needs its own binding: `(let ((item item)) (lambda () item))`. |
| `(react-task-cancel TASK)` | Stop a task: the request it waits for is cancelled, it never goes on, and those who await it get `react-async-error` ("cancelled"). A component stops its tasks when it is taken off with `react-effect`: `(react-effect self 'load (react-props self :id) (lambda () (let ((task (react-async ...))) (lambda () (react-task-cancel task)))))`. |
| `(react-all AWAITABLES)`, `(react-race AWAITABLES)` | Awaitables over several (functions or tasks): all the values in order, failing as soon as one fails; or the first answer. |
| `(react-sleep MS)`, `(react-fetch-async URL OPTIONS...)` (those of `react-fetch` but `:then` and `:catch`) | Awaitables. Any function of `(RESOLVE REJECT)` that calls one of them once is an awaitable. |

Data that several components or several visits of a page read is kept by key:

| | |
|---|---|
| `(react-query SELF KEY LOADER :stale-ms MS)` | In a render: the data under `KEY` (any Lisp data, compared with `equal`), loaded by `LOADER`, a function that returns an awaitable (`(lambda () (react-fetch-async "/videos.json"))`). Returns `(:status STATUS :data DATA :error ERROR :fetching BOOL)`, `STATUS` being `loading`, `success` or `error`. Components that ask for one key share its request and its data; a component that comes back shows the data at once, and a key older than `:stale-ms` (default 0) is loaded again in the background. The component renders again when the data arrives, `:pure` or not. |
| `(react-invalidate PREFIX)`, `(react-query-set KEY DATA)`, `(react-query-data KEY)` | Make every key that is `PREFIX`, or a list that starts with the list `PREFIX`, stale: it is loaded again, and an answer on its way is dropped. Put data under a key by hand (an optimistic update). Read a key without depending on it. |

By default a component renders again whenever its parent does. A component can decline:

| | |
|---|---|
| `:should-update (lambda (self previous-props previous-state) ...)` | Return nil to skip the render of this component and everything below it. `self` has the new props and state. |
| `:pure t` | Render only when a prop or the state changed: strings and numbers by value, everything else (records, lists, functions) by identity. |
| `(react-changed-p NEW OLD :key ...)`, `(react-shallow-equal A B)` | For `:should-update`: compare selected keys of two plists, or all of them. |

A custom element is written with a Capitalized name that has a hyphen, `(X-widget (:size "2"))`: no component has that name, so it becomes `<x-widget>`. A Capitalized name without a hyphen that is no component is most likely misspelled, or its file is loaded after the one that uses it: it still renders as an unknown element, and the page's console says so, once. Props that are computed (passed on from a parent, say) go in the plain-list form, which `jsx` children may be: `(list 'button (append '(:class "primary") (react-props self :button-props)) "OK")`.

A `lambda` in a render function is a new object at every render, but `:pure` takes two closures of the same `lambda` for the same function when the values they captured are the same (compared one level deep): `(VideoCard (:on-pick (lambda (_event) (pick video))))` skips its render as long as `video` is the same object. A closure that captures something new at every render (a list built in the render) still defeats it; then compare the data props with `react-changed-p`, and let handlers read function props when the event happens (`(funcall (react-props self :on-change) ...)`): a skipped component still receives its new props.

Children of a list that changes get a `:key`: `(li (:key id) ...)`. A child with the same key as before is the same child: it keeps its DOM node, and the components in it keep their state, wherever it now stands in the list. The reconciler moves as few nodes as possible. Children without a key are matched by position.

Props of DOM elements: `:on-click`, `:on-input`, `:on-submit`, ... are listeners (the function gets a plist `:type :value :checked :key :code :alt :ctrl :meta :shift :repeat :composing :button :x :y :target`: `:composing` is t while an input method is still converting, `:target` the number of the node where the event happened; for a file input `:files`, a vector of `(:name :size :type)`; for a submit `:form`, the form's fields, read with `(react-form-value EVENT NAME)` and `react-form-values`); `:value` and `:checked` are DOM properties, so inputs are controlled; `:style` is a string or a plist, whose numbers are pixels unless the property has no unit (`(:width 120 :opacity 0.5)`); `:class` may be a list (`'("card" nil "active")` gives `card active`); an `:aria-...` attribute that is `t` or `:false` reads `"true"` or `"false"`; `:inner-html` is HTML text from elsewhere (a description, Markdown made HTML), which the host cleans before it shows it: elements outside a list of text and table elements are taken out (their text stays), scripts, styles, frames, forms and SVG are dropped, and only plain attributes without script URLs are kept; such an element has no children of its own; everything else is an attribute (`nil` removes it, `t` sets it empty). The host omits inline `on*` attributes and `srcdoc`, and removes script URLs in URL attributes, while continuing the render. Use Lisp `:on-...` callbacks. Page-authored Lisp and deliberately created script elements remain trusted code; see [the DOM boundary](doc/design.md#operations).

Lisp answers an event after the browser has acted on it, too late to stop a link or a key. A listener that says beforehand what the page should do is a `react-handler`:

```elisp
(input (:on-keydown (react-handler #'search :keys '("Enter") :prevent t)))
(div (:class "backdrop" :on-click (react-handler #'close-dialog :self t)) ...)
```

`:keys` (only these keys), `:self` (only events of the element itself, not of its children), `:prevent` (`preventDefault`), `:stop` (`stopPropagation`: the parents' listeners do not hear it), `:capture`, `:passive`, and `:throttle MS` (one event per `MS` at most, the last one kept).

## Changing a running page

A component that is defined again while it is on the page takes the new definition and renders again with the state its instances have. The host exposes this as `window.elispReact.load(name, text)`, which compiles and evaluates changed source in the running page. When the source loaded but the render that follows failed, it resolves with `renderError` as well: the new definitions are in place. A good render clears the error box. [elisp-studio](https://github.com/modeverv/elisp-studio) builds on it: Emacs in the browser edits the files, and the application next to it changes at every save, without a reload.

[![elisp-studio: a stopwatch keeps running while it is edited in Emacs](https://raw.githubusercontent.com/modeverv/elisp-studio/main/doc/images/demo.gif)](https://github.com/modeverv/elisp-studio)

## Development

```sh
npm run serve        # http://localhost:5180/examples/counter/
npm run test:lisp    # the reconciler, with a native Emacs
npm run test:e2e     # the examples in headless Chrome
npm run test:e2e-host  # the host's features (test/pages/) in headless Chrome
npm run test:server  # the server example: an Emacs server process and Chrome
```

With a wasmacs checkout next to this one (`../wasmacs/docs`), the server and the browser test load Emacs from there; otherwise from the public wasmacs site.

## Limits

This is an experiment, not a framework. A handler that never returns cannot be interrupted (after the [timeout](#settings) Emacs is stopped and the page says so), an `async` body cannot be cancelled, and Emacs is a 5 MB download on the first visit (Emacs itself; of its 146 MB of Lisp files a page fetches the few it reads, a library it requires later when it requires it). A render of 1000 keyed rows takes about 130 ms, about 30 ms when the rows are `:pure`. Emacs costs memory in every tab: it reserves 1 GiB of linear memory at start (2 GiB at most), and a page such as [Parens](https://github.com/modeverv/elisp-react-youtube-similar) took 265–335 MB of renderer memory in desktop Chrome, against 136 MB for the same page saved without Emacs. No real phone has been tried ([wasmacs#12](https://github.com/modeverv/wasmacs/issues/12)). The server of `examples/server/` belongs to the example and is not one to publish ("Emacs on both ends" says what it lacks). See [doc/experiment-notes.md](doc/experiment-notes.md).

## Licence

MIT ([LICENSE](LICENSE)): keep the notice, and do what you want. The examples under `examples/` are starting points and ask for nothing at all ([0BSD](examples/LICENSE)): take them into an application of your own without a notice.

`react.el` is Emacs Lisp and runs inside GNU Emacs, which is under the GNU GPL, version 3 or later. The GPL asks that [code combined with a GPL program](https://www.gnu.org/licenses/gpl-faq.html#GPLAndPlugins) be under a GPL-compatible licence, and MIT is one (the FSF lists it as the [Expat licence](https://www.gnu.org/licenses/license-list.html#Expat)).

- **Nothing of Emacs is in this repository.** A page downloads it from the [wasmacs](https://github.com/modeverv/wasmacs) site. wasmacs's [NOTICE.md](https://github.com/modeverv/wasmacs/blob/master/NOTICE.md) says under which licences that build comes and where its source is.
- **A site that keeps its own copy of that Emacs** distributes it under the GPL, and should keep wasmacs's `licenses/` directory next to the copy.
- **Your own `.el` files** run inside Emacs as well and use its Lisp libraries. By the FSF's reading of the GPL, [a program that uses such libraries](https://www.gnu.org/licenses/gpl-faq.html#IfInterpreterIsGPL) is to be published under a GPL-compatible licence. A page's `app.el` is sent to every visitor, which is publishing it; MIT, 0BSD and the GPL itself all fit.

elisp-react is not affiliated with Meta's React and contains none of its code.
