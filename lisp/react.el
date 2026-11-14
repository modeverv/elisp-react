;;; react.el --- A small React in Emacs Lisp  -*- lexical-binding: t; -*-

;; An experiment: can the React of 2013 (components with props and state,
;; render functions that return a virtual DOM, reconciliation) be written in
;; Emacs Lisp, with the browser's DOM as the output?
;;
;; Everything that is React lives here: elements, components, state, the
;; reconciler that compares the previous tree with the new one.  This file
;; never touches a DOM.  It produces a list of small DOM operations
;; ("create a div", "set this text", "insert that node here") which a thin
;; JavaScript host (js/elisp-react.js) applies, and it receives the DOM's
;; events from that host.  Emacs itself runs in the page as WebAssembly
;; (the wasmacs eval service).

;;; Elements
;;
;; A virtual DOM is plain Lisp data:
;;
;;   "text", 42                          a text node
;;   (div (:class "box") CHILD...)       a DOM element: (TAG PROPS CHILD...)
;;   (div CHILD...)                      PROPS may be left out
;;   (counter (:start 3))                a component, defined with
;;                                       `react-define-component'
;;
;; PROPS is a plist with keyword keys.  For a DOM element:
;;
;;   :on-click FUNCTION    an event listener; FUNCTION gets the event, a
;;                         plist (:type "click" :value ... :checked ... :key ...)
;;   :value :checked       DOM properties (controlled inputs)
;;   :style                a string, or a plist (:color "red" :margin-top "4px")
;;   :key                  not rendered; identifies a child among its
;;                         siblings (see below)
;;   :ref                  not rendered; a name under which the component
;;                         that rendered the element finds its DOM node
;;                         (`react-focus', `react-invoke')
;;   anything else         an attribute; nil removes it, t sets it empty
;;
;; Among the children, nil is skipped and a list of elements (what `mapcar'
;; returns) is spliced in.  Backquote does the rest:
;;
;;   `(ul () ,@(mapcar (lambda (item) `(li () ,item)) items))
;;
;; or the `jsx' macro, which needs no commas:
;;
;;   (jsx (ul (mapcar (lambda (item) (jsx (li item))) items)))
;;
;; Children of a list that changes (rows that are added, removed, sorted)
;; get a :key each: (li (:key ID) ...).  On the next render a child with the
;; same key is the same child: it keeps its DOM node and its components keep
;; their state, wherever it now stands.  Without keys children are matched
;; by position.

;;; Components
;;
;;   (react-define-component 'counter
;;     :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
;;     :render (lambda (self)
;;               `(button (:on-click ,(lambda (_event)
;;                                      (react-set-state self :count (1+ (react-state self :count)))))
;;                  ,(format "%d" (react-state self :count)))))
;;
;;   (react-mount '(counter (:start 3)) "#app")
;;
;; State is a plist.  `react-set-state' never modifies it: it installs a new
;; plist and schedules the component to render again.

;;; The page, and time
;;
;; Lisp runs only while it answers the host: it cannot wait, and it cannot
;; reach into the page.  What a component wants from the page is therefore
;; data too, sent along with the DOM operations; the host does it, and when
;; there is an answer it calls Lisp again, which runs the function that was
;; waiting for it:
;;
;;   (react-set-timeout 1000 (lambda () ...))      also `react-set-interval'
;;   (react-fetch "/data.json" :then (lambda (response) ...))
;;   (react-storage-set "todos" todos)             localStorage, any Lisp data
;;   (react-focus self "edit")                     the element with :ref "edit"
;;
;; Such a function typically ends in `react-set-state'.  Start timers and
;; requests in :did-mount, react to a finished render in :did-update, stop
;; timers in :will-unmount.
;;
;; `react-async' writes the same thing top to bottom: the code stops at each
;; `react-await' and goes on when the page has answered.
;;
;;   (react-async
;;     (react-set-state self :status 'loading)
;;     (let ((response (react-await (react-fetch-async "/data.json"))))
;;       (react-await (react-sleep 300))
;;       (react-set-state self :status 'loaded :data (react-response-json response))))

;;; Code:

(require 'cl-lib)
(require 'generator)

;;;; Mounted tree

;; What is on the page, as the reconciler remembers it.

(cl-defstruct (react--text (:constructor react--text-create))
  dom-id text)

(cl-defstruct (react--host (:constructor react--host-create))
  dom-id tag props children
  owner)      ; the component instance whose render produced it

(cl-defstruct (react--instance (:constructor react--instance-create))
  type        ; the component's name
  spec        ; its definition (plist)
  props state
  child       ; what it rendered, mounted
  depth       ; components between the root and this one
  dirty       ; state changed since the last render
  mounted     ; nil once unmounted
  rendered-props rendered-state   ; what the last render saw
  refs        ; alist: ref name -> mounted element
  force)      ; render even if :should-update says no (the definition changed)

(defvar react--next-dom-id 0)
(defvar react--ops nil "DOM operations for the host, newest first.")
(defvar react--hosts (make-hash-table) "DOM id -> mounted element.")
(defvar react--roots (make-hash-table :test #'equal) "Selector -> mounted root.")
(defvar react--dirty nil "Component instances that have to render again.")
(defvar react--did-mount nil "Instances mounted since the last flush.")
(defvar react--did-update nil "(INSTANCE PREVIOUS-PROPS PREVIOUS-STATE) of renders since the last flush.")
(defvar react--owner nil "The component instance that is rendering.")
(defvar react--next-request 0)
(defvar react--requests (make-hash-table) "Request id -> (FUNCTION . KEEP) waiting for the host.")
(defvar react--storage (make-hash-table :test #'equal) "localStorage of this page: key -> printed value.")

(defun react--emit (&rest op)
  (push (vconcat op) react--ops))

(defun react--new-dom-id ()
  (cl-incf react--next-dom-id))

(defun react--dom-id (mounted)
  "The id of the DOM node that MOUNTED is on the page."
  (cond ((react--text-p mounted) (react--text-dom-id mounted))
        ((react--host-p mounted) (react--host-dom-id mounted))
        (t (react--dom-id (react--instance-child mounted)))))

;;;; Elements

(defun react-define-component (name &rest spec)
  "Define the component NAME (a symbol).  SPEC is a plist:

:render FUNCTION         (SELF) -> an element.  Required.
:initial-state FUNCTION  (PROPS) -> the first state, a plist.
:did-mount FUNCTION      (SELF), after the component is on the page.
:did-update FUNCTION     (SELF PREVIOUS-PROPS PREVIOUS-STATE), after each
                         later render.
:should-update FUNCTION  (SELF PREVIOUS-PROPS PREVIOUS-STATE) -> nil to skip
                         a render: the component and everything below it
                         stay as they are.  PREVIOUS-PROPS and
                         PREVIOUS-STATE are what the last render saw; SELF
                         has the new ones.  See `react-changed-p'.
:pure t                  Shorthand: render only when a prop or the state
                         changed (`react-shallow-equal').
:will-unmount FUNCTION   (SELF), before it is taken off.

An element (NAME PROPS CHILD...) then renders this component.  Its
children reach the component as the prop :children."
  (unless (functionp (plist-get spec :render))
    (error "Component %s has no :render function" name))
  (when (and (plist-get spec :pure) (not (plist-get spec :should-update)))
    (setq spec (append spec (list :should-update #'react--pure-should-update))))
  (let ((defined (get name 'react-component)))
    (put name 'react-component spec)
    ;; Defined again while it is on the page (a development tool evaluated
    ;; the changed source): the instances take the new definition and render
    ;; again with the state they have.
    (when defined (react--redefined name spec)))
  name)

(defun react--redefined (name spec)
  "Give the mounted instances of the component NAME its new SPEC."
  (react--each-instance
   (lambda (instance)
     (when (eq (react--instance-type instance) name)
       (setf (react--instance-spec instance) spec
             (react--instance-force instance) t)
       (unless (react--instance-dirty instance)
         (setf (react--instance-dirty instance) t)
         (push instance react--dirty))))))

(defun react--each-instance (function &optional mounted)
  "Call FUNCTION with every component instance below MOUNTED (or on the page)."
  (cond ((null mounted) (maphash (lambda (_selector root) (react--each-instance function root)) react--roots))
        ((react--instance-p mounted)
         (funcall function mounted)
         (react--each-instance function (react--instance-child mounted)))
        ((react--host-p mounted)
         (dolist (child (react--host-children mounted)) (react--each-instance function child)))))

(defun react--element-props (element)
  "The props of ELEMENT, which is (TAG [PROPS] CHILD...)."
  (let ((second (cadr element)))
    (and (consp second) (keywordp (car second)) second)))

(defun react--element-children (element)
  "The children of ELEMENT: nil dropped, lists of elements spliced in."
  (let ((rest (cdr element)))
    (when (and rest (or (null (car rest)) (and (consp (car rest)) (keywordp (caar rest)))))
      (setq rest (cdr rest)))
    (react--flatten-children rest)))

(defun react--flatten-children (children)
  (let (out)
    (dolist (child children)
      (cond ((or (null child) (eq child t)))
            ((and (consp child) (not (symbolp (car child))))
             (setq out (nconc (nreverse (react--flatten-children child)) out)))
            (t (push child out))))
    (nreverse out)))

(defun react--kind (vnode)
  "What VNODE renders as: `text', (host . TAG) or (component . NAME)."
  (cond ((or (stringp vnode) (numberp vnode)) 'text)
        ((and (consp vnode) (symbolp (car vnode)))
         (cons (if (get (car vnode) 'react-component) 'component 'host) (car vnode)))
        (t (error "Not an element: %S" vnode))))

(defun react--text-of (vnode)
  (if (stringp vnode) vnode (format "%s" vnode)))

;;;; jsx

(defconst react-html-tags
  '(a abbr address area article aside audio b bdi bdo blockquote body br button canvas caption
    cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset
    figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img
    input ins kbd label legend li link main map mark menu meta meter nav noscript object ol
    optgroup option output p picture pre progress q rp rt ruby s samp script search section
    select slot small source span strong style sub summary sup table tbody td template
    textarea tfoot th thead time title tr track u ul var video wbr)
  "The HTML elements that `jsx' recognises.")

(defun react--jsx-element-p (form)
  "Non-nil if FORM is markup for `jsx': (TAG ...) or (Component ...)."
  (and (consp form) (symbolp (car form)) (car form)
       (or (memq (car form) react-html-tags)
           (let ((first (aref (symbol-name (car form)) 0)))
             (and (<= ?A first) (<= first ?Z))))))

(defun react--jsx (form)
  "The Lisp expression that builds the element which FORM describes."
  (if (not (react--jsx-element-p form))
      form
    (let* ((rest (cdr form))
           (has-props (and rest (or (null (car rest)) (and (consp (car rest)) (keywordp (caar rest))))))
           (props (and has-props (car rest)))
           (children (if has-props (cdr rest) rest))
           prop-forms)
      (while props
        (unless (keywordp (car props)) (error "jsx: %S is not a prop name in %S" (car props) form))
        (push (car props) prop-forms)
        (push (react--jsx (cadr props)) prop-forms)
        (setq props (cddr props)))
      `(list ',(car form)
             ,(and prop-forms `(list ,@(nreverse prop-forms)))
             ,@(mapcar #'react--jsx children)))))

(defmacro react-jsx (form)
  "Build an element from markup, without backquote and commas.

  (jsx (div (:class \"counter\")
         (p (format \"Count: %d\" count))
         (button (:on-click (lambda (_event) (increment))) \"+1\")
         (when (> count 9) (jsx (strong \"a lot\")))
         (Badge (:text label))))

FORM and everything in it is read like this:

- A list that starts with an HTML tag (`react-html-tags') or with a
  Capitalized symbol is an element: (TAG PROPS CHILD...) or (TAG CHILD...).
  Capitalized names are components, as in JSX.  The prop names are taken
  as they are; the prop values and the children are read by these rules.
- Anything else is Lisp and is evaluated: a variable, a string, a call
  like (format ...) or (mapcar ...).  Its value may be an element, a list
  of elements, text or nil.  Markup inside such Lisp needs `jsx' again.

The value is the same plain list a backquote would build."
  (unless (react--jsx-element-p form)
    (error "jsx: %S does not start with an HTML tag or a Capitalized component name" form))
  (react--jsx form))

(defalias 'jsx #'react-jsx)

;;;; DOM element props

(defun react--event-name (key)
  "\"click\" for :on-click; nil when KEY is not a listener prop."
  (let ((name (symbol-name key)))
    (and (string-prefix-p ":on-" name) (substring name 4))))

(defun react--style-string (style)
  (if (stringp style)
      style
    (let (parts)
      (while style
        (push (format "%s: %s" (substring (symbol-name (car style)) 1) (cadr style)) parts)
        (setq style (cddr style)))
      (mapconcat #'identity (nreverse parts) "; "))))

(defun react--attribute-value (key value)
  "VALUE of the prop KEY as an attribute: a string, t (present) or nil (absent)."
  (cond ((or (null value) (eq value :false)) nil)
        ((eq value t) t)
        ((eq key :style) (react--style-string value))
        ((stringp value) value)
        (t (format "%s" value))))

(defun react--set-prop (dom-id key value)
  "Put the prop KEY with VALUE on the DOM node DOM-ID."
  (cond ((memq key '(:key :ref)))
        ((react--event-name key)
         (react--emit (if value "listen" "unlisten") dom-id (react--event-name key)))
        ((memq key '(:value :checked))
         (react--emit "prop" dom-id (substring (symbol-name key) 1)
                      (if (eq key :checked) (and value (not (eq value :false)) t) (react--text-of (or value "")))))
        (t (react--emit "attr" dom-id (substring (symbol-name key) 1)
                        (react--attribute-value key value)))))

(defun react--update-props (dom-id old new)
  "Change the DOM node DOM-ID from the props OLD to the props NEW."
  (let ((plist new))
    (while plist
      (let ((key (car plist)) (value (cadr plist)))
        (cond ((react--event-name key)
               ;; Only whether there is a listener matters to the DOM; the
               ;; function is looked up when the event arrives.
               (unless (eq (null value) (null (plist-get old key)))
                 (react--set-prop dom-id key value)))
              ;; What the user typed is not in OLD: say it again.
              ((memq key '(:value :checked)) (react--set-prop dom-id key value))
              ((not (equal value (plist-get old key))) (react--set-prop dom-id key value))))
      (setq plist (cddr plist))))
  (let ((plist old))
    (while plist
      (unless (plist-member new (car plist))
        (react--set-prop dom-id (car plist) nil))
      (setq plist (cddr plist)))))

;;;; Mounting

(defun react--render (instance)
  "Call INSTANCE's render function; the result is one element."
  (let ((vnode (funcall (plist-get (react--instance-spec instance) :render) instance)))
    (cond ((null vnode) "")
          ((and (consp vnode) (not (symbolp (car vnode))))
           (error "Component %s rendered a list of elements; wrap them in one element"
                  (react--instance-type instance)))
          (t vnode))))

(defun react--mount (vnode depth)
  "Create VNODE (DOM operations and bookkeeping).  Returns it mounted."
  (pcase (react--kind vnode)
    ('text
     (let ((mounted (react--text-create :dom-id (react--new-dom-id) :text (react--text-of vnode))))
       (react--emit "text" (react--text-dom-id mounted) (react--text-text mounted))
       mounted))
    (`(host . ,tag)
     (let* ((id (react--new-dom-id))
            (props (react--element-props vnode))
            (mounted (react--host-create :dom-id id :tag tag :props props :owner react--owner)))
       (react--emit "create" id (symbol-name tag))
       (puthash id mounted react--hosts)
       (react--set-ref mounted nil (plist-get props :ref))
       (let ((plist props))
         (while plist
           (when (cadr plist) (react--set-prop id (car plist) (cadr plist)))
           (setq plist (cddr plist))))
       (setf (react--host-children mounted)
             (mapcar (lambda (child)
                       (let ((mounted-child (react--mount child depth)))
                         (react--emit "insert" id (react--dom-id mounted-child) nil)
                         mounted-child))
                     (react--element-children vnode)))
       mounted))
    (`(component . ,name)
     (let* ((spec (get name 'react-component))
            (props (react--component-props vnode))
            (initial (plist-get spec :initial-state))
            (instance (react--instance-create
                       :type name :spec spec :props props :depth depth :mounted t
                       :state (and initial (funcall initial props)))))
       (setf (react--instance-rendered-props instance) props
             (react--instance-rendered-state instance) (react--instance-state instance))
       (let ((react--owner instance))
         (setf (react--instance-child instance) (react--mount (react--render instance) (1+ depth))))
       (when (plist-get spec :did-mount) (push instance react--did-mount))
       instance))))

(defun react--set-ref (host old new)
  "HOST's :ref changed from the name OLD to the name NEW (nil: none)."
  (let ((owner (react--host-owner host)))
    (when owner
      (when (and old (eq (cdr (assoc old (react--instance-refs owner))) host))
        (setf (react--instance-refs owner)
              (assoc-delete-all old (react--instance-refs owner))))
      (when new
        (setf (alist-get new (react--instance-refs owner) nil nil #'equal) host)))))

(defun react--component-props (vnode)
  "The props a component gets from its element VNODE."
  (let ((props (react--element-props vnode))
        (children (react--element-children vnode)))
    (if children (append props (list :children children)) props)))

(defun react--unmount (mounted)
  "Forget MOUNTED and everything below it.  The DOM node is the caller's."
  (cond ((react--host-p mounted)
         (remhash (react--host-dom-id mounted) react--hosts)
         (react--set-ref mounted (plist-get (react--host-props mounted) :ref) nil)
         (mapc #'react--unmount (react--host-children mounted)))
        ((react--instance-p mounted)
         (let ((will-unmount (plist-get (react--instance-spec mounted) :will-unmount)))
           (when will-unmount (funcall will-unmount mounted)))
         (setf (react--instance-mounted mounted) nil)
         (react--unmount (react--instance-child mounted)))))

;;;; Reconciliation

(defun react--same-p (mounted vnode)
  "Non-nil if MOUNTED can be updated to show VNODE; otherwise it is replaced."
  (pcase (react--kind vnode)
    ('text (react--text-p mounted))
    (`(host . ,tag)
     (and (react--host-p mounted) (eq (react--host-tag mounted) tag)
          (equal (plist-get (react--host-props mounted) :key)
                 (plist-get (react--element-props vnode) :key))))
    (`(component . ,name)
     (and (react--instance-p mounted) (eq (react--instance-type mounted) name)
          (equal (plist-get (react--instance-props mounted) :key)
                 (plist-get (react--element-props vnode) :key))))))

(defun react--update (mounted vnode depth)
  "Make MOUNTED show VNODE with as few DOM operations as possible.
Returns what is mounted afterwards: MOUNTED itself, changed in place, or
a replacement that has taken its place in the DOM."
  (cond
   ((not (react--same-p mounted vnode))
    (let ((new (react--mount vnode depth)))
      (react--emit "replace" (react--dom-id mounted) (react--dom-id new))
      (react--unmount mounted)
      new))
   ((react--text-p mounted)
    (let ((text (react--text-of vnode)))
      (unless (equal text (react--text-text mounted))
        (setf (react--text-text mounted) text)
        (react--emit "set-text" (react--text-dom-id mounted) text)))
    mounted)
   ((react--host-p mounted)
    (let ((props (react--element-props vnode)))
      (react--update-props (react--host-dom-id mounted) (react--host-props mounted) props)
      (unless (equal (plist-get props :ref) (plist-get (react--host-props mounted) :ref))
        (react--set-ref mounted (plist-get (react--host-props mounted) :ref) (plist-get props :ref)))
      (setf (react--host-props mounted) props))
    (setf (react--host-children mounted)
          (react--update-children (react--host-dom-id mounted) (react--host-children mounted)
                                  (react--element-children vnode) depth))
    mounted)
   (t
    (setf (react--instance-props mounted) (react--component-props vnode))
    (react--rerender mounted)
    mounted)))

(defun react--mounted-key (mounted)
  "The :key that MOUNTED was rendered with, or nil."
  (cond ((react--host-p mounted) (plist-get (react--host-props mounted) :key))
        ((react--instance-p mounted) (plist-get (react--instance-props mounted) :key))))

(defun react--vnode-key (vnode)
  (and (consp vnode) (plist-get (react--element-props vnode) :key)))

(defun react--identities (items key-function)
  "How each of ITEMS is recognised among its siblings.
A child with a :key is (key . KEY); one without is (index . N), the N-th
child without a key.  A list without any keys is thus matched by position."
  (let ((unkeyed -1))
    (mapcar (lambda (item)
              (let ((key (funcall key-function item)))
                (if key (cons 'key key) (cons 'index (cl-incf unkeyed)))))
            items)))

(defun react--longest-increasing (numbers)
  "Positions in the vector NUMBERS of a longest increasing subsequence.
Returns a bool-vector: t at the positions that belong to it."
  (let* ((n (length numbers))
         (tails (make-vector n 0))      ; tails[k]: position where the best run of length k+1 ends
         (previous (make-vector n -1))
         (length 0)
         (keep (make-bool-vector n nil)))
    (dotimes (i n)
      (let ((low 0) (high length))
        (while (< low high)
          (let ((middle (/ (+ low high) 2)))
            (if (< (aref numbers (aref tails middle)) (aref numbers i))
                (setq low (1+ middle))
              (setq high middle))))
        (when (> low 0) (aset previous i (aref tails (1- low))))
        (aset tails low i)
        (when (= low length) (setq length (1+ length)))))
    (let ((i (if (> length 0) (aref tails (1- length)) -1)))
      (while (>= i 0)
        (aset keep i t)
        (setq i (aref previous i))))
    keep))

(defun react--update-children (parent-id mounted vnodes depth)
  "Update the children MOUNTED of the DOM node PARENT-ID to VNODES.
A new child takes over the old child with the same identity (see
`react--identities'): that one keeps its DOM node and, below it, the
state of its components, wherever it is in the new order.  Old children
that nobody took over are removed, the rest is created.  Returns the new
list of mounted children."
  (let ((old (make-hash-table :test #'equal))
        (seen (make-hash-table :test #'equal))
        (index -1)
        placed)                         ; (MOUNTED . old position or nil), last child first
    (cl-mapc (lambda (identity child) (puthash identity (cons (cl-incf index) child) old))
             (react--identities mounted #'react--mounted-key) mounted)
    (cl-mapc
     (lambda (identity vnode)
       (let ((found (gethash identity old)))
         (cond (found
                (remhash identity old)
                (push (cons (react--update (cdr found) vnode depth) (car found)) placed))
               (t
                (when (gethash identity seen)
                  (message "react: two children have the key %S" (cdr identity)))
                (push (cons (react--mount vnode depth) nil) placed)))
         (puthash identity t seen)))
     (react--identities vnodes #'react--vnode-key) vnodes)
    ;; Nobody took these over.
    (let (gone)
      (maphash (lambda (_identity entry) (push entry gone)) old)
      (dolist (entry (sort gone (lambda (a b) (< (car a) (car b)))))
        (react--emit "remove" (react--dom-id (cdr entry)))
        (react--unmount (cdr entry))))
    ;; The old children that are still in their old order relative to each
    ;; other (a longest such set) stay where they are.  Every other child,
    ;; new or out of order, is put in front of the child that follows it,
    ;; from the last child to the first.
    (let* ((kept (delq nil (mapcar #'cdr placed)))   ; old positions, last child first
           (stay (react--longest-increasing (vconcat (nreverse kept))))
           (position (length stay))
           before out)
      (dolist (entry placed)
        (unless (and (cdr entry) (aref stay (cl-decf position)))
          (react--emit "insert" parent-id (react--dom-id (car entry)) before))
        (setq before (react--dom-id (car entry)))
        (push (car entry) out))
      out)))

(defun react--rerender (instance)
  "Render INSTANCE again and reconcile what it rendered before."
  (setf (react--instance-dirty instance) nil)
  (let ((should-update (plist-get (react--instance-spec instance) :should-update)))
    ;; A skipped render leaves "what the last render saw" as it is: the next
    ;; question is again about the difference to what is on the page.
    (when (or (null should-update)
              (prog1 (react--instance-force instance) (setf (react--instance-force instance) nil))
              (funcall should-update instance (react--instance-rendered-props instance)
                       (react--instance-rendered-state instance)))
      (when (plist-get (react--instance-spec instance) :did-update)
        (push (list instance (react--instance-rendered-props instance) (react--instance-rendered-state instance))
              react--did-update))
      (setf (react--instance-rendered-props instance) (react--instance-props instance)
            (react--instance-rendered-state instance) (react--instance-state instance))
      (let ((react--owner instance))
        (setf (react--instance-child instance)
              (react--update (react--instance-child instance) (react--render instance)
                             (1+ (react--instance-depth instance))))))))

;;;; State

(defun react-plist-with (plist &rest changes)
  "A new plist: PLIST with the keys of CHANGES (a plist) set.
PLIST is not modified.  State and the records in it are changed this way:
  (react-plist-with todo :done t)"
  (let ((new (copy-sequence plist)))
    (while changes
      (setq new (plist-put new (car changes) (cadr changes)))
      (setq changes (cddr changes)))
    new))

(defun react-props (self &optional key)
  "The props of the component instance SELF, or the prop KEY."
  (if key (plist-get (react--instance-props self) key) (react--instance-props self)))

(defun react-state (self &optional key)
  "The state of the component instance SELF, or its value for KEY."
  (if key (plist-get (react--instance-state self) key) (react--instance-state self)))

(defun react-set-state (self &rest changes)
  "Change the state of SELF and schedule it to render again.
CHANGES is a plist that is merged into the state: (react-set-state self
:count 1).  Or it is one function, which gets the current state and
returns the plist to merge.  The old state plist is not modified.
Several changes during one event cause one render."
  (when (and (functionp (car changes)) (null (cdr changes)))
    (setq changes (funcall (car changes) (react--instance-state self))))
  (setf (react--instance-state self) (apply #'react-plist-with (react--instance-state self) changes))
  (when (and (react--instance-mounted self) (not (react--instance-dirty self)))
    (setf (react--instance-dirty self) t)
    (push self react--dirty))
  nil)

;;;; Skipping renders

(defun react--same-value-p (a b)
  "Non-nil if the prop or state values A and B are the same.
Strings and numbers are compared by value, everything else by identity:
a record or a list that was not replaced is the same, a new one is not
\(state is changed by building new values, never in place).  Functions
are the same only if they are the same object: a `lambda' in a render
function makes a new one every time."
  (or (eq a b)
      (and (stringp a) (stringp b) (string= a b))
      (and (numberp a) (numberp b) (= a b))))

(defun react-shallow-equal (a b)
  "Non-nil if the plists A and B have the same keys with the same values.
Values are compared one level deep: see `react--same-value-p'."
  (and (= (length a) (length b))
       (let ((same t) (plist a))
         (while (and same plist)
           (setq same (and (plist-member b (car plist))
                           (react--same-value-p (cadr plist) (plist-get b (car plist)))))
           (setq plist (cddr plist)))
         same)))

(defun react-changed-p (new old &rest keys)
  "Non-nil if the plists NEW and OLD differ in one of KEYS.
For :should-update, to look only at the props that matter to the render:

  :should-update
  (lambda (self previous-props previous-state)
    (or (not (eq (react-state self) previous-state))
        (react-changed-p (react-props self) previous-props :todo)))

Leaving out a function prop is safe when the handlers that use it read
it when the event happens, (funcall (react-props self :on-change) ...),
because a skipped component still gets its new props."
  (cl-some (lambda (key) (not (react--same-value-p (plist-get new key) (plist-get old key)))) keys))

(defun react--pure-should-update (self previous-props previous-state)
  (not (and (react-shallow-equal (react--instance-props self) previous-props)
            (react-shallow-equal (react--instance-state self) previous-state))))

;;;; The host's entry points

(defun react-mount (element selector)
  "Render ELEMENT into the page element that the CSS SELECTOR names.
Rendering into the same place again updates what is there."
  (let ((root (gethash selector react--roots)))
    (if root
        (puthash selector (react--update root element 0) react--roots)
      (setq root (puthash selector (react--mount element 0) react--roots)))
    (react--emit "mount" selector (react--dom-id (gethash selector react--roots))))
  selector)

(defun react-unmount (selector)
  "Take down what `react-mount' rendered into SELECTOR."
  (let ((root (gethash selector react--roots)))
    (when root
      (react--emit "remove" (react--dom-id root))
      (react--unmount root)
      (remhash selector react--roots)))
  nil)

(defun react--render-dirty ()
  "Render every component whose state changed, parents first."
  (let ((rounds 0))
    (while (or react--dirty react--did-mount react--did-update)
      (when (> (cl-incf rounds) 100)
        (setq react--dirty nil react--did-mount nil react--did-update nil)
        (error "Components keep changing state while rendering"))
      (let ((dirty (sort react--dirty (lambda (a b) (< (react--instance-depth a) (react--instance-depth b))))))
        (setq react--dirty nil)
        (dolist (instance dirty)
          ;; A parent that rendered first may have updated or removed it.
          (when (and (react--instance-dirty instance) (react--instance-mounted instance))
            (react--rerender instance))))
      (let ((mounted (nreverse react--did-mount)))
        (setq react--did-mount nil)
        (dolist (instance mounted)
          (when (react--instance-mounted instance)
            (funcall (plist-get (react--instance-spec instance) :did-mount) instance))))
      (let ((updated (nreverse react--did-update)))
        (setq react--did-update nil)
        (dolist (entry updated)
          (when (react--instance-mounted (car entry))
            (apply (plist-get (react--instance-spec (car entry)) :did-update) entry)))))))

(defun react-flush ()
  "Finish pending renders.  Returns the DOM operations since the last call.
The value is a vector of operations for the host, each a vector:

  [\"create\" ID TAG]  [\"text\" ID STRING]  [\"set-text\" ID STRING]
  [\"attr\" ID NAME VALUE]  [\"prop\" ID NAME VALUE]
  [\"listen\" ID EVENT]  [\"unlisten\" ID EVENT]
  [\"insert\" PARENT-ID ID BEFORE-ID]  [\"replace\" OLD-ID ID]  [\"remove\" ID]
  [\"mount\" SELECTOR ID]
  [\"invoke\" ID METHOD]                 call a method of the DOM node
  [\"call\" REQUEST-ID COMMAND ARGUMENT]  do it and answer (`react-host-reply')
  [\"tell\" COMMAND ARGUMENT]             do it, no answer
  [\"cancel\" REQUEST-ID]"
  (react--render-dirty)
  (prog1 (vconcat (nreverse react--ops))
    (setq react--ops nil)))

(defun react-dispatch-event (dom-id name event)
  "The DOM node DOM-ID received the event NAME.  EVENT is a plist.
Runs the element's listener and returns the DOM operations that follow."
  (let* ((host (gethash dom-id react--hosts))
         (handler (and host (plist-get (react--host-props host) (intern (concat ":on-" name))))))
    (when handler (funcall handler event)))
  (react-flush))

;;;; The page: DOM nodes

(defun react-ref (self name)
  "The element that SELF rendered with :ref NAME, or nil.
The value is only good for `react-invoke'."
  (cdr (assoc name (react--instance-refs self))))

(defun react-invoke (self name method)
  "Call METHOD on the DOM node of the element SELF rendered with :ref NAME.
METHOD is one of \"focus\", \"blur\", \"select\", \"click\" and
\"scrollIntoView\".  It runs after the DOM changes of this render.
Nothing happens when there is no such element."
  (let ((host (react-ref self name)))
    (when host (react--emit "invoke" (react--host-dom-id host) method)))
  nil)

(defun react-focus (self name)
  "Give the keyboard focus to the element SELF rendered with :ref NAME."
  (react-invoke self name "focus"))

;;;; The page: things that take time

(defun react-host-call (command argument &optional function keep)
  "Ask the host to do COMMAND with ARGUMENT (JSON data).
When the host answers, FUNCTION is called with OK (non-nil for success)
and the VALUE of the answer.  With KEEP, FUNCTION stays for further
answers (an interval).  Returns the request, for `react-cancel'.
This is what `react-set-timeout' and `react-fetch' are made of."
  (let ((id (cl-incf react--next-request)))
    (when function (puthash id (cons function keep) react--requests))
    (react--emit "call" id command argument)
    id))

(defun react-cancel (request)
  "Forget REQUEST (a timer, a fetch): its function will not be called."
  (when request
    (remhash request react--requests)
    (react--emit "cancel" request))
  nil)

(defun react-host-reply (request ok value)
  "The host's answer to REQUEST.  Returns the DOM operations that follow."
  (let ((entry (gethash request react--requests)))
    (when entry
      (unless (cdr entry) (remhash request react--requests))
      (funcall (car entry) ok value)))
  (react-flush))

(defun react-set-timeout (milliseconds function)
  "Call FUNCTION, without arguments, once after MILLISECONDS.
Returns the timer, for `react-clear-timer'."
  (react-host-call "timeout" milliseconds (lambda (_ok _value) (funcall function))))

(defun react-set-interval (milliseconds function)
  "Call FUNCTION, without arguments, every MILLISECONDS.
Returns the timer; stop it with `react-clear-timer' (in :will-unmount)."
  (react-host-call "interval" milliseconds (lambda (_ok _value) (funcall function)) t))

(defalias 'react-clear-timer #'react-cancel)

(defun react-fetch (url &rest options)
  "Request URL with the browser's fetch.  OPTIONS is a plist:

:method STRING   \"GET\" by default
:headers PLIST   (:content-type \"application/json\")
:body STRING
:then FUNCTION   (RESPONSE), a plist (:status 200 :ok t :text \"...\");
                 an HTTP error status is a response too, with :ok nil
:catch FUNCTION  (MESSAGE), when there was no response at all

Returns the request, for `react-cancel'.  `react-response-json' reads a
JSON body."
  (let ((then (plist-get options :then))
        (catch (plist-get options :catch)))
    (react-host-call
     "fetch"
     (list :url url :method (or (plist-get options :method) "GET")
           :headers (plist-get options :headers) :body (plist-get options :body))
     (lambda (ok value)
       (cond ((and ok then) (funcall then value))
             (ok nil)
             (catch (funcall catch value))
             (t (message "react-fetch: %s: %s" url value)))))))

(defun react-response-json (response)
  "The body of RESPONSE as Lisp data: objects are plists, arrays vectors."
  (json-parse-string (plist-get response :text) :object-type 'plist :null-object nil :false-object nil))

;;;; async / await

;; An "awaitable" is a function of two arguments, RESOLVE and REJECT: it
;; starts something and calls one of them, once, when that has finished.

(define-error 'react-async-error "Asynchronous operation failed")

(defun react-sleep (milliseconds)
  "An awaitable that finishes after MILLISECONDS."
  (lambda (resolve _reject)
    (react-set-timeout milliseconds (lambda () (funcall resolve nil)))))

(defun react-fetch-async (url &rest options)
  "An awaitable for `react-fetch': its value is the response.
OPTIONS are :method, :headers and :body.  Without a response the await
signals `react-async-error'; an HTTP error status is a response."
  (lambda (resolve reject)
    (apply #'react-fetch url :then resolve :catch reject options)))

(defun react--await-value (answer)
  "What `react-await' evaluates to, given the runner's ANSWER."
  (if (eq (car-safe answer) 'react--rejected)
      (signal 'react-async-error (list (cdr answer)))
    (cdr answer)))

(defmacro react-await (awaitable)
  "Inside `react-async': wait for AWAITABLE and return its value.
The Lisp code stops here and Emacs goes back to the page; when the page
has the answer, the code goes on.  If the operation fails, this signals
`react-async-error', which `condition-case' around it can handle.
State may have changed in the meantime: read it again after an await."
  `(react--await-value (iter-yield ,awaitable)))

(defun react--async-step (iterator answer)
  "Run ITERATOR until its next await, handing it ANSWER for the last one."
  (condition-case nil
      (funcall (iter-next iterator answer)
               (lambda (value) (react--async-step iterator (cons 'react--resolved value)))
               (lambda (message) (react--async-step iterator (cons 'react--rejected message))))
    (iter-end-of-sequence nil)))

(defmacro react-async (&rest body)
  "Run BODY, in which `react-await' waits for the page.

  (react-async
    (react-set-state self :status \='loading)
    (condition-case nil
        (let ((response (react-await (react-fetch-async \"/data.json\"))))
          (react-set-state self :status \='loaded
                           :data (react-response-json response)))
      (react-async-error (react-set-state self :status \='failed))))

BODY starts at once and runs until its first await; `react-async' then
returns nil, and the rest happens when the page answers.  Loops and
conditionals may contain awaits; an `unwind-protect' cleanup form and a
`lambda' inside BODY may not (it is a generator: see `iter-lambda')."
  (declare (indent 0))
  `(react--async-step (funcall (iter-lambda () ,@body)) nil))

;;;; The page: localStorage

;; The host hands over this page's stored values when it starts, so reading
;; is immediate.  Values are any printable Lisp data.

(defun react--storage-load (entries)
  "ENTRIES is a vector of [KEY TEXT]: what the page has stored."
  (clrhash react--storage)
  (mapc (lambda (entry) (puthash (aref entry 0) (aref entry 1) react--storage)) entries)
  nil)

(defun react-storage-get (key &optional default)
  "The Lisp value stored under KEY in the page's localStorage, or DEFAULT."
  (let ((text (gethash key react--storage)))
    (if text
        (condition-case nil (car (read-from-string text)) (error default))
      default)))

(defun react-storage-set (key value)
  "Store the Lisp VALUE under KEY in the page's localStorage."
  (let ((text (let ((print-length nil) (print-level nil)) (prin1-to-string value))))
    (unless (equal text (gethash key react--storage))
      (puthash key text react--storage)
      (react--emit "tell" "storage-set" (list :key key :value text))))
  value)

(defun react-storage-remove (key)
  "Remove KEY from the page's localStorage."
  (when (gethash key react--storage)
    (remhash key react--storage)
    (react--emit "tell" "storage-remove" (list :key key)))
  nil)

;;;; For tests and debugging

(defun react-reset ()
  "Forget everything that is mounted."
  (setq react--next-dom-id 0 react--ops nil react--dirty nil react--did-mount nil
        react--did-update nil react--next-request 0)
  (clrhash react--hosts)
  (clrhash react--roots)
  (clrhash react--requests)
  (clrhash react--storage)
  nil)

(defun react--html (mounted)
  (cond ((react--text-p mounted) (react--text-text mounted))
        ((react--instance-p mounted) (react--html (react--instance-child mounted)))
        (t (let ((attributes "") (plist (react--host-props mounted)))
             (while plist
               (let* ((key (car plist))
                      (value (and (not (react--event-name key)) (not (memq key '(:key :ref)))
                                  (react--attribute-value key (cadr plist)))))
                 (when value
                   (setq attributes (concat attributes " " (substring (symbol-name key) 1)
                                            (if (eq value t) "" (format "=\"%s\"" value))))))
               (setq plist (cddr plist)))
             (format "<%s%s>%s</%s>" (react--host-tag mounted) attributes
                     (mapconcat #'react--html (react--host-children mounted) "")
                     (react--host-tag mounted))))))

(defun react-html (selector)
  "What is mounted at SELECTOR, as HTML text (after pending renders)."
  (react--render-dirty)
  (let ((root (gethash selector react--roots)))
    (and root (react--html root))))

(provide 'react)
;;; react.el ends here
