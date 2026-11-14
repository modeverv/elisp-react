;;; notes.el --- the notes, as both sides know them  -*- lexical-binding: t; -*-

;; This file is loaded twice: by the Emacs that is the server (server.el)
;; and by the Emacs in the browser (app.el).  The functions are pure: they
;; take a list of notes, (:id N :text STRING :done BOOLEAN), and return a new
;; list.  The server applies them to the list it keeps; the page uses the
;; same check to decide whether a note may be sent at all.

(require 'seq)
(require 'subr-x)

(defconst notes-max-length 200 "The longest text a note may have.")

(defun notes-valid-text-p (text)
  "Non-nil if TEXT can be the text of a note."
  (and (stringp text)
       (not (string-empty-p (string-trim text)))
       (<= (length (string-trim text)) notes-max-length)))

(defun notes-add (notes text)
  "NOTES with a new note for TEXT at the end."
  (let ((id (1+ (apply #'max 0 (mapcar (lambda (note) (plist-get note :id)) notes)))))
    (append notes (list (list :id id :text (string-trim text) :done nil)))))

(defun notes-toggle (notes id)
  "NOTES with the note ID done if it was not, and the other way round."
  (mapcar (lambda (note)
            (if (eql (plist-get note :id) id)
                (list :id id :text (plist-get note :text) :done (not (plist-get note :done)))
              note))
          notes))

(defun notes-remove (notes id)
  "NOTES without the note ID."
  (seq-remove (lambda (note) (eql (plist-get note :id) id)) notes))

(defun notes-apply (notes action)
  "NOTES after ACTION: (add TEXT), (toggle ID) or (remove ID).
Signals an error for anything else."
  (pcase action
    (`(add ,(and text (pred notes-valid-text-p))) (notes-add notes text))
    (`(toggle ,(and id (pred integerp))) (notes-toggle notes id))
    (`(remove ,(and id (pred integerp))) (notes-remove notes id))
    (_ (error "Not a notes action: %S" action))))

(provide 'notes)
;;; notes.el ends here
