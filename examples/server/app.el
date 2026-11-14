;;; app.el --- the page of the notes example  -*- lexical-binding: t; -*-

;; Emacs on both ends.  This file runs in the Emacs in the browser and draws
;; the page with react.el.  The notes live in another Emacs, the server
;; (server.el), which this page asks over HTTP.  Both speak Lisp: a request
;; body is a printed action like (add "text"), a response is printed data,
;; and `read' turns it back.  notes.el is loaded on both sides.

(require 'seq)
(require 'subr-x)

;;;; Talking to the server

(defun api (method path &optional data)
  "An awaitable for a request to the server.  Its value is Lisp data.
DATA, if given, is printed as the request body.  The await signals
`react-async-error' when the server refuses or cannot be reached."
  (lambda (resolve reject)
    (react-fetch path
                 :method method
                 :headers '(:content-type "application/x-emacs-lisp")
                 :body (and data (prin1-to-string data))
                 :then (lambda (response)
                         (let ((value (car (read-from-string (plist-get response :text)))))
                           (if (plist-get response :ok)
                               (funcall resolve value)
                             (funcall reject (format "%s (HTTP %d)" value (plist-get response :status))))))
                 :catch reject)))

;;;; The two Emacsen

(react-define-component 'Emacsen
  :initial-state (lambda (_props) (list :server nil :timer nil))
  :did-mount
  (lambda (self)
    (let ((ask (lambda ()
                 (react-async
                   (condition-case nil
                       (react-set-state self :server (react-await (api "GET" "/api/info")))
                     (react-async-error (react-set-state self :server 'unreachable)))))))
      (funcall ask)
      (react-set-state self :timer (react-set-interval 2000 ask))))
  :will-unmount (lambda (self) (react-clear-timer (react-state self :timer)))
  :render
  (lambda (self)
    (let ((server (react-state self :server)))
      (jsx (table (:class "emacsen")
             (tbody
               (tr (th "this page")
                   (td (:class "page-emacs")
                     (format "GNU Emacs %s, WebAssembly, in your browser" emacs-version)))
               (tr (th "the server")
                   (td (:class "server-emacs")
                     (pcase server
                       ('nil "asking…")
                       ('unreachable "not reachable")
                       (_ (format "GNU Emacs %s on %s, process %d, %s, up %d s"
                                  (plist-get server :emacs) (plist-get server :system)
                                  (plist-get server :pid)
                                  (if (plist-get server :batch) "batch" "interactive")
                                  (plist-get server :uptime))))))))))))

;;;; The notes

(react-define-component 'Note
  :should-update (lambda (self previous-props _previous-state)
                   (react-changed-p (react-props self) previous-props :note))
  :render
  (lambda (self)
    (let* ((note (react-props self :note))
           (send (lambda (action) (funcall (react-props self :on-action) action))))
      (jsx (li (:class (if (plist-get note :done) "todo done" "todo"))
             (input (:class "toggle" :type "checkbox" :checked (plist-get note :done)
                     :on-change (lambda (_event) (funcall send (list 'toggle (plist-get note :id))))))
             (span (:class "text") (plist-get note :text))
             (button (:class "delete" :on-click (lambda (_event) (funcall send (list 'remove (plist-get note :id)))))
               "×"))))))

(react-define-component 'Notes
  :initial-state (lambda (_props) (list :notes nil :loaded nil :draft "" :error nil :timer nil))
  :did-mount
  (lambda (self)
    (let ((refresh (lambda ()
                     (react-async
                       (condition-case failure
                           (react-set-state self :notes (react-await (api "GET" "/api/notes"))
                                            :loaded t :error nil)
                         (react-async-error (react-set-state self :error (cadr failure))))))))
      (funcall refresh)
      ;; Other pages (and curl) change the list too.
      (react-set-state self :timer (react-set-interval 2000 refresh))
      (react-focus self "draft")))
  :will-unmount (lambda (self) (react-clear-timer (react-state self :timer)))
  :render
  (lambda (self)
    (let* ((notes (react-state self :notes))
           (draft (react-state self :draft))
           ;; The server applies the action and answers with the new list.
           (send (lambda (action)
                   (react-async
                     (condition-case failure
                         (react-set-state self :notes (react-await (api "POST" "/api/notes" action))
                                          :error nil)
                       (react-async-error (react-set-state self :error (cadr failure))))))))
      (jsx (section (:class "notes")
             (form (:class "new"
                    :on-submit (lambda (_event)
                                 ;; The same check the server makes (notes.el).
                                 (when (notes-valid-text-p (react-state self :draft))
                                   (funcall send (list 'add (react-state self :draft)))
                                   (react-set-state self :draft ""))))
               (input (:class "new-text" :ref "draft" :placeholder "A note for the server" :value draft
                       :on-input (lambda (event) (react-set-state self :draft (plist-get event :value)))))
               (button (:class "add" :disabled (not (notes-valid-text-p draft))) "add"))
             (and (react-state self :error) (jsx (p (:class "error") (react-state self :error))))
             (if (not (react-state self :loaded))
                 (jsx (p (:class "status") "loading…"))
               (jsx (ul (:class "todos")
                      (mapcar (lambda (note) (jsx (Note (:key (plist-get note :id) :note note :on-action send))))
                              notes))))
             (p (:class "status")
               (format "%d notes, %d done. Kept by the server in examples/server/data/notes.eld."
                       (length notes) (seq-count (lambda (note) (plist-get note :done)) notes))))))))

;;;; The page

(react-define-component 'App
  :render
  (lambda (_self)
    (jsx (main
           (h1 "Emacs on both ends")
           (p "The page is rendered by Emacs Lisp in your browser. The notes are kept by "
              "an Emacs process on this machine, which is also the web server. "
              "They exchange Lisp data.")
           (Emacsen)
           (Notes)))))

(react-mount (jsx (App)) "#app")
