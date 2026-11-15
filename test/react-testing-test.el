;;; react-testing-test.el --- the test kit, on the examples  -*- lexical-binding: t; -*-

;; Run with: test/run-ert.sh.  These tests use only lisp/react-testing.el,
;; as an application's own tests would.

(require 'ert)
(require 'react-testing)

(defconst react-testing-test--examples
  (expand-file-name "../examples/" (file-name-directory (or load-file-name buffer-file-name))))

(ert-deftest react-testing-counter ()
  "Find, click, read attributes."
  (react-testing-load (expand-file-name "counter/counter.el" react-testing-test--examples))
  (let ((first (car (react-testing-find-all :class "increment"))))
    (should (equal (react-testing-text (react-testing-find :class "count")) "Apples: 3"))
    (react-testing-click first)
    (should (equal (react-testing-text (react-testing-find :class "count")) "Apples: 4"))
    (should (equal (mapcar #'react-testing-text (react-testing-find-all :class "count")) '("Apples: 4" "Oranges: 0")))
    (should (equal (react-testing-attribute (cadr (react-testing-find-all :class "reset")) "disabled") ""))
    (react-testing-click (car (react-testing-find-all :class "reset")))
    (should (react-testing-attribute (car (react-testing-find-all :class "reset")) "disabled"))))

(ert-deftest react-testing-todo ()
  "Type, submit, toggle; the storage the page would keep."
  (react-testing-reset)
  (react-testing-storage "todos" '((:id 1 :text "Write tests" :done nil)))
  (load (expand-file-name "todo/todo.el" react-testing-test--examples) nil t)
  (react-testing-flush)
  (should (equal (mapcar #'react-testing-text (react-testing-find-all :class "text")) '("Write tests")))
  (react-testing-input (react-testing-find :class "new-text") "Run them")
  (react-testing-submit (react-testing-find :tag 'form :class "new"))
  (should (equal (mapcar #'react-testing-text (react-testing-find-all :class "text")) '("Write tests" "Run them")))
  (should (equal (react-testing-property (react-testing-find :class "new-text") "value") ""))
  (react-testing-dispatch (react-testing-find :class "toggle") "change" '(:checked t))
  (should (equal (react-testing-text (react-testing-find :class "left")) "1 item left"))
  ;; The page was told to keep the list.
  (let ((stored (car (last (cl-remove-if-not (lambda (told) (equal (car told) "storage-set")) react-testing-told)))))
    (should (string-match-p "Run them" (plist-get (cadr stored) :value)))))

(ert-deftest react-testing-async ()
  "Answer a fetch and let time pass."
  (react-testing-load (expand-file-name "async/async.el" react-testing-test--examples))
  (react-testing-click (react-testing-find :class "load"))
  (react-testing-time-passes)                ; the pause before the request
  (let ((asked (react-testing-answer-fetch 200 "[{\"text\":\"Simple things should be simple.\",\"author\":\"Alan Kay\"}]")))
    (should (string-match-p "quotes.json" (plist-get asked :url))))
  (react-testing-time-passes)
  (should (equal (react-testing-text (react-testing-find :class "status")) "loaded"))
  (should (equal (react-testing-text (react-testing-find :tag 'cite)) "Alan Kay")))
