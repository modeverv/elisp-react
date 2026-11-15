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

There is no build step. The page's `<script type="text/emacs-lisp">` elements (with `src`, or inline) are byte-compiled and run by Emacs in document order; the compiled code is kept in the browser until the source changes.

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
doc/design.md          how it works
doc/experiment-notes.md  what the experiment shows so far (Japanese)
```

## API

An element is plain Lisp data: `"text"`, `(TAG PROPS CHILD...)` or `(TAG CHILD...)`. `PROPS` is a plist. Among the children `nil` is skipped and a list of elements (the value of `mapcar`) is spliced in.

| | |
|---|---|
| `(react-define-component NAME :render F :initial-state F :did-mount F :did-update F :will-unmount F)` | Define a component. `:render` gets the instance and returns one element. An element `(NAME PROPS CHILD...)` renders it; its children arrive as the prop `:children`. `:did-update` gets the instance, the previous props and the previous state. |
| `(react-props SELF [KEY])`, `(react-state SELF [KEY])` | The props or the state (plists) of an instance, or one value. |
| `(react-set-state SELF :key VALUE ...)` | Install a new state plist with these keys changed and render again. Also takes one function from the old state to the changes. Several calls during one event cause one render. |
| `(react-mount ELEMENT SELECTOR)` | Render into the page element the CSS selector names. |
| `(jsx MARKUP)` | Build an element without backquote. `(TAG ...)` with an HTML tag, or `(Component ...)` with a Capitalized name, is markup; prop values, children and everything else are evaluated as Lisp. Markup inside such Lisp needs `jsx` again. |
| `(react-plist-with PLIST :key VALUE ...)` | A new plist with these keys set; `PLIST` is not modified. For records in the state. |

Lisp runs only while it answers the page: it cannot wait and cannot reach into the page. A component asks the page instead, and the page calls the Lisp function when there is an answer. Such a function usually ends in `react-set-state`.

| | |
|---|---|
| `(react-set-timeout MS F)`, `(react-set-interval MS F)`, `(react-clear-timer TIMER)` | Call `F` later, once or repeatedly. Start an interval in `:did-mount`, clear it in `:will-unmount`. |
| `(react-fetch URL :method :headers :body :then F :catch F)`, `(react-response-json RESPONSE)`, `(react-cancel REQUEST)` | The browser's `fetch`. `:then` gets a plist `(:status 200 :ok t :text "...")`, also for HTTP error statuses; `:catch` gets a message when there was no response. With `:file (react-ref SELF NAME)` instead of `:body`, the body is the file the visitor chose in that file input: it goes from the page to the server as it is, whatever its size, without passing through Lisp. |
| `(react-storage-get KEY [DEFAULT])`, `(react-storage-set KEY VALUE)`, `(react-storage-remove KEY)` | The page's `localStorage`, holding any printable Lisp data. Reading is immediate. |
| `:ref "name"` on an element, `(react-focus SELF "name")`, `(react-invoke SELF "name" METHOD)` | Call `focus`, `blur`, `select`, `click` or `scrollIntoView` on the DOM node of an element the component rendered, after the render's DOM changes (use it in `:did-update` or `:did-mount`). |

Signing in, as far as the page is concerned (tried on 2026-11-15 from Chrome against elisp-studio's project server, a session cookie and a bearer token in one page):

- **Cookies need nothing.** `react-fetch` is the browser's `fetch` with its defaults: a request to the page's own server carries that server's cookies and takes new ones from the answer. A session cookie that is `HttpOnly` never shows up in Lisp. A request to another origin carries no cookies and is subject to that server's CORS rules.
- **A token is a header.** `:headers (:authorization "Bearer …")` sends one (a JWT, for instance). The page then has to keep it: in a component's state, where a reload loses it, or with `react-storage-set`, which is `localStorage`: it stays, and every script of the page can read it. The cookie is the safer place.
- **An answer is its status and its text.** Lisp does not get the headers of a response, so a server that hands out a token puts it in the body.
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
| `(react-async BODY...)`, `(react-await AWAITABLE)` | Loops and conditionals may contain awaits. A failed operation signals `react-async-error` at the await. Read state again after an await: it may have changed. |
| `(react-sleep MS)`, `(react-fetch-async URL :method :headers :body)` | Awaitables. Any function of `(RESOLVE REJECT)` that calls one of them once is an awaitable. |

By default a component renders again whenever its parent does. A component can decline:

| | |
|---|---|
| `:should-update (lambda (self previous-props previous-state) ...)` | Return nil to skip the render of this component and everything below it. `self` has the new props and state. |
| `:pure t` | Render only when a prop or the state changed: strings and numbers by value, everything else (records, lists, functions) by identity. |
| `(react-changed-p NEW OLD :key ...)`, `(react-shallow-equal A B)` | For `:should-update`: compare selected keys of two plists, or all of them. |

A `lambda` in a render function is a new object at every render, so a function prop defeats `:pure`. Compare the data props with `react-changed-p` instead, and let handlers read function props when the event happens (`(funcall (react-props self :on-change) ...)`): a skipped component still receives its new props.

Children of a list that changes get a `:key`: `(li (:key id) ...)`. A child with the same key as before is the same child: it keeps its DOM node, and the components in it keep their state, wherever it now stands in the list. The reconciler moves as few nodes as possible. Children without a key are matched by position.

Props of DOM elements: `:on-click`, `:on-input`, `:on-submit`, ... are listeners (the function gets a plist `:type :value :checked :key`, and for a file input `:files`, a vector of `(:name :size :type)`); `:value` and `:checked` are DOM properties, so inputs are controlled; `:style` is a string or a plist; everything else is an attribute (`nil` removes it, `t` sets it empty). The host omits inline `on*` attributes and `srcdoc`, and removes script URLs in URL attributes, while continuing the render. Use Lisp `:on-...` callbacks. Page-authored Lisp and deliberately created script elements remain trusted code; see [the DOM boundary](doc/design.md#operations).

## Changing a running page

A component that is defined again while it is on the page takes the new definition and renders again with the state its instances have. The host exposes this as `window.elispReact.load(name, text)`, which compiles and evaluates changed source in the running page. [elisp-studio](https://github.com/modeverv/elisp-studio) builds on it: Emacs in the browser edits the files, and the application next to it changes at every save, without a reload.

[![elisp-studio: a stopwatch keeps running while it is edited in Emacs](https://raw.githubusercontent.com/modeverv/elisp-studio/main/doc/images/demo.gif)](https://github.com/modeverv/elisp-studio)

## Development

```sh
npm run serve        # http://localhost:5180/examples/counter/
npm run test:lisp    # the reconciler, with a native Emacs
npm run test:e2e     # the examples in headless Chrome
npm run test:server  # the server example: an Emacs server process and Chrome
```

With a wasmacs checkout next to this one (`../wasmacs/docs`), the server and the browser test load Emacs from there; otherwise from the public wasmacs site.

## Limits

This is an experiment, not a framework. A handler that never returns cannot be interrupted, an `async` body cannot be cancelled, and Emacs is a 5 MB download on the first visit (Emacs itself; of its 146 MB of Lisp files a page fetches the few it reads, a library it requires later when it requires it). A render of 1000 keyed rows takes about 130 ms, about 30 ms when the rows are `:pure`. Emacs costs memory in every tab: it reserves 1 GiB of linear memory at start (2 GiB at most), and a page such as [Parens](https://github.com/modeverv/elisp-react-youtube-similar) took 265–335 MB of renderer memory in desktop Chrome, against 136 MB for the same page saved without Emacs. No real phone has been tried ([wasmacs#12](https://github.com/modeverv/wasmacs/issues/12)). The server of `examples/server/` belongs to the example and is not one to publish ("Emacs on both ends" says what it lacks). See [doc/experiment-notes.md](doc/experiment-notes.md).

## Licence

MIT ([LICENSE](LICENSE)): keep the notice, and do what you want. The examples under `examples/` are starting points and ask for nothing at all ([0BSD](examples/LICENSE)): take them into an application of your own without a notice.

`react.el` is Emacs Lisp and runs inside GNU Emacs, which is under the GNU GPL, version 3 or later. The GPL asks that [code combined with a GPL program](https://www.gnu.org/licenses/gpl-faq.html#GPLAndPlugins) be under a GPL-compatible licence, and MIT is one (the FSF lists it as the [Expat licence](https://www.gnu.org/licenses/license-list.html#Expat)).

- **Nothing of Emacs is in this repository.** A page downloads it from the [wasmacs](https://github.com/modeverv/wasmacs) site. wasmacs's [NOTICE.md](https://github.com/modeverv/wasmacs/blob/master/NOTICE.md) says under which licences that build comes and where its source is.
- **A site that keeps its own copy of that Emacs** distributes it under the GPL, and should keep wasmacs's `licenses/` directory next to the copy.
- **Your own `.el` files** run inside Emacs as well and use its Lisp libraries. By the FSF's reading of the GPL, [a program that uses such libraries](https://www.gnu.org/licenses/gpl-faq.html#IfInterpreterIsGPL) is to be published under a GPL-compatible licence. A page's `app.el` is sent to every visitor, which is publishing it; MIT, 0BSD and the GPL itself all fit.

elisp-react is not affiliated with Meta's React and contains none of its code.
