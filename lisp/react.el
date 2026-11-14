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
;;   :key                  not rendered
;;   anything else         an attribute; nil removes it, t sets it empty
;;
;; Among the children, nil is skipped and a list of elements (what `mapcar'
;; returns) is spliced in.  Backquote does the rest:
;;
;;   `(ul () ,@(mapcar (lambda (item) `(li () ,item)) items))

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

;;; Code:

(require 'cl-lib)

;;;; Mounted tree

;; What is on the page, as the reconciler remembers it.

(cl-defstruct (react--text (:constructor react--text-create))
  dom-id text)

(cl-defstruct (react--host (:constructor react--host-create))
  dom-id tag props children)

(cl-defstruct (react--instance (:constructor react--instance-create))
  type        ; the component's name
  spec        ; its definition (plist)
  props state
  child       ; what it rendered, mounted
  depth       ; components between the root and this one
  dirty       ; state changed since the last render
  mounted)    ; nil once unmounted

(defvar react--next-dom-id 0)
(defvar react--ops nil "DOM operations for the host, newest first.")
(defvar react--hosts (make-hash-table) "DOM id -> mounted element.")
(defvar react--roots (make-hash-table :test #'equal) "Selector -> mounted root.")
(defvar react--dirty nil "Component instances that have to render again.")
(defvar react--did-mount nil "Instances mounted since the last flush.")

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
:will-unmount FUNCTION   (SELF), before it is taken off.

An element (NAME PROPS CHILD...) then renders this component.  Its
children reach the component as the prop :children."
  (unless (functionp (plist-get spec :render))
    (error "Component %s has no :render function" name))
  (put name 'react-component spec)
  name)

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
  (cond ((eq key :key))
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
            (mounted (react--host-create :dom-id id :tag tag :props props)))
       (react--emit "create" id (symbol-name tag))
       (puthash id mounted react--hosts)
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
       (setf (react--instance-child instance) (react--mount (react--render instance) (1+ depth)))
       (when (plist-get spec :did-mount) (push instance react--did-mount))
       instance))))

(defun react--component-props (vnode)
  "The props a component gets from its element VNODE."
  (let ((props (react--element-props vnode))
        (children (react--element-children vnode)))
    (if children (append props (list :children children)) props)))

(defun react--unmount (mounted)
  "Forget MOUNTED and everything below it.  The DOM node is the caller's."
  (cond ((react--host-p mounted)
         (remhash (react--host-dom-id mounted) react--hosts)
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
      (setf (react--host-props mounted) props))
    (setf (react--host-children mounted)
          (react--update-children (react--host-dom-id mounted) (react--host-children mounted)
                                  (react--element-children vnode) depth))
    mounted)
   (t
    (setf (react--instance-props mounted) (react--component-props vnode))
    (react--rerender mounted)
    mounted)))

(defun react--update-children (parent-id mounted vnodes depth)
  "Update the children MOUNTED of the DOM node PARENT-ID to VNODES.
Children are matched by position.  Returns the new list of mounted children."
  (let (out)
    (while (or mounted vnodes)
      (cond ((and mounted vnodes)
             (push (react--update (car mounted) (car vnodes) depth) out))
            (vnodes
             (let ((new (react--mount (car vnodes) depth)))
               (react--emit "insert" parent-id (react--dom-id new) nil)
               (push new out)))
            (t
             (react--emit "remove" (react--dom-id (car mounted)))
             (react--unmount (car mounted))))
      (setq mounted (cdr mounted) vnodes (cdr vnodes)))
    (nreverse out)))

(defun react--rerender (instance)
  "Render INSTANCE again and reconcile what it rendered before."
  (setf (react--instance-dirty instance) nil)
  (setf (react--instance-child instance)
        (react--update (react--instance-child instance) (react--render instance)
                       (1+ (react--instance-depth instance)))))

;;;; State

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
  (let ((state (copy-sequence (react--instance-state self))))
    (while changes
      (setq state (plist-put state (car changes) (cadr changes)))
      (setq changes (cddr changes)))
    (setf (react--instance-state self) state))
  (when (and (react--instance-mounted self) (not (react--instance-dirty self)))
    (setf (react--instance-dirty self) t)
    (push self react--dirty))
  nil)

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
    (while (or react--dirty react--did-mount)
      (when (> (cl-incf rounds) 100)
        (setq react--dirty nil react--did-mount nil)
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
            (funcall (plist-get (react--instance-spec instance) :did-mount) instance)))))))

(defun react-flush ()
  "Finish pending renders.  Returns the DOM operations since the last call.
The value is a vector of operations for the host, each a vector:

  [\"create\" ID TAG]  [\"text\" ID STRING]  [\"set-text\" ID STRING]
  [\"attr\" ID NAME VALUE]  [\"prop\" ID NAME VALUE]
  [\"listen\" ID EVENT]  [\"unlisten\" ID EVENT]
  [\"insert\" PARENT-ID ID BEFORE-ID]  [\"replace\" OLD-ID ID]  [\"remove\" ID]
  [\"mount\" SELECTOR ID]"
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

;;;; For tests and debugging

(defun react-reset ()
  "Forget everything that is mounted."
  (setq react--next-dom-id 0 react--ops nil react--dirty nil react--did-mount nil)
  (clrhash react--hosts)
  (clrhash react--roots)
  nil)

(defun react--html (mounted)
  (cond ((react--text-p mounted) (react--text-text mounted))
        ((react--instance-p mounted) (react--html (react--instance-child mounted)))
        (t (let ((attributes "") (plist (react--host-props mounted)))
             (while plist
               (let* ((key (car plist))
                      (value (and (not (react--event-name key)) (not (eq key :key))
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
