# Design

## The split

```text
page
  <script type="text/emacs-lisp" src="app.el">      the program
  js/elisp-react.js                                  host: 3 jobs
    1. start Emacs, load react.el and the page's Lisp
    2. apply DOM operations
    3. send DOM events to Lisp
      |  emacs.call("react-dispatch-event", id, "click", event)  ->  [DOM operations]
wasmacs eval service (Emacs 30.2 as WebAssembly, in a worker)
  lisp/react.el                                      React
    elements, components, state, reconciler
```

The rule of the experiment: everything that is React is Emacs Lisp. JavaScript does not know what a component is. It has a map from numbers to DOM nodes and a dozen operations.

Emacs comes from the wasmacs eval service (`doc/eval-service.md` in wasmacs): a page sends Lisp, Emacs evaluates it and answers with JSON. One round trip takes about 0.1 ms.

## Elements

An element is a list `(TAG PROPS CHILD...)`. `TAG` is a symbol: the name of a component if one is defined with that name (`react-define-component` puts the definition on the symbol's property list), otherwise an HTML tag. `PROPS` is a plist and may be left out; it is recognised by starting with a keyword. Strings and numbers are text.

Nothing has to be registered or compiled to write an element: it is quoted data, and backquote fills in the dynamic parts.

## The mounted tree

`react.el` remembers what is on the page as a tree of three structures:

- `react--text`: a text node and its string,
- `react--host`: a DOM element with its tag, props and mounted children,
- `react--instance`: a component instance with its props, its state and the one mounted node it rendered.

Text and host nodes carry a `dom-id`, a number Lisp chooses. That number is all Lisp knows of the DOM.

## Reconciliation

`react--update MOUNTED ELEMENT` makes a mounted node show a new element:

- Same kind (text; same tag; same component; equal `:key`): update in place. Text: one `set-text` if the string differs. Element: diff the props, then the children. Component: store the new props, call `:render`, reconcile what it rendered before with the new result.
- Otherwise: mount the new element, emit `replace`, unmount the old node (which runs `:will-unmount` below it).

Children are matched by position: the n-th old child with the n-th new one; surplus old children are removed, surplus new ones mounted and inserted.

`react-set-state` installs a new state plist, marks the instance dirty and queues it. Nothing renders yet. `react-flush` renders the dirty instances, parents first (a parent's render updates its children, which clears their mark), then runs `:did-mount` functions, and repeats while those changed more state. So several `react-set-state` calls in one event handler cause one render.

## Operations

`react-flush` returns the operations since the last flush as a vector, which the eval service turns into JSON:

```text
["create", id, tag]      ["text", id, string]      ["set-text", id, string]
["attr", id, name, value]   value: string, true (present), null (remove)
["prop", id, name, value]   DOM property: value, checked
["listen", id, event]    ["unlisten", id, event]
["insert", parentId, id, beforeId]   ["replace", oldId, id]   ["remove", id]
["mount", selector, id]
```

`js/elisp-react.js` applies them in order. Its listeners all do the same thing: describe the event as a small object and call `react-dispatch-event` with the node's id. Lisp finds the element's current props, calls the `:on-...` function and returns the operations that follow.

A listener function is never sent to JavaScript, and replacing it (every render creates new closures) costs no DOM operation: only "this node listens for click" is DOM state.

## Order and time

The eval service answers one request at a time, in order, and the host applies each answer before the next one arrives. A burst of clicks therefore renders correctly without any locking. Everything in Lisp is synchronous: a handler runs to its end, then the render, then the answer.

The submit event of a form is always `preventDefault`ed by the host when Lisp listens for it, because Lisp answers after the browser has made its decision.

## Tests

`test/react-test.el` runs the reconciler in a native Emacs. Because operations are data, a test mounts an element, dispatches an event and compares the operations or the HTML text of the mounted tree; no DOM is involved and the whole file takes milliseconds.

`test/e2e.mjs` opens the examples in headless Chrome with Emacs running in the page and checks, among other things, that DOM nodes survive a re-render (the page is patched, not rebuilt).
