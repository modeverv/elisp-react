;;; counter.el --- the first elisp-react page  -*- lexical-binding: t; -*-

;; A component with state.  The element it renders is plain Lisp data, built
;; with backquote; the click handler is a closure over the instance.

(react-define-component 'counter
  :initial-state (lambda (props) (list :count (or (plist-get props :start) 0)))
  :render
  (lambda (self)
    (let ((count (react-state self :count)))
      `(div (:class "counter")
         (p (:class "count") ,(format "%s: %d" (react-props self :label) count))
         (button (:class "increment"
                  :on-click ,(lambda (_event)
                               (react-set-state self :count (1+ (react-state self :count)))))
           "+1")
         (button (:class "reset"
                  :disabled ,(= count 0)
                  :on-click ,(lambda (_event) (react-set-state self :count 0)))
           "reset")))))

(react-define-component 'app
  :render
  (lambda (_self)
    `(main ()
       (h1 () "elisp-react")
       (p () ,(format "Rendered by GNU Emacs %s. Every click runs Emacs Lisp." emacs-version))
       (counter (:label "Apples" :start 3))
       (counter (:label "Oranges")))))

(react-mount '(app) "#app")
