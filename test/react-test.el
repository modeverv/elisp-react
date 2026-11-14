;;; react-test.el --- tests of react.el without a browser  -*- lexical-binding: t; -*-

;; Run with: test/run-ert.sh
;; The reconciler is exercised the way the JavaScript host drives it:
;; `react-mount', `react-flush', `react-dispatch-event'.  What a browser
;; would do with the operations is checked in test/e2e.mjs.

(require 'ert)
(require 'cl-lib)
(require 'react)

(defun react-test--ops ()
  "Pending operations as lists."
  (mapcar (lambda (op) (append op nil)) (react-flush)))

(defun react-test--find (name ops)
  "The operations called NAME among OPS."
  (cl-remove-if-not (lambda (op) (equal (car op) name)) ops))

(defun react-test--listener (event ops)
  "DOM ids listening for EVENT according to OPS, in order."
  (mapcar #'cadr (cl-remove-if-not (lambda (op) (and (equal (car op) "listen") (equal (nth 2 op) event))) ops)))

(defmacro react-test--fresh (&rest body)
  (declare (indent 0))
  `(progn (react-reset) ,@body))

(react-define-component 'react-test-counter
  :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
  :render
  (lambda (self)
    `(div (:class "counter")
       (p () ,(format "%s: %d" (or (react-props self :label) "count") (react-state self :count)))
       (button (:on-click ,(lambda (_event) (react-set-state self :count (1+ (react-state self :count)))))
         "+1"))))

(ert-deftest react-test-elements ()
  "Props may be left out; nil children vanish; lists of children are spliced."
  (react-test--fresh
    (react-mount `(ul (li "a") nil ,(mapcar (lambda (n) `(li () ,n)) '(1 2)) (li (:class "last") "z")) "#app")
    (should (equal (react-html "#app") "<ul><li>a</li><li>1</li><li>2</li><li class=\"last\">z</li></ul>"))))

(ert-deftest react-test-mount-operations ()
  "Mounting creates every node once and puts the root into the page."
  (react-test--fresh
    (react-mount '(div (:id "box" :hidden t :title nil :style (:color "red" :margin-top "4px")) "hi" (span () 7)) "#app")
    (should (equal (react-test--ops)
                   '(("create" 1 "div")
                     ("attr" 1 "id" "box")
                     ("attr" 1 "hidden" t)
                     ("attr" 1 "style" "color: red; margin-top: 4px")
                     ("text" 2 "hi") ("insert" 1 2 nil)
                     ("create" 3 "span") ("text" 4 "7") ("insert" 3 4 nil) ("insert" 1 3 nil)
                     ("mount" "#app" 1))))
    (should (equal (react-test--ops) nil))))

(ert-deftest react-test-counter ()
  "A click runs the Lisp handler; the only DOM change is the text."
  (react-test--fresh
    (react-mount '(react-test-counter (:start 3 :label "apples")) "#app")
    (let* ((ops (react-test--ops))
           (button (car (react-test--listener "click" ops))))
      (should (equal (react-html "#app") "<div class=\"counter\"><p>apples: 3</p><button>+1</button></div>"))
      (should button)
      (let ((after (append (react-dispatch-event button "click" '(:type "click")) nil)))
        (should (equal (length after) 1))
        (should (equal (seq-take (append (car after) nil) 1) '("set-text")))
        (should (equal (nth 2 (append (car after) nil)) "apples: 4")))
      (react-dispatch-event button "click" nil)
      (should (equal (react-html "#app") "<div class=\"counter\"><p>apples: 5</p><button>+1</button></div>")))))

(ert-deftest react-test-independent-state ()
  "Two instances of one component keep their own state."
  (react-test--fresh
    (react-mount '(div () (react-test-counter (:label "a")) (react-test-counter (:label "b" :start 10))) "#app")
    (let ((buttons (react-test--listener "click" (react-test--ops))))
      (should (= (length buttons) 2))
      (react-dispatch-event (nth 1 buttons) "click" nil)
      (react-dispatch-event (nth 1 buttons) "click" nil)
      (react-dispatch-event (nth 0 buttons) "click" nil)
      (should (string-match-p "a: 1.*b: 12" (react-html "#app"))))))

(ert-deftest react-test-state-is-replaced-not-modified ()
  "`react-set-state' installs a new plist."
  (react-test--fresh
    (let (instance before)
      (react-define-component 'react-test-probe
        :initial-state (lambda (_props) (list :n 0 :other "kept"))
        :render (lambda (self) (setq instance self) `(i () ,(react-state self :n))))
      (react-mount '(react-test-probe) "#app")
      (react-flush)
      (setq before (react-state instance))
      (react-set-state instance :n 1)
      (react-set-state instance (lambda (state) (list :n (+ 10 (plist-get state :n)))))
      (should (equal before '(:n 0 :other "kept")))
      (should (equal (react-state instance) '(:n 11 :other "kept")))
      ;; Two changes, one render.
      (should (equal (mapcar (lambda (op) (append op nil)) (react-flush)) '(("set-text" 2 "11")))))))

(ert-deftest react-test-props-flow-down ()
  "A parent's state reaches its children as props; a child calls back up."
  (react-test--fresh
    (react-define-component 'react-test-step
      :render (lambda (self)
                `(button (:on-click ,(lambda (_e) (funcall (react-props self :on-step) (react-props self :by))))
                   ,(format "+%d" (react-props self :by)))))
    (react-define-component 'react-test-total
      :initial-state (lambda (_props) (list :total 0))
      :render (lambda (self)
                (let ((add (lambda (n) (react-set-state self :total (+ n (react-state self :total))))))
                  `(div ()
                     (b () ,(react-state self :total))
                     (react-test-step (:by 1 :on-step ,add))
                     (react-test-step (:by 5 :on-step ,add))))))
    (react-mount '(react-test-total) "#app")
    (let ((buttons (react-test--listener "click" (react-test--ops))))
      (react-dispatch-event (nth 1 buttons) "click" nil)
      (react-dispatch-event (nth 0 buttons) "click" nil)
      (should (equal (react-html "#app") "<div><b>6</b><button>+1</button><button>+5</button></div>")))))

(ert-deftest react-test-children-grow-and-shrink ()
  "Added children are inserted, surplus ones removed, the rest updated in place."
  (react-test--fresh
    (react-define-component 'react-test-list
      :initial-state (lambda (_props) (list :items '("a" "b")))
      :render (lambda (self)
                `(ul (:on-click ,(lambda (event) (react-set-state self :items (plist-get event :items))))
                   ,@(mapcar (lambda (item) `(li () ,item)) (react-state self :items)))))
    (react-mount '(react-test-list) "#app")
    (let ((ul (car (react-test--listener "click" (react-test--ops)))))
      (let ((ops (mapcar (lambda (op) (append op nil)) (react-dispatch-event ul "click" '(:items ("a" "B" "c"))))))
        (should (equal (react-html "#app") "<ul><li>a</li><li>B</li><li>c</li></ul>"))
        (should (equal (length (react-test--find "set-text" ops)) 1))
        (should (equal (length (react-test--find "create" ops)) 1))
        (should (equal (length (react-test--find "remove" ops)) 0)))
      (let ((ops (mapcar (lambda (op) (append op nil)) (react-dispatch-event ul "click" '(:items ("a"))))))
        (should (equal (react-html "#app") "<ul><li>a</li></ul>"))
        (should (equal (length (react-test--find "remove" ops)) 2))
        (should (equal (length (react-test--find "create" ops)) 0))))))

(ert-deftest react-test-replace-and-lifecycle ()
  "A different element type replaces the node; lifecycle functions run."
  (react-test--fresh
    (let (log toggle)
      (react-define-component 'react-test-child
        :did-mount (lambda (self) (push (list 'mounted (react-props self :name)) log))
        :will-unmount (lambda (self) (push (list 'unmounted (react-props self :name)) log))
        :render (lambda (self) `(em () ,(react-props self :name))))
      (react-define-component 'react-test-switch
        :initial-state (lambda (_props) (list :on t))
        :render (lambda (self)
                  (setq toggle (lambda () (react-set-state self :on (not (react-state self :on)))))
                  `(div () ,(if (react-state self :on) '(react-test-child (:name "x")) '(span () "off")))))
      (react-mount '(react-test-switch) "#app")
      (react-flush)
      (should (equal log '((mounted "x"))))
      (funcall toggle)
      (let ((ops (react-test--ops)))
        (should (equal (react-html "#app") "<div><span>off</span></div>"))
        (should (equal (length (react-test--find "replace" ops)) 1))
        (should (equal log '((unmounted "x") (mounted "x")))))
      (funcall toggle)
      (react-flush)
      (should (equal (react-html "#app") "<div><em>x</em></div>"))
      (should (equal (car log) '(mounted "x"))))))

(ert-deftest react-test-props-diff ()
  "Changed attributes are set, vanished ones removed, listeners added and dropped."
  (react-test--fresh
    (let (set)
      (react-define-component 'react-test-attrs
        :initial-state (lambda (_props) (list :props '(:class "a" :title "t" :on-click ignore)))
        :render (lambda (self)
                  (setq set (lambda (props) (react-set-state self :props props)))
                  `(input ,(react-state self :props))))
      (react-mount '(react-test-attrs) "#app")
      (react-flush)
      (funcall set '(:class "b" :value "typed" :on-input ignore))
      (should (equal (sort (react-test--ops) (lambda (a b) (string< (format "%S" a) (format "%S" b))))
                     '(("attr" 1 "class" "b") ("attr" 1 "title" nil)
                       ("listen" 1 "input") ("prop" 1 "value" "typed") ("unlisten" 1 "click")))))))

(ert-deftest react-test-operations-are-json ()
  "The host receives the operations as JSON."
  (react-test--fresh
    (react-mount '(react-test-counter) "#app")
    (should (string-prefix-p "[[\"create\",1,\"div\"],[\"attr\",1,\"class\",\"counter\"]"
                             (json-serialize (react-flush) :null-object nil :false-object :false)))))


;;;; Keyed children

(defvar react-test--set-items nil)

(react-define-component 'react-test-note
  ;; A row with state of its own: how often it was clicked.
  :initial-state (lambda (_props) (list :clicks 0))
  :render (lambda (self)
            `(li (:on-click ,(lambda (_event) (react-set-state self :clicks (1+ (react-state self :clicks)))))
               ,(format "%s:%d" (react-props self :name) (react-state self :clicks)))))

(react-define-component 'react-test-notes
  :initial-state (lambda (props) (list :items (plist-get props :items)))
  :render (lambda (self)
            (setq react-test--set-items (lambda (items) (react-set-state self :items items)))
            `(ul () ,@(mapcar (lambda (name)
                                (if (eq (react-props self :keyed) :false)
                                    `(react-test-note (:name ,name))
                                  `(react-test-note (:key ,name :name ,name))))
                              (react-state self :items)))))

(defun react-test--row-ids (ops)
  "The DOM ids of the rows, in the order they were created."
  (mapcar #'cadr (react-test--find "create" (cl-remove-if-not (lambda (op) (equal (nth 2 op) "li")) ops))))

(ert-deftest react-test-keys-reorder ()
  "Keyed children keep their DOM nodes and state when the order changes."
  (react-test--fresh
    (react-mount '(react-test-notes (:items ("a" "b" "c" "d"))) "#app")
    (let* ((ids (react-test--row-ids (react-test--ops)))
           (b (nth 1 ids)) (d (nth 3 ids)))
      (react-dispatch-event b "click" nil)
      (react-dispatch-event b "click" nil)
      (react-dispatch-event d "click" nil)
      ;; The last row to the front: one move, nothing created or removed.
      (funcall react-test--set-items '("d" "a" "b" "c"))
      (let ((ops (react-test--ops)))
        (should (equal ops `(("insert" 1 ,d ,(nth 0 ids)))))
        (should (equal (react-html "#app") "<ul><li>d:1</li><li>a:0</li><li>b:2</li><li>c:0</li></ul>")))
      ;; Reversed.
      (funcall react-test--set-items '("c" "b" "a" "d"))
      (let ((ops (react-test--ops)))
        (should (equal (react-test--find "create" ops) nil))
        (should (equal (react-test--find "remove" ops) nil))
        (should (equal (react-html "#app") "<ul><li>c:0</li><li>b:2</li><li>a:0</li><li>d:1</li></ul>")))
      ;; The same nodes still answer.
      (react-dispatch-event b "click" nil)
      (should (string-match-p "<li>b:3</li>" (react-html "#app"))))))

(ert-deftest react-test-keys-insert-and-remove ()
  "Rows in the middle come and go; the others keep their state."
  (react-test--fresh
    (react-mount '(react-test-notes (:items ("a" "b" "c"))) "#app")
    (let* ((ids (react-test--row-ids (react-test--ops)))
           (c (nth 2 ids)))
      (react-dispatch-event c "click" nil)
      (funcall react-test--set-items '("a" "c"))
      (let ((ops (react-test--ops)))
        (should (equal ops `(("remove" ,(nth 1 ids)))))
        (should (equal (react-html "#app") "<ul><li>a:0</li><li>c:1</li></ul>")))
      (funcall react-test--set-items '("new" "a" "x" "c" "z"))
      (let ((ops (react-test--ops)))
        (should (= (length (react-test--find "create" ops)) 3))
        (should (= (length (react-test--find "insert" ops)) (+ 3 3)))   ; three rows, their three texts
        (should (equal (react-test--find "remove" ops) nil))
        (should (equal (react-html "#app") "<ul><li>new:0</li><li>a:0</li><li>x:0</li><li>c:1</li><li>z:0</li></ul>")))
      (react-dispatch-event c "click" nil)
      (should (string-match-p "<li>c:2</li>" (react-html "#app"))))))

(ert-deftest react-test-without-keys-state-stays-in-place ()
  "Without keys children are matched by position: state does not follow a row."
  (react-test--fresh
    (react-mount '(react-test-notes (:keyed :false :items ("a" "b" "c"))) "#app")
    (let ((ids (react-test--row-ids (react-test--ops))))
      (react-dispatch-event (nth 0 ids) "click" nil)
      (funcall react-test--set-items '("b" "c"))
      ;; The first row is still the first row, now showing "b" with a's clicks.
      (should (equal (react-html "#app") "<ul><li>b:1</li><li>c:0</li></ul>")))))

(ert-deftest react-test-keys-mixed-with-unkeyed ()
  "Keyed and unkeyed siblings: keys by key, the rest by their order."
  (react-test--fresh
    (let (set)
      (react-define-component 'react-test-mixed
        :initial-state (lambda (_props) (list :rows '("a" "b")))
        :render (lambda (self)
                  (setq set (lambda (rows) (react-set-state self :rows rows)))
                  `(div ()
                     (h2 () "title")
                     ,@(mapcar (lambda (row) `(p (:key ,row) ,row)) (react-state self :rows))
                     (footer () ,(format "%d rows" (length (react-state self :rows)))))))
      (react-mount '(react-test-mixed) "#app")
      (react-flush)
      (funcall set '("b" "c" "a"))
      (let ((ops (react-test--ops)))
        (should (= (length (react-test--find "create" ops)) 1))
        (should (equal (react-test--find "remove" ops) nil))
        (should (equal (react-html "#app")
                       "<div><h2>title</h2><p>b</p><p>c</p><p>a</p><footer>3 rows</footer></div>"))))))

;;;; The operations against a model of the DOM

;; What the JavaScript host does with the operations, in Lisp: enough of a
;; DOM to check that the page ends up as the mounted tree says.

(defvar react-test--dom nil "DOM id -> (:tag T | :text S, :children IDS, :parent ID).")
(defvar react-test--dom-root nil)

(defun react-test--dom-detach (id)
  (let* ((node (gethash id react-test--dom))
         (parent (plist-get node :parent)))
    (when parent
      (let ((parent-node (gethash parent react-test--dom)))
        (puthash parent (plist-put parent-node :children (remq id (plist-get parent-node :children)))
                 react-test--dom)))
    (puthash id (plist-put node :parent nil) react-test--dom)))

(defun react-test--dom-apply (ops)
  (dolist (op ops)
    (pcase op
      (`("create" ,id ,tag) (puthash id (list :tag tag :children nil :parent nil) react-test--dom))
      (`("text" ,id ,text) (puthash id (list :text text :parent nil) react-test--dom))
      (`("set-text" ,id ,text) (puthash id (plist-put (gethash id react-test--dom) :text text) react-test--dom))
      (`("insert" ,parent ,id ,before)
       (react-test--dom-detach id)
       (let* ((parent-node (gethash parent react-test--dom))
              (children (plist-get parent-node :children))
              (tail (and before (or (memq before children) (error "insert before a node that is not a child")))))
         (puthash parent
                  (plist-put parent-node :children
                             (append (butlast children (length tail)) (list id) tail))
                  react-test--dom)
         (puthash id (plist-put (gethash id react-test--dom) :parent parent) react-test--dom)))
      (`("replace" ,old ,id)
       (let* ((parent (plist-get (gethash old react-test--dom) :parent))
              (parent-node (and parent (gethash parent react-test--dom))))
         (react-test--dom-detach id)
         (when parent
           (puthash parent (plist-put parent-node :children
                                      (mapcar (lambda (child) (if (eq child old) id child))
                                              (plist-get parent-node :children)))
                    react-test--dom)
           (puthash id (plist-put (gethash id react-test--dom) :parent parent) react-test--dom))
         (when (eq react-test--dom-root old) (setq react-test--dom-root id))
         (remhash old react-test--dom)))
      (`("remove" ,id) (react-test--dom-detach id) (remhash id react-test--dom))
      (`("mount" ,_selector ,id) (setq react-test--dom-root id))
      (`(,(or "attr" "prop" "listen" "unlisten") . ,_) nil)
      (_ (error "Unknown operation %S" op)))))

(defun react-test--dom-html (id)
  (let ((node (gethash id react-test--dom)))
    (if (plist-member node :text)
        (plist-get node :text)
      (format "<%s>%s</%s>" (plist-get node :tag)
              (mapconcat #'react-test--dom-html (plist-get node :children) "")
              (plist-get node :tag)))))

(ert-deftest react-test-random-lists-reach-the-dom ()
  "Random insertions, removals and shuffles: the DOM follows, state follows keys."
  (react-test--fresh
    (setq react-test--dom (make-hash-table) react-test--dom-root nil)
    (random "elisp-react")
    (let ((items '("k0" "k1" "k2" "k3" "k4"))
          (next 5)
          (clicks (make-hash-table :test #'equal)))
      (react-mount `(react-test-notes (:items ,items)) "#app")
      (react-test--dom-apply (react-test--ops))
      (dotimes (_ 300)
        ;; A new list: drop some rows, add some, shuffle.
        (setq items (cl-remove-if (lambda (_item) (= 0 (random 4))) items))
        (dotimes (_ (random 3))
          (push (format "k%d" (cl-incf next)) items))
        (setq items (mapcar #'cdr (sort (mapcar (lambda (item) (cons (random 1000) item)) items)
                                        (lambda (a b) (< (car a) (car b))))))
        (funcall react-test--set-items items)
        (react-test--dom-apply (react-test--ops))
        ;; Click a random row through the id its DOM node has now.
        (when items
          (let* ((index (random (length items)))
                 (row (nth index (plist-get (gethash react-test--dom-root react-test--dom) :children))))
            (puthash (nth index items) (1+ (gethash (nth index items) clicks 0)) clicks)
            (react-test--dom-apply (mapcar (lambda (op) (append op nil)) (react-dispatch-event row "click" nil)))))
        ;; Rows that are gone lose their state for good.
        (maphash (lambda (key _count) (unless (member key items) (remhash key clicks))) clicks)
        (let ((expected (format "<ul>%s</ul>"
                                (mapconcat (lambda (item) (format "<li>%s:%d</li>" item (gethash item clicks 0)))
                                           items ""))))
          (should (equal (react-html "#app") expected))
          (should (equal (react-test--dom-html react-test--dom-root) expected)))))))

;;;; jsx

(ert-deftest react-test-jsx-builds-plain-lists ()
  "`jsx' builds the list a backquote would build."
  (let ((count 3) (items '("x" "y")))
    (should (equal (jsx (div (:class "box" :title (format "n=%d" count))
                          "text"
                          count
                          (p (format "Count: %d" count))
                          (when (> count 5) (jsx (strong "many")))
                          (mapcar (lambda (item) (jsx (li (:key item) item))) items)
                          (Fancy-button (:label "ok") (span "child"))))
                   `(div (:class "box" :title "n=3")
                      "text"
                      3
                      (p nil "Count: 3")
                      nil
                      ((li (:key "x") "x") (li (:key "y") "y"))
                      (Fancy-button (:label "ok") (span nil "child")))))
    (should (equal (jsx (br)) '(br nil)))
    (should (equal (macroexpand '(jsx (p (:id name) (upcase name))))
                   '(list 'p (list :id name) (upcase name))))
    (should-error (macroexpand '(jsx (format "not markup"))))
    (should-error (macroexpand '(jsx (p (:id "a" oops)))))))

(ert-deftest react-test-jsx-renders ()
  "Components written with `jsx' render and update like the others."
  (react-test--fresh
    (react-define-component 'React-test-greeting
      :render (lambda (self) (jsx (em (react-props self :children)))))
    (react-define-component 'React-test-toggle
      :initial-state (lambda (_props) (list :on nil))
      :render (lambda (self)
                (jsx (div (:on-click (lambda (_event) (react-set-state self :on (not (react-state self :on)))))
                       (React-test-greeting "hello, " (if (react-state self :on) "on" "off"))
                       (and (react-state self :on) (jsx (b "!")))))))
    (react-mount (jsx (React-test-toggle)) "#app")
    (let ((div (car (react-test--listener "click" (react-test--ops)))))
      (should (equal (react-html "#app") "<div><em>hello, off</em></div>"))
      (react-dispatch-event div "click" nil)
      (should (equal (react-html "#app") "<div><em>hello, on</em><b>!</b></div>")))))

(ert-deftest react-test-plist-with ()
  (let ((todo '(:id 1 :text "a" :done nil)))
    (should (equal (react-plist-with todo :done t :text "b") '(:id 1 :text "b" :done t)))
    (should (equal todo '(:id 1 :text "a" :done nil)))))

;;;; Refs, did-update, and the page's answers

(ert-deftest react-test-refs-and-did-update ()
  "A component finds its DOM nodes by :ref and reacts to a finished render."
  (react-test--fresh
    (let (instance log)
      (react-define-component 'react-test-editor
        :initial-state (lambda (_props) (list :editing nil))
        :did-update (lambda (self previous-props previous-state)
                      (push (list (plist-get previous-props :name) (plist-get previous-state :editing)
                                  (react-state self :editing))
                            log)
                      (when (and (react-state self :editing) (not (plist-get previous-state :editing)))
                        (react-focus self "field")))
        :render (lambda (self)
                  (setq instance self)
                  (if (react-state self :editing)
                      '(form () (input (:ref "field" :class "f")))
                    '(form () (span () "view")))))
      (react-mount '(react-test-editor (:name "a")) "#app")
      (react-flush)
      (should (equal log nil))
      (should (equal (react-ref instance "field") nil))
      (react-set-state instance :editing t)
      (let ((ops (react-test--ops)))
        ;; The focus comes after the node exists and is in place.
        (should (equal (car (last ops)) '("invoke" 4 "focus")))
        (should (equal (react-test--find "attr" ops) '(("attr" 4 "class" "f"))))   ; :ref is not an attribute
        (should (equal log '(("a" nil t)))))
      (should (react-ref instance "field"))
      (react-set-state instance :editing nil)
      (react-flush)
      (should (equal (react-ref instance "field") nil))
      (should (equal (car log) '("a" t nil))))))

(ert-deftest react-test-timers ()
  "Timers are requests to the host; its answers run the Lisp functions."
  (react-test--fresh
    (let ((fired 0) timeout interval)
      (setq timeout (react-set-timeout 500 (lambda () (cl-incf fired))))
      (setq interval (react-set-interval 100 (lambda () (cl-incf fired 10))))
      (should (equal (react-test--ops) `(("call" ,timeout "timeout" 500) ("call" ,interval "interval" 100))))
      (react-host-reply timeout t nil)
      (react-host-reply timeout t nil)          ; a timeout answers once
      (react-host-reply interval t nil)
      (react-host-reply interval t nil)
      (should (= fired 21))
      (react-clear-timer interval)
      (should (equal (react-test--ops) `(("cancel" ,interval))))
      (react-host-reply interval t nil)         ; too late
      (should (= fired 21)))))

(ert-deftest react-test-fetch ()
  "A response, an HTTP error and a failure reach the right function."
  (react-test--fresh
    (let (log)
      (let ((request (react-fetch "/data.json" :headers '(:accept "application/json")
                                  :then (lambda (response) (push (react-response-json response) log)))))
        (should (equal (react-test--ops)
                       `(("call" ,request "fetch" (:url "/data.json" :method "GET"
                                                   :headers (:accept "application/json") :body nil)))))
        (react-host-reply request t '(:status 200 :ok t :text "{\"items\":[1,2],\"more\":false}")))
      (should (equal log '((:items [1 2] :more nil))))
      (let ((request (react-fetch "/missing" :then (lambda (response) (push (plist-get response :status) log))
                                  :catch (lambda (message) (push message log)))))
        (react-host-reply request t '(:status 404 :ok nil :text "")))
      (should (equal (car log) 404))
      (let ((request (react-fetch "/down" :then #'ignore :catch (lambda (message) (push message log)))))
        (react-host-reply request nil "Failed to fetch"))
      (should (equal (car log) "Failed to fetch"))
      (let ((request (react-fetch "/slow" :then (lambda (_response) (push 'late log)))))
        (react-cancel request)
        (react-host-reply request t '(:status 200 :ok t :text "{}")))
      (should (equal (car log) "Failed to fetch")))))

(ert-deftest react-test-storage ()
  "localStorage holds Lisp data; only changes are sent to the page."
  (react-test--fresh
    (react--storage-load [["count" "41"] ["todos" "((:id 1 :text \"a\" :done t))"]])
    (should (equal (react-storage-get "count") 41))
    (should (equal (react-storage-get "todos") '((:id 1 :text "a" :done t))))
    (should (equal (react-storage-get "nothing" 'default) 'default))
    (react-storage-set "count" 42)
    (react-storage-set "count" 42)
    (react-storage-set "filter" 'active)
    (react-storage-remove "todos")
    (should (equal (react-test--ops)
                   '(("tell" "storage-set" (:key "count" :value "42"))
                     ("tell" "storage-set" (:key "filter" :value "active"))
                     ("tell" "storage-remove" (:key "todos")))))
    (should (equal (react-storage-get "filter") 'active))
    (should (equal (react-storage-get "todos") nil))))

(ert-deftest react-test-interval-follows-the-component ()
  "A clock starts its interval when mounted and stops it when unmounted."
  (react-test--fresh
    (react-test--load-example "async/async.el")
    (let* ((ops (react-test--ops))
           (interval (cadr (car (cl-remove-if-not (lambda (op) (equal (nth 2 op) "interval")) ops))))
           (checkbox (car (react-test--listener "change" ops))))
      (should interval)
      (should (string-match-p "0 ticks" (react-html "#app")))
      (react-host-reply interval t nil)
      (react-host-reply interval t nil)
      (should (string-match-p "2 ticks" (react-html "#app")))
      (let ((after (mapcar (lambda (op) (append op nil)) (react-dispatch-event checkbox "change" '(:checked nil)))))
        (should (member `("cancel" ,interval) after))
        (should-not (string-match-p "ticks" (react-html "#app")))))))

;;;; Skipping renders

(ert-deftest react-test-should-update ()
  "A component that says no is not rendered again, nor is anything below it."
  (react-test--fresh
    (let ((renders nil) set)
      (react-define-component 'react-test-cell
        :pure t
        :render (lambda (self)
                  (push (react-props self :name) renders)
                  `(td () ,(format "%s=%d" (react-props self :name) (react-props self :value)))))
      (react-define-component 'react-test-row
        :initial-state (lambda (_props) (list :a 1 :b 1 :label "row"))
        :render (lambda (self)
                  (setq set (lambda (&rest changes) (apply #'react-set-state self changes)))
                  `(tr (:title ,(react-state self :label))
                     (react-test-cell (:name "a" :value ,(react-state self :a)))
                     (react-test-cell (:name "b" :value ,(react-state self :b))))))
      (react-mount '(react-test-row) "#app")
      (react-flush)
      (should (equal (reverse renders) '("a" "b")))
      (setq renders nil)
      ;; Only b's props change: a is skipped.
      (funcall set :b 2)
      (should (equal (react-test--ops) '(("set-text" 5 "b=2"))))
      (should (equal renders '("b")))
      ;; Nothing the cells see changes.
      (setq renders nil)
      (funcall set :label "renamed" :a 1)
      (should (equal (react-test--ops) '(("attr" 1 "title" "renamed"))))
      (should (equal renders nil))
      ;; Equal strings and numbers are the same value; a new function is not.
      (should (react-shallow-equal '(:s "x" :n 1.0 :l nil) (list :s (concat "x") :n 1 :l nil)))
      (should-not (react-shallow-equal (list :f (lambda () 1)) (list :f (lambda () 1))))
      (should-not (react-shallow-equal '(:a 1) '(:a 1 :b 2)))
      (should (react-changed-p '(:a 1 :b (x)) '(:a 1 :b (x)) :b))
      (should-not (react-changed-p '(:a 1 :b 2 :f ignore) '(:a 1 :b 2 :f car) :a :b)))))

(ert-deftest react-test-should-update-keeps-new-props ()
  "A skipped component still has its new props: handlers that read props late see them."
  (react-test--fresh
    (let (set log)
      (react-define-component 'react-test-button
        :should-update (lambda (self previous-props _previous-state)
                         (react-changed-p (react-props self) previous-props :label))
        :render (lambda (self)
                  `(button (:on-click ,(lambda (_event) (funcall (react-props self :on-press))))
                     ,(react-props self :label))))
      (react-define-component 'react-test-panel
        :initial-state (lambda (_props) (list :n 0))
        :render (lambda (self)
                  (setq set (lambda (n) (react-set-state self :n n)))
                  (let ((n (react-state self :n)))
                    `(div () (react-test-button (:label "press" :on-press ,(lambda () (push n log))))))))
      (react-mount '(react-test-panel) "#app")
      (let ((button (car (react-test--listener "click" (react-test--ops)))))
        (funcall set 7)
        (should (equal (react-test--ops) nil))            ; the button was not rendered again
        (react-dispatch-event button "click" nil)
        (should (equal log '(7)))))))                      ; but its handler reached the new function

;;;; async / await

(defun react-test--calls (ops)
  "The requests to the host among OPS: (REQUEST COMMAND ARGUMENT)."
  (mapcar #'cdr (react-test--find "call" ops)))

(defun react-test--reply (request ok value)
  "Answer REQUEST as the host would; the requests that this leads to."
  (react-test--calls (mapcar (lambda (op) (append op nil)) (react-host-reply request ok value))))

(ert-deftest react-test-async-runs-top-to-bottom ()
  "The body stops at each await and goes on when the host answers."
  (react-test--fresh
    (let (log calls)
      (react-async
        (push 'start log)
        (react-await (react-sleep 100))
        (push 'after-first log)
        (dotimes (i 2)
          (react-await (react-sleep (* 10 (1+ i))))
          (push (list 'loop i) log))
        (let ((response (react-await (react-fetch-async "/x.json" :method "POST" :body "{}"))))
          (push (plist-get response :status) log)))
      (should (equal log '(start)))
      (setq calls (react-test--calls (react-test--ops)))
      (should (equal (cdr (car calls)) '("timeout" 100)))
      (setq calls (react-test--reply (car (car calls)) t nil))
      (should (equal log '(after-first start)))
      (dotimes (i 2)
        (should (equal (cdr (car calls)) (list "timeout" (* 10 (1+ i)))))
        (setq calls (react-test--reply (car (car calls)) t nil)))
      (should (equal (seq-take log 2) '((loop 1) (loop 0))))
      (should (equal (nth 1 (car calls)) "fetch"))
      (should (equal (plist-get (nth 2 (car calls)) :method) "POST"))
      (should (equal (react-test--reply (car (car calls)) t '(:status 201 :ok t :text "")) nil))
      (should (equal (car log) 201)))))

(ert-deftest react-test-async-errors ()
  "A failed await signals `react-async-error' at the await."
  (react-test--fresh
    (let (log calls)
      (react-async
        (condition-case err
            (progn (react-await (react-fetch-async "/down"))
                   (push 'not-reached log))
          (react-async-error (push (cadr err) log)))
        (react-await (react-sleep 1))
        (push 'went-on log))
      (setq calls (react-test--reply (car (car (react-test--calls (react-test--ops)))) nil "Failed to fetch"))
      (should (equal log '("Failed to fetch")))
      (react-test--reply (car (car calls)) t nil)
      (should (equal log '(went-on "Failed to fetch")))
      ;; Without a handler the error is the host's to report.
      (react-async (react-await (react-fetch-async "/down")))
      (should-error (react-host-reply (car (car (react-test--calls (react-test--ops)))) nil "gone")
                    :type 'react-async-error))))

(ert-deftest react-test-async-in-a-component ()
  "State set after an await renders like any other."
  (react-test--fresh
    (react-define-component 'react-test-loader
      :initial-state (lambda (_props) (list :status "idle"))
      :did-mount (lambda (self)
                   (react-async
                     (react-set-state self :status "loading")
                     (let ((response (react-await (react-fetch-async "/n.json"))))
                       (react-set-state self :status (format "got %s" (plist-get (react-response-json response) :n))))))
      :render (lambda (self) `(p () ,(react-state self :status))))
    (react-mount '(react-test-loader) "#app")
    (let ((ops (react-test--ops)))
      (should (equal (react-html "#app") "<p>loading</p>"))
      (should (equal (mapcar (lambda (op) (append op nil))
                             (react-host-reply (car (car (react-test--calls ops))) t '(:status 200 :ok t :text "{\"n\":5}")))
                     '(("set-text" 2 "got 5")))))))

;;;; The examples load and render

(defun react-test--load-example (name)
  (load (expand-file-name (format "../examples/%s" name)
                          (file-name-directory (or load-file-name buffer-file-name (locate-library "react-test"))))
        nil t))

(ert-deftest react-test-example-todo ()
  "examples/todo/todo.el renders; its list functions never modify their input."
  (react-test--fresh
    (react-test--load-example "todo/todo.el")
    (should (string-match-p "<span class=\"left\">2 items left</span>" (react-html "#app")))
    (should (= 3 (length (react-test--find "create" (cl-remove-if-not (lambda (op) (equal (nth 2 op) "li"))
                                                                         (react-test--ops))))))
    (let* ((todos '((:id 1 :text "a" :done nil) (:id 2 :text "b" :done t) (:id 3 :text "c" :done nil)))
           (copy (copy-tree todos)))
      (should (equal (mapcar (lambda (todo) (plist-get todo :id)) (todo-move-before todos 3 1)) '(3 1 2)))
      (should (equal (todo-visible todos 'active) '((:id 1 :text "a" :done nil) (:id 3 :text "c" :done nil))))
      (should (equal (plist-get (nth 1 (todo-change todos 2 (lambda (todo) (react-plist-with todo :done nil)))) :done) nil))
      (should (equal todos copy)))))

(ert-deftest react-test-examples-counters ()
  (react-test--fresh
    (react-test--load-example "counter/counter.el")
    (should (string-match-p "Apples: 3" (react-html "#app"))))
  (react-test--fresh
    (react-test--load-example "counters/counters.el")
    (should (string-match-p "2 counters, total 3" (react-html "#app")))))

;;;; The server example

(ert-deftest react-test-notes-model ()
  "examples/server/notes.el: pure functions, shared by server and page."
  (react-test--load-example "server/notes.el")
  (let* ((notes '((:id 1 :text "a" :done nil) (:id 4 :text "b" :done t)))
         (copy (copy-tree notes)))
    (should (equal (notes-apply notes '(add "  c  "))
                   '((:id 1 :text "a" :done nil) (:id 4 :text "b" :done t) (:id 5 :text "c" :done nil))))
    (should (equal (notes-apply notes '(toggle 4)) '((:id 1 :text "a" :done nil) (:id 4 :text "b" :done nil))))
    (should (equal (notes-apply notes '(remove 1)) '((:id 4 :text "b" :done t))))
    (should (equal notes copy))
    (should-error (notes-apply notes '(add "   ")))
    (should-error (notes-apply notes '(add 5)))
    (should-error (notes-apply notes '(eval (kill-emacs))))
    (should-error (notes-apply notes (list 'add (make-string 201 ?x))))))

(ert-deftest react-test-server-api ()
  "examples/server/server.el answers with Lisp data and never evaluates."
  (react-test--load-example "server/server.el")
  (let ((elisp-react-server-data-file (make-temp-file "elisp-react-notes" nil ".eld"))
        (elisp-react-server--notes 'unread)
        (elisp-react-server--started (current-time)))
    (delete-file elisp-react-server-data-file)
    (unwind-protect
        (progn
          (should (= 2 (length (elisp-react-server--api "GET" "/api/notes" ""))))
          (should (equal (plist-get (car (last (elisp-react-server--api "POST" "/api/notes" "(add \"saved\")"))) :text)
                         "saved"))
          ;; Saved, and read again by a server that starts later.
          (setq elisp-react-server--notes 'unread)
          (should (= 3 (length (elisp-react-server--api "GET" "/api/notes" ""))))
          (should (equal (plist-get (elisp-react-server--api "GET" "/api/info" "") :notes) 3))
          (should-error (elisp-react-server--api "POST" "/api/notes" "(eval (delete-file \"x\"))"))
          (should-error (elisp-react-server--api "GET" "/api/nothing" "") :type 'file-missing)
          ;; Files: inside the repository, nothing hidden.
          (should (elisp-react-server--file "/examples/server/app.el"))
          (should (elisp-react-server--file "/examples/counter/"))
          (should-not (elisp-react-server--file "/.gitignore"))
          (should-not (elisp-react-server--file "/.git/config"))
          (should-not (elisp-react-server--file "/../outside"))
          (should (elisp-react-server--same-origin-p nil))
          (should (elisp-react-server--same-origin-p (list (cons "origin" (format "http://127.0.0.1:%d" elisp-react-server-port)))))
          (should-not (elisp-react-server--same-origin-p '(("origin" . "https://example.com")))))
      (ignore-errors (delete-file elisp-react-server-data-file)))))

(provide 'react-test)
;;; react-test.el ends here
