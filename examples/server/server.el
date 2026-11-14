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
     ;; The text becomes data.  Nothing is evaluated.
     (elisp-react-server--save-notes
      (notes-apply (elisp-react-server--notes) (elisp-react-server--data body))))
    ('("GET" "/api/buffers")
     (mapcar (lambda (buffer) (list :name (buffer-name buffer) :size (buffer-size buffer)))
             (cl-remove-if (lambda (buffer) (string-prefix-p " " (buffer-name buffer))) (buffer-list))))
    (_ (signal 'file-missing (list "No such API" path)))))

;;;; What a page sends

(defun elisp-react-server--data (text)
  "The Lisp data that TEXT, the body of a request, is the printed form of.
Strings, numbers, lists, vectors, and symbols this Emacs already knows.
Emacs's reader alone would keep every new name in TEXT as a symbol for
good: a page could fill this Emacs's memory with names.  So the text is
read into an obarray of its own, and only names known here come through."
  (let* ((value (let ((obarray (obarray-make 31)))
                  (car (read-from-string text))))
         (left 100000))
    (cl-labels
        ((clean (data depth)
           (when (or (> depth 64) (< (setq left (1- left)) 0)) (error "The request holds too much data"))
           (cond ((stringp data) (substring-no-properties data))
                 ((numberp data) data)
                 ((symbolp data)
                  (cond ((equal (symbol-name data) "nil") nil)
                        ((intern-soft (symbol-name data)))
                        (t (error "The request names something unknown"))))
                 ((consp data)
                  (let ((result nil))
                    (while (consp data)
                      (push (clean (car data) (1+ depth)) result)
                      (setq data (cdr data))
                      (when (< (setq left (1- left)) 0) (error "The request holds too much data")))
                    (let ((list (nreverse result)))
                      (when data (setcdr (last list) (clean data (1+ depth))))
                      list)))
                 ((and (vectorp data) (not (byte-code-function-p data)))
                  (apply #'vector (mapcar (lambda (element) (clean element (1+ depth))) data)))
                 (t (error "The request holds something that is not data")))))
      (clean value 0))))

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
         (root (file-name-as-directory (if wasmacs elisp-react-server-wasmacs elisp-react-server-root)))
         ;; Emacs can take names like /ssh:host:/file for files on other
         ;; machines (and would connect there).  Not here: a name in a
         ;; request is a file under ROOT or nothing.
         (file-name-handler-alist nil)
         (file (and (not (string-match-p "[\0-\x1f\x7f]" path))
                    (expand-file-name (substring path (if wasmacs (length "/wasmacs/") 1)) root))))
    (when (equal file (directory-file-name root)) (setq file root))
    ;; The name is judged before the disk is asked anything about it:
    ;; nothing outside the served directory, nothing hidden.
    (and file
         (string-prefix-p root file)
         (not (string-match-p "\\(?:\\`\\|/\\)\\." (substring file (length root))))
         (progn (when (file-directory-p file) (setq file (expand-file-name "index.html" file)))
                (file-regular-p file))
         (string-prefix-p (file-truename root) (file-truename file))
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
    (and (not (equal (cdr (assoc "sec-fetch-site" headers)) "cross-site"))
         (or (null origin)
             (member origin (list (format "http://127.0.0.1:%d" elisp-react-server-port)
                                  (format "http://localhost:%d" elisp-react-server-port)))))))

(defun elisp-react-server--own-host-p (headers)
  "Non-nil if the request was made to this server under its own name.
A page of another site can make its own name point to this machine (DNS
rebinding); its requests carry that name in Host."
  (let ((host (cdr (assoc "host" headers))))
    (or (null host)
        (member (downcase host) (list (format "127.0.0.1:%d" elisp-react-server-port)
                                      (format "localhost:%d" elisp-react-server-port))))))

(defun elisp-react-server--handle (process method target headers body)
  (let ((path (car (split-string target "?"))))
    (message "elisp-react-server: %s %s" method (replace-regexp-in-string "[^!-~]" "?" path))
    (cond
     ((not (elisp-react-server--own-host-p headers))
      (elisp-react-server--respond process "421 Misdirected Request" "text/plain" "this server is not that host"))
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
        ;; The number is the length of the queue of connections that wait to
        ;; be accepted (Emacs's default, 5, turns a burst of requests away).
        (make-network-process :name "elisp-react-server" :server 256 :host "127.0.0.1" :family 'ipv4
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
