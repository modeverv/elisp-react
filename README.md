# elisp-react

React, written in Emacs Lisp.

This is an experiment: can the React of 2013 (components with props and state, render functions that return a virtual DOM, a reconciler) be written in Emacs Lisp and drive a real web page? GNU Emacs 30.2 runs in the page as WebAssembly ([wasmacs](https://github.com/modeverv/wasmacs)); components, state and the reconciler are Emacs Lisp; JavaScript only applies the DOM operations Lisp computes.

Live: <https://modeverv.github.io/elisp-react/>. The first visit of an example downloads Emacs, about 150 MB; it is then kept in the browser, and later visits render in about 0.2 s.

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

## What is where

```text
lisp/react.el          React: elements, jsx, components, state, keyed reconciler, timers, fetch, storage, async/await (910 lines of Emacs Lisp)
js/elisp-react.js      the host: starts Emacs, applies DOM operations, forwards events, answers requests, compiles and caches the Lisp (350 lines)
examples/counter/      a component with state
examples/counters/     state in a parent, props down, events up, a list, a controlled input
examples/todo/         a TODO list: jsx, keyed rows with state of their own, filters, reordering, localStorage
examples/async/        an interval, a timeout, a countdown and a fetch written with async/await
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
| `(react-fetch URL :method :headers :body :then F :catch F)`, `(react-response-json RESPONSE)`, `(react-cancel REQUEST)` | The browser's `fetch`. `:then` gets a plist `(:status 200 :ok t :text "...")`, also for HTTP error statuses; `:catch` gets a message when there was no response. |
| `(react-storage-get KEY [DEFAULT])`, `(react-storage-set KEY VALUE)`, `(react-storage-remove KEY)` | The page's `localStorage`, holding any printable Lisp data. Reading is immediate. |
| `:ref "name"` on an element, `(react-focus SELF "name")`, `(react-invoke SELF "name" METHOD)` | Call `focus`, `blur`, `select`, `click` or `scrollIntoView` on the DOM node of an element the component rendered, after the render's DOM changes (use it in `:did-update` or `:did-mount`). |

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

Props of DOM elements: `:on-click`, `:on-input`, `:on-submit`, ... are listeners (the function gets a plist `:type :value :checked :key`); `:value` and `:checked` are DOM properties, so inputs are controlled; `:style` is a string or a plist; everything else is an attribute (`nil` removes it, `t` sets it empty).

## Development

```sh
npm run serve        # http://localhost:5180/examples/counter/
npm run test:lisp    # the reconciler, with a native Emacs
npm run test:e2e     # the examples in headless Chrome
```

With a wasmacs checkout next to this one (`../wasmacs/docs`), the server and the browser test load Emacs from there; otherwise from the public wasmacs site.

## Limits

This is an experiment, not a framework. A handler that never returns cannot be interrupted, an `async` body cannot be cancelled, and Emacs is a 150 MB download on the first visit. A render of 1000 keyed rows takes about 130 ms, about 30 ms when the rows are `:pure`. See [doc/experiment-notes.md](doc/experiment-notes.md).
