# elisp-react

React, written in Emacs Lisp.

This is an experiment: can the React of 2013 (components with props and state, render functions that return a virtual DOM, a reconciler) be written in Emacs Lisp and drive a real web page? GNU Emacs 30.2 runs in the page as WebAssembly ([wasmacs](https://github.com/modeverv/wasmacs)); components, state and the reconciler are Emacs Lisp; JavaScript only applies the DOM operations Lisp computes.

Live: <https://modeverv.github.io/elisp-react/> (the first visit of an example downloads Emacs, about 150 MB).

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

There is no build step. The page's `<script type="text/emacs-lisp">` elements (with `src`, or inline) are evaluated by Emacs in document order.

## What is where

```text
lisp/react.el          React: elements, components, state, reconciler (450 lines of Emacs Lisp)
js/elisp-react.js      the host: starts Emacs, applies DOM operations, forwards events (210 lines)
examples/counter/      a component with state
examples/counters/     state in a parent, props down, events up, a list, a controlled input
test/react-test.el     tests of the reconciler with a native Emacs, no browser
test/e2e.mjs           the examples in headless Chrome
doc/design.md          how it works
doc/experiment-notes.md  what the experiment shows so far (Japanese)
```

## API

An element is plain Lisp data: `"text"`, `(TAG PROPS CHILD...)` or `(TAG CHILD...)`. `PROPS` is a plist. Among the children `nil` is skipped and a list of elements (the value of `mapcar`) is spliced in.

| | |
|---|---|
| `(react-define-component NAME :render F :initial-state F :did-mount F :will-unmount F)` | Define a component. `:render` gets the instance and returns one element. An element `(NAME PROPS CHILD...)` renders it; its children arrive as the prop `:children`. |
| `(react-props SELF [KEY])`, `(react-state SELF [KEY])` | The props or the state (plists) of an instance, or one value. |
| `(react-set-state SELF :key VALUE ...)` | Install a new state plist with these keys changed and render again. Also takes one function from the old state to the changes. Several calls during one event cause one render. |
| `(react-mount ELEMENT SELECTOR)` | Render into the page element the CSS selector names. |

Props of DOM elements: `:on-click`, `:on-input`, `:on-submit`, ... are listeners (the function gets a plist `:type :value :checked :key`); `:value` and `:checked` are DOM properties, so inputs are controlled; `:style` is a string or a plist; everything else is an attribute (`nil` removes it, `t` sets it empty).

## Development

```sh
npm run serve        # http://localhost:5180/examples/counter/
npm run test:lisp    # the reconciler, with a native Emacs
npm run test:e2e     # the examples in headless Chrome
```

With a wasmacs checkout next to this one (`../wasmacs/docs`), the server and the browser test load Emacs from there; otherwise from the public wasmacs site.

## Limits

This is the first stage of an experiment, not a framework. Children are matched by position (no keyed reordering), there is no asynchronous code (no effects, no data fetching), a handler that never returns cannot be interrupted, and Emacs is a 150 MB download. See [doc/experiment-notes.md](doc/experiment-notes.md).
