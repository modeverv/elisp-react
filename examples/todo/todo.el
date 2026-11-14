;;; todo.el --- a TODO list  -*- lexical-binding: t; -*-

;; Written with the `jsx' macro: markup needs no backquote and no commas;
;; everything that is not a tag or a Capitalized component is ordinary Lisp.
;;
;; The rows have a :key (the todo's id).  A row therefore stays the same row
;; when others are added, removed, filtered away or moved: it keeps its DOM
;; node, and its own state (the text being edited) stays with it.
;;
;; The todos are plists in a list.  Nothing is modified in place: every
;; action computes a new list (`mapcar', `seq-remove', `react-plist-with').
;;
;; The list is kept in the page's localStorage, and starting to edit a row
;; moves the keyboard focus into its text field: both are requests to the
;; page, made after a render (:did-update).

(require 'seq)
(require 'subr-x)

;;;; The data: pure functions from a list of todos to a new list

(defun todo-change (todos id function)
  "TODOS with FUNCTION applied to the todo ID."
  (mapcar (lambda (todo) (if (= (plist-get todo :id) id) (funcall function todo) todo)) todos))

(defun todo-move-before (todos id before-id)
  "TODOS with the todo ID moved in front of the todo BEFORE-ID."
  (let ((moving (seq-find (lambda (todo) (= (plist-get todo :id) id)) todos)))
    (seq-mapcat (lambda (todo)
                  (cond ((= (plist-get todo :id) id) nil)
                        ((= (plist-get todo :id) before-id) (list moving todo))
                        (t (list todo))))
                todos)))

(defun todo-visible (todos filter)
  (pcase filter
    ('active (seq-remove (lambda (todo) (plist-get todo :done)) todos))
    ('done (seq-filter (lambda (todo) (plist-get todo :done)) todos))
    (_ todos)))

;;;; One row

(react-define-component 'TodoItem
  ;; Its own state: whether it is being edited, and the text typed so far.
  :initial-state (lambda (_props) (list :editing nil :draft ""))
  ;; When editing has just begun, the text field is on the page now.
  :did-update (lambda (self _previous-props previous-state)
                (when (and (react-state self :editing) (not (plist-get previous-state :editing)))
                  (react-focus self "edit")
                  (react-invoke self "edit" "select")))
  :render
  (lambda (self)
    (let* ((todo (react-props self :todo))
           (id (plist-get todo :id))
           (act (react-props self :on-action)))
      (if (react-state self :editing)
          (jsx (li (:class "todo editing")
                 (form (:class "edit"
                        :on-submit (lambda (_event)
                                     (funcall act 'rename id (react-state self :draft))
                                     (react-set-state self :editing nil)))
                   (input (:class "edit-text" :ref "edit" :value (react-state self :draft)
                           :on-input (lambda (event) (react-set-state self :draft (plist-get event :value)))))
                   (button (:class "save") "save")
                   (button (:class "cancel" :type "button"
                            :on-click (lambda (_event) (react-set-state self :editing nil)))
                     "cancel"))))
        (jsx (li (:class (if (plist-get todo :done) "todo done" "todo"))
               (input (:class "toggle" :type "checkbox" :checked (plist-get todo :done)
                       :on-change (lambda (_event) (funcall act 'toggle id))))
               (span (:class "text") (plist-get todo :text))
               (button (:class "edit-button"
                        :on-click (lambda (_event)
                                    (react-set-state self :editing t :draft (plist-get todo :text))))
                 "edit")
               (button (:class "up" :disabled (not (react-props self :previous))
                        :on-click (lambda (_event) (funcall act 'move-before id (react-props self :previous))))
                 "↑")
               (button (:class "delete" :on-click (lambda (_event) (funcall act 'delete id))) "×")))))))

;;;; The application

(react-define-component 'TodoApp
  :initial-state
  (lambda (_props)
    ;; What was saved the last time, or a list to start with.
    (let ((todos (react-storage-get "todos"
                                    '((:id 1 :text "Write React in Emacs Lisp" :done t)
                                      (:id 2 :text "Give the rows keys" :done nil)
                                      (:id 3 :text "Try it in a browser" :done nil)))))
      (list :todos todos
            :next-id (1+ (apply #'max 0 (mapcar (lambda (todo) (plist-get todo :id)) todos)))
            :filter 'all
            :draft "")))
  :did-mount (lambda (self) (react-focus self "new"))
  ;; Every change of the list is saved.
  :did-update (lambda (self _previous-props previous-state)
                (unless (eq (react-state self :todos) (plist-get previous-state :todos))
                  (react-storage-set "todos" (react-state self :todos))))
  :render
  (lambda (self)
    (let* ((todos (react-state self :todos))
           (filter (react-state self :filter))
           (visible (todo-visible todos filter))
           (left (length (todo-visible todos 'active)))
           (done (- (length todos) left))
           ;; What a row can ask for.  The state is read when the action
           ;; runs, not when this function was made.
           (act (lambda (action id &optional argument)
                  (react-set-state
                   self :todos
                   (let ((todos (react-state self :todos)))
                     (pcase action
                       ('toggle (todo-change todos id (lambda (todo)
                                                        (react-plist-with todo :done (not (plist-get todo :done))))))
                       ('rename (if (string-empty-p (string-trim argument))
                                    todos
                                  (todo-change todos id (lambda (todo)
                                                          (react-plist-with todo :text (string-trim argument))))))
                       ('delete (seq-remove (lambda (todo) (= (plist-get todo :id) id)) todos))
                       ('move-before (todo-move-before todos id argument)))))))
           (add (lambda (_event)
                  (let ((text (string-trim (react-state self :draft))))
                    (unless (string-empty-p text)
                      (react-set-state self
                                       :todos (append (react-state self :todos)
                                                      (list (list :id (react-state self :next-id) :text text :done nil)))
                                       :next-id (1+ (react-state self :next-id))
                                       :draft "")))))
           (filter-button (lambda (name label)
                            (jsx (button (:class (if (eq filter name) "filter selected" "filter")
                                          :data-filter (symbol-name name)
                                          :on-click (lambda (_event) (react-set-state self :filter name)))
                                   label))))
           (previous nil))
      (jsx (main
             (h1 "todos")
             (form (:class "new" :on-submit add)
               (input (:class "new-text" :ref "new" :placeholder "What needs to be done?"
                       :value (react-state self :draft)
                       :on-input (lambda (event) (react-set-state self :draft (plist-get event :value)))))
               (button (:class "add" :disabled (string-empty-p (string-trim (react-state self :draft)))) "add"))
             (ul (:class "todos")
               (mapcar (lambda (todo)
                         (prog1 (jsx (TodoItem (:key (plist-get todo :id) :todo todo
                                                :previous previous :on-action act)))
                           (setq previous (plist-get todo :id))))
                       visible))
             (footer (:class "status")
               (span (:class "left") (format "%d %s left" left (if (= left 1) "item" "items")))
               (funcall filter-button 'all "all")
               (funcall filter-button 'active "active")
               (funcall filter-button 'done "done")
               (and (> done 0)
                    (jsx (button (:class "clear"
                                  :on-click (lambda (_event)
                                              (react-set-state self :todos
                                                               (todo-visible (react-state self :todos) 'active))))
                           (format "clear done (%d)" done))))))))))

(react-mount (jsx (TodoApp)) "#app")
