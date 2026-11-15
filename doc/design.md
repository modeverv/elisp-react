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

## Loading Lisp

Source that is merely evaluated runs in Emacs's interpreter, which expands every macro at every call: each render would expand `jsx` again and run the reconciler's `pcase` and structure accessors uncompiled. Measured in the page's Emacs, a render of 1000 rows took 4.7 s that way and 0.13 s byte-compiled.

So `js/elisp-react.js` loads every file compiled: it writes the source into Emacs's in-memory filesystem, calls `byte-compile-file` and loads the result. Compiling `react.el` takes about 0.3 s, so the compiled code is kept in `localStorage` under a hash of the source and of Emacs's version, and later visits load it directly. A file that does not compile is evaluated instead, so that the error the page shows is the program's own.

Emacs itself is cached by the wasmacs eval service (Cache Storage, keyed by a build id) and downloaded on the first visit only: `temacs.wasm` and the pdmp, about 5 MB as GitHub Pages compresses them. Emacs's own Lisp files (146 MB) are not downloaded as a whole. What `react.el` needs is in the pdmp for the most part; the service fetches a file when Emacs reads it (the five examples together read seven, 0.5 MB), from a server that answers range requests. `start()` says which it was: `files` is `"on demand"`, or `"all"` where the server sends whole files only and the package is downloaded as before.

## Elements

An element is a list `(TAG PROPS CHILD...)`. `TAG` is a symbol: the name of a component if one is defined with that name (`react-define-component` puts the definition on the symbol's property list), otherwise an HTML tag. `PROPS` is a plist and may be left out; it is recognised by starting with a keyword. Strings and numbers are text.

Nothing has to be registered or compiled to write an element: it is quoted data, and backquote fills in the dynamic parts.

## jsx

`(jsx MARKUP)` is a macro that expands markup into the `list` calls that build the same plain element:

```elisp
(jsx (p (:id name) (upcase name)))   ; expands to
(list 'p (list :id name) (upcase name))
```

The macro has to tell markup from Lisp without evaluating anything. A list is markup if it starts with an HTML tag (a fixed list, `react-html-tags`) or with a Capitalized symbol, which is a component as in JSX. Whether a symbol names a component cannot be asked at expansion time: a component may be defined later, or be the one being defined. Everything else is Lisp and is left alone, so markup nested in Lisp (`when`, `mapcar`, a helper function) needs its own `jsx`.

The plain-list form remains the foundation and has no naming rule; `jsx` is a convenience on top.

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

### Children and keys

Each child has an identity among its siblings: `(key . K)` if it has a `:key`, otherwise `(index . N)` as the N-th child without a key. A new child takes over the old child with the same identity. A list without keys is therefore matched by position; a keyed child is found wherever it was.

`react--update-children` works in three steps:

1. In the new order, update the old child of each identity (it keeps its DOM node and the state below it) or mount a new one.
2. Remove the old children nobody took over.
3. Place. The kept children that are still in their old order relative to each other need no DOM operation. A longest such set is a longest increasing subsequence of old positions (`react--longest-increasing`, O(n log n)). Every other child, new or out of order, is inserted in front of the child that follows it, going from the last child to the first.

Moving the last of n rows to the front is one `insert`. (React's original "last index" rule moves the other n-1 rows in that case.)

`test/react-test.el` checks this against a model of the DOM: 300 rounds of random removals, additions and shuffles, applying the operations to the model and comparing it with the mounted tree, while clicks on random rows verify that state follows the keys.

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

Ordinary DOM attributes are data: the host omits inline `on*` handlers and
`srcdoc`, and blocks `javascript:` / `vbscript:` in URL attributes (including
browser-normalized case and whitespace variants). A blocked update removes the
old attribute and warns with its name only; the remaining operations still run.
Use Lisp `:on-click` and the other `:on-...` props for callbacks. Text children
remain text nodes. Page-authored Lisp, `start`/`load`/`run`, and deliberate script
elements remain trusted application code; this policy is not a general HTML
sanitizer or a Lisp sandbox. The policy stays in the single host JS file so
applications that copy `elisp-react.js` need no additional runtime module.

## The page and time

Emacs Lisp runs only inside a request of the host: an event, or the first render. It cannot wait for anything and it has no access to the page. Both limits are answered the same way the DOM is: what Lisp wants is data in the operation list.

```text
["invoke", id, method]                 focus, blur, select, click, scrollIntoView
["tell", command, argument]            storage-set, storage-remove: no answer
["call", request, command, argument]   timeout, interval, fetch: answered later
["cancel", request]
```

For a `call`, Lisp keeps the function that waits under the request number (`react--requests`). The host does the work with the browser's own asynchronous APIs and then calls `react-host-reply REQUEST OK VALUE`. That is an ordinary request to Lisp: the waiting function runs, typically calls `react-set-state`, the flush renders, and the reply carries the resulting DOM operations back. An interval keeps its function until it is cancelled.

So asynchronous code in a component is a callback that changes state, and time passes only in the host. `react-set-timeout`, `react-set-interval` and `react-fetch` are thin functions over `react-host-call`; a new capability is one more command in `js/elisp-react.js` and one such function.

`localStorage` could have been the same, but then the first render could not use stored data. The host instead hands the page's entries to Lisp before any component code runs (`react--storage-load`); reads come from that copy, and writes update the copy and `tell` the page. Values are printed Lisp (`prin1` / `read`), so a list of plists with symbols in it is stored as it is.

A `:ref` names an element for the component that rendered it. `react-invoke` emits its operation into the same list as the DOM changes, after them, which is why `:did-update` (run after the render, before the flush returns) is the place to ask for the focus of a field that the render has just created.

### async / await

`react-async` is a macro over `iter-lambda` from Emacs's `generator.el`, which rewrites a body into a state machine that can stop at `iter-yield` and be resumed. `(react-await X)` yields the awaitable `X`, a function of `(RESOLVE REJECT)`. The runner, `react--async-step`, calls the awaitable with two functions that resume the generator with `(react--resolved . VALUE)` or `(react--rejected . MESSAGE)`; `react-await` turns the latter into the signal `react-async-error` inside the body, so an ordinary `condition-case` around an await handles a failure.

Nothing else is new: `react-sleep` and `react-fetch-async` are awaitables over the same host calls, the generator is resumed inside `react-host-reply`, and the state it sets is rendered by the flush that ends that request. Because the page's Lisp is byte-compiled when it is loaded, the rewriting into a state machine happens once, not at every call.

Limits inherited from `generator.el`: an await cannot be inside a `lambda` in the body or in the cleanup forms of `unwind-protect`. There is no cancellation, and an `async` body has no value to wait for (no composition of async functions).

## Skipping renders

A parent's render updates each child component: new props, render, reconcile. With `:should-update` the component is asked first, with the props and state its last render saw; on nil nothing below it is touched. The new props are stored either way.

`:pure t` installs the usual answer: render if any prop or the state differs. Strings and numbers are compared by value, everything else by `eq`. That is cheap and it is right for state that is replaced rather than modified: an unchanged record is the same object. It is defeated by function props, since a `lambda` in a render function is a new closure every time. The pattern used in `examples/todo`: compare the data props with `react-changed-p`, and let handlers fetch function props when the event happens.

Measured in the page's Emacs with 1000 keyed rows: a render that changes one row takes 134 ms, 29 ms with `:pure` rows (the rest is the parent building 1000 elements and matching the keys).

## Redefinition

`react-define-component` on a name that is already defined is a change of the program while it runs. The new definition replaces the old one on the symbol; `react--redefined` walks the mounted trees, gives every instance of that component the new definition, and queues it for a render that `:should-update` cannot decline. The state plists stay, so the page shows the new code with the old state. `:initial-state` and `:did-mount` are not run again, and a timer that the old `:did-mount` started still calls the old function.

The host's `load(name, text)` is the entry point for a development tool: it compiles and loads the source like at startup and applies the operations of the flush that follows.

## Order and time

The eval service answers one request at a time, in order, and the host applies each answer before the next one arrives. A burst of clicks therefore renders correctly without any locking. Everything in Lisp is synchronous: a handler runs to its end, then the render, then the answer. Answers to requests (a timer, a response) queue up with the events.

A request that runs for ever (an endless loop in a handler) cannot be interrupted: the worker is busy and takes no message. The host therefore gives each request a time limit (`timeout`, 30 s by default). When it passes, the host stops the service, cancels what it was doing for Lisp (timers, requests) and reports an error with the symbol `timeout`. Without that, the page would go on scrolling and drawing (the main thread is free) while nothing reacts, and no error would ever be raised.

The submit event of a form is always `preventDefault`ed by the host when Lisp listens for it, because Lisp answers after the browser has made its decision.

## Tests

`test/react-test.el` runs the reconciler in a native Emacs. Because operations are data, a test mounts an element, dispatches an event and compares the operations or the HTML text of the mounted tree; no DOM is involved and the whole file takes milliseconds.

`test/e2e.mjs` opens the examples in headless Chrome with Emacs running in the page and checks, among other things, that DOM nodes survive a re-render (the page is patched, not rebuilt).
