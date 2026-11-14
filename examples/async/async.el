;;; async.el --- timers and requests  -*- lexical-binding: t; -*-

;; Emacs Lisp runs only while it answers the page, so it cannot wait.  A
;; component asks the page instead: "call me in a second", "fetch this".
;; The page does it and calls the Lisp function when there is something to
;; say; the function changes state, and the component renders again.

(require 'seq)

;;;; A clock: an interval that lives as long as the component

(react-define-component 'Clock
  :initial-state (lambda (_props) (list :ticks 0 :time (format-time-string "%H:%M:%S" nil t) :timer nil))
  :did-mount
  (lambda (self)
    (react-set-state
     self :timer
     (react-set-interval 1000 (lambda ()
                                (react-set-state self
                                                 :ticks (1+ (react-state self :ticks))
                                                 :time (format-time-string "%H:%M:%S" nil t))))))
  ;; Without this the page would keep calling a clock that is gone.
  :will-unmount (lambda (self) (react-clear-timer (react-state self :timer)))
  :render
  (lambda (self)
    (jsx (p (:class "clock")
           (span (:class "time") (react-state self :time))
           " UTC, "
           (span (:class "ticks") (format "%d ticks" (react-state self :ticks)))))))

;;;; A timeout: something that happens later, once (with a callback)

(react-define-component 'Reminder
  :initial-state (lambda (_props) (list :status "idle"))
  :render
  (lambda (self)
    (jsx (div (:class "row")
           (button (:class "remind" :disabled (equal (react-state self :status) "waiting")
                    :on-click (lambda (_event)
                                (react-set-state self :status "waiting")
                                (react-set-timeout 700 (lambda () (react-set-state self :status "done")))))
             "remind me in 0.7 s")
           (span (:class "reminder")
             (pcase (react-state self :status)
               ("waiting" "waiting…")
               ("done" "Time is up.")
               (_ "")))))))

;;;; The same, written top to bottom: async / await

;; `react-async' runs its body until the first `react-await', gives control
;; back to the page, and continues when the page answers.  A loop with a
;; pause in it reads like a loop.

(react-define-component 'Countdown
  :initial-state (lambda (_props) (list :left nil))
  :render
  (lambda (self)
    (jsx (div (:class "row")
           (button (:class "launch" :disabled (numberp (react-state self :left))
                    :on-click (lambda (_event)
                                (react-async
                                  (dotimes (i 3)
                                    (react-set-state self :left (- 3 i))
                                    (react-await (react-sleep 400)))
                                  (react-set-state self :left 'liftoff))))
             "count down")
           (span (:class "countdown")
             (pcase (react-state self :left)
               ('nil "")
               ('liftoff "Lift-off!")
               (n (format "%d…" n))))))))

;;;; A request: loading, then data or an error

(react-define-component 'Quotes
  :initial-state (lambda (_props) (list :status 'idle :quotes [] :error nil))
  :render
  (lambda (self)
    (let ((fetch-quotes
           (lambda (url)
             (react-async
               (react-set-state self :status 'loading :error nil)
               (condition-case failure
                   (let ((response (react-await (react-fetch-async url))))
                     (if (plist-get response :ok)
                         (react-set-state self :status 'loaded :quotes (react-response-json response))
                       (react-set-state self :status 'failed
                                        :error (format "HTTP %d" (plist-get response :status)))))
                 ;; No response at all (offline, a refused connection).
                 (react-async-error
                  (react-set-state self :status 'failed :error (cadr failure))))))))
      (jsx (section (:class "quotes")
             (div (:class "row")
               (button (:class "load" :on-click (lambda (_event) (funcall fetch-quotes "quotes.json"))) "load quotes")
               (button (:class "load-missing" :on-click (lambda (_event) (funcall fetch-quotes "no-such-file.json")))
                 "load a file that is not there")
               (span (:class "status") (symbol-name (react-state self :status))))
             (pcase (react-state self :status)
               ('failed (jsx (p (:class "error") (react-state self :error))))
               ('loaded (jsx (ul (:class "quote-list")
                               (seq-map (lambda (entry)
                                          (jsx (li (:key (plist-get entry :id))
                                                 (q (plist-get entry :text))
                                                 " " (cite (plist-get entry :author)))))
                                        (react-state self :quotes)))))))))))

;;;; The page

(react-define-component 'App
  :initial-state (lambda (_props) (list :clock t))
  :render
  (lambda (self)
    (jsx (main
           (h1 "Time and requests")
           (div (:class "row")
             (label
               (input (:class "show-clock" :type "checkbox" :checked (react-state self :clock)
                       :on-change (lambda (event) (react-set-state self :clock (plist-get event :checked)))))
               " clock"))
           (and (react-state self :clock) (jsx (Clock)))
           (Reminder)
           (Countdown)
           (Quotes)))))

(react-mount (jsx (App)) "#app")
