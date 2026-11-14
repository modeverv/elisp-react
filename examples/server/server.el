;;; server.el --- a web server in Emacs Lisp for the notes example  -*- lexical-binding: t; -*-

;; Emacs on both ends.  This Emacs (a native one: yours, or a batch process
;; started by run.sh) is the server: it serves the page and answers its
;; requests.  The page is drawn by another Emacs, the one that runs in the
;; browser as WebAssembly, with react.el.  They talk in Lisp: requests and
;; responses are printed Lisp data, not JSON.
;;
;;   examples/server/run.sh                 a server of its own, in batch mode
;;   M-x load-file RET server.el RET
;;   M-x elisp-react-server-start           inside the Emacs you are using
;;   M-x elisp-react-server-stop
;;
;;   GET  /api/info      (:emacs "31.1" :pid 123 :uptime 4.2 :system "..." :notes 2)
;;   GET  /api/notes     the list of notes
;;   POST /api/notes     body: an action, (add "text") | (toggle 3) | (remove 3);
;;                       answer: the new list
;;   GET  /api/buffers   the buffers of this Emacs: ((:name "*scratch*" :size 145) ...)
;;   everything else     the files of this repository
;;   /wasmacs/...        ../wasmacs/docs, when that checkout exists
;;
;; The server listens on 127.0.0.1 only.  It never evaluates what it is
;; sent: a request body is `read' as data and has to be one of the three
;; actions.  Requests that a page of another site makes are refused (Origin).

(require 'cl-lib)
(require 'subr-x)

(defconst elisp-react-server--directory
  (file-name-directory (or load-file-name buffer-file-name default-directory)))

(load (expand-file-name "notes.el" elisp-react-server--directory) nil t)

(defvar elisp-react-server-port 8017)
(defvar elisp-react-server-root
  (expand-file-name "../../" elisp-react-server--directory)
  "The repository: what the server serves as files.")
(defvar elisp-react-server-wasmacs
  (expand-file-name "../wasmacs/docs/" elisp-react-server-root)
  "A built wasmacs site, served under /wasmacs/ when it exists.")
(defvar elisp-react-server-data-file
  (expand-file-name "data/notes.eld" elisp-react-server--directory)
  "Where the notes are kept.")

(defvar elisp-react-server--process nil)
(defvar elisp-react-server--started nil)
(defvar elisp-react-server--notes 'unread)

;;;; The notes

(defun elisp-react-server--notes ()
  (when (eq elisp-react-server--notes 'unread)
    (setq elisp-react-server--notes
          (if (file-readable-p elisp-react-server-data-file)
              (with-temp-buffer
                (insert-file-contents elisp-react-server-data-file)
                (read (current-buffer)))
            '((:id 1 :text "This list lives in the server's Emacs" :done nil)
              (:id 2 :text "The page is drawn by another Emacs" :done t)))))
  elisp-react-server--notes)

(defun elisp-react-server--save-notes (notes)
  (setq elisp-react-server--notes notes)
  (make-directory (file-name-directory elisp-react-server-data-file) t)
  (with-temp-file elisp-react-server-data-file
    (let ((print-length nil) (print-level nil))
      (prin1 notes (current-buffer))
      (insert "\n")))
  notes)

;;;; The API: a request to Lisp data, or to (STATUS . MESSAGE)

(defun elisp-react-server--api (method path body)
  "The answer to METHOD PATH with BODY (a string): Lisp data to print.
Signals an error for a request that cannot be answered."
  (pcase (list method path)
    ('("GET" "/api/info")
     (list :emacs emacs-version
           :pid (emacs-pid)
           :uptime (float-time (time-subtract nil elisp-react-server--started))
           :system (format "%s" system-type)
           :batch noninteractive
           :notes (length (elisp-react-server--notes))))
    ('("GET" "/api/notes") (elisp-react-server--notes))
    ('("POST" "/api/notes")
     ;; `read' makes data out of the text.  Nothing is evaluated.
     (elisp-react-server--save-notes
      (notes-apply (elisp-react-server--notes) (car (read-from-string body)))))
    ('("GET" "/api/buffers")
     (mapcar (lambda (buffer) (list :name (buffer-name buffer) :size (buffer-size buffer)))
             (cl-remove-if (lambda (buffer) (string-prefix-p " " (buffer-name buffer))) (buffer-list))))
    (_ (signal 'file-missing (list "No such API" path)))))

;;;; Files

(defconst elisp-react-server--types
  '(("html" . "text/html; charset=utf-8") ("css" . "text/css; charset=utf-8")
    ("js" . "text/javascript") ("mjs" . "text/javascript") ("json" . "application/json")
    ("wasm" . "application/wasm") ("el" . "text/plain; charset=utf-8")
    ("eld" . "text/plain; charset=utf-8") ("md" . "text/plain; charset=utf-8")))

(defun elisp-react-server--file (path)
  "The file that the URL PATH names, or nil."
  (let* ((path (decode-coding-string (url-unhex-string path) 'utf-8))
         (wasmacs (string-prefix-p "/wasmacs/" path))
         (root (if wasmacs elisp-react-server-wasmacs elisp-react-server-root))
         (file (expand-file-name (substring path (if wasmacs (length "/wasmacs/") 1)) root)))
    (when (file-directory-p file) (setq file (expand-file-name "index.html" file)))
    ;; Nothing outside the served directory, nothing hidden.
    (and (string-prefix-p (file-truename root) (file-truename file))
         (not (string-match-p "\\(?:\\`\\|/\\)\\." (file-relative-name file root)))
         (file-regular-p file)
         file)))

;;;; HTTP

(defun elisp-react-server--respond (process status type body &optional headers)
  "Send one response on PROCESS and close it.  BODY is a unibyte string."
  (process-send-string
   process
   (concat (format "HTTP/1.1 %s\r\nContent-Type: %s\r\nContent-Length: %d\r\nCache-Control: no-store\r\nConnection: close\r\n%s\r\n"
                   status type (string-bytes body) (or headers ""))
           body))
  (delete-process process))

(defun elisp-react-server--respond-lisp (process status data)
  (elisp-react-server--respond
   process status "application/x-emacs-lisp; charset=utf-8"
   (encode-coding-string (let ((print-length nil) (print-level nil)) (prin1-to-string data)) 'utf-8)))

(defun elisp-react-server--same-origin-p (headers)
  "Non-nil unless the request comes from a page of another site."
  (let ((origin (cdr (assoc "origin" headers))))
    (or (null origin)
        (member origin (list (format "http://127.0.0.1:%d" elisp-react-server-port)
                             (format "http://localhost:%d" elisp-react-server-port))))))

(defun elisp-react-server--handle (process method target headers body)
  (let ((path (car (split-string target "?"))))
    (message "elisp-react-server: %s %s" method path)
    (cond
     ((string-prefix-p "/api/" path)
      (if (not (elisp-react-server--same-origin-p headers))
          (elisp-react-server--respond-lisp process "403 Forbidden" "requests from other sites are refused")
        (condition-case err
            (elisp-react-server--respond-lisp
             process "200 OK"
             (elisp-react-server--api method path (decode-coding-string body 'utf-8)))
          (file-missing (elisp-react-server--respond-lisp process "404 Not Found" (error-message-string err)))
          (error (elisp-react-server--respond-lisp process "400 Bad Request" (error-message-string err))))))
     ((not (member method '("GET" "HEAD")))
      (elisp-react-server--respond process "405 Method Not Allowed" "text/plain" "method not allowed"))
     (t
      (let ((file (elisp-react-server--file path)))
        (if (not file)
            (elisp-react-server--respond process "404 Not Found" "text/plain" "not found")
          (elisp-react-server--respond
           process "200 OK"
           (or (cdr (assoc (file-name-extension file) elisp-react-server--types)) "application/octet-stream")
           (with-temp-buffer
             (set-buffer-multibyte nil)
             (insert-file-contents-literally file)
             (buffer-string))
           ;; The files of wasmacs are fetched by a worker of the page.
           "Access-Control-Allow-Origin: *\r\n")))))))

(defun elisp-react-server--filter (process chunk)
  "Collect a request on PROCESS; answer it when it is complete."
  (process-put process :input (concat (process-get process :input) chunk))
  (let* ((input (process-get process :input))
         (end (string-search "\r\n\r\n" input)))
    (when end
      (let* ((lines (split-string (substring input 0 end) "\r\n"))
             (request (split-string (car lines) " "))
             (headers (mapcar (lambda (line)
                                (let ((colon (string-search ":" line)))
                                  (cons (downcase (substring line 0 colon))
                                        (string-trim (substring line (1+ (or colon -1)))))))
                              (cdr lines)))
             (length (string-to-number (or (cdr (assoc "content-length" headers)) "0")))
             (body (substring input (+ end 4))))
        (cond ((> length 65536)
               (elisp-react-server--respond process "413 Content Too Large" "text/plain" "too large"))
              ((>= (string-bytes body) length)
               (condition-case err
                   (elisp-react-server--handle process (nth 0 request) (or (nth 1 request) "/") headers
                                               (substring body 0 length))
                 (error
                  (message "elisp-react-server: %s" (error-message-string err))
                  (ignore-errors
                    (elisp-react-server--respond process "500 Internal Server Error" "text/plain" "error"))))))))))

;;;; Start and stop

;;;###autoload
(defun elisp-react-server-start ()
  "Serve the notes example on http://127.0.0.1:`elisp-react-server-port'."
  (interactive)
  (elisp-react-server-stop)
  (setq elisp-react-server--started (current-time)
        elisp-react-server--notes 'unread
        elisp-react-server--process
        (make-network-process :name "elisp-react-server" :server t :host "127.0.0.1" :family 'ipv4
                              :service elisp-react-server-port :coding 'binary :noquery t
                              :filter #'elisp-react-server--filter))
  (let ((url (format "http://127.0.0.1:%d/examples/server/" elisp-react-server-port)))
    (message "elisp-react-server: %s%s" url
             (if (file-exists-p (expand-file-name "app/src/emacs-eval-client.js" elisp-react-server-wasmacs))
                 (format "?wasmacs=http://127.0.0.1:%d/wasmacs/" elisp-react-server-port)
               ""))))

(defun elisp-react-server-stop ()
  "Stop the server."
  (interactive)
  (when (process-live-p elisp-react-server--process)
    (delete-process elisp-react-server--process))
  (setq elisp-react-server--process nil))

(defun elisp-react-server-run ()
  "Start the server and serve until Emacs is killed (for batch mode)."
  (elisp-react-server-start)
  (while t (accept-process-output nil 1)))

(provide 'elisp-react-server)
;;; server.el ends here
