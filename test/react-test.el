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

(provide 'react-test)
;;; react-test.el ends here
