;;; counters.el --- state in a parent, props to the children  -*- lexical-binding: t; -*-

;; The parent owns the list of counters.  Each row is a component without
;; state: it gets its numbers as props and reports clicks through functions
;; it was handed (data down, events up).  The state is never modified in
;; place: every change builds a new list.

(require 'seq)
(require 'subr-x)

(react-define-component 'counter-row
  :render
  (lambda (self)
    (let ((index (react-props self :index)))
      `(div (:class "row")
         (p (:class "name") ,(format "%s: %d" (react-props self :name) (react-props self :count)))
         (button (:class "increment" :on-click ,(lambda (_event) (funcall (react-props self :on-add) index 1))) "+1")
         (button (:class "decrement" :on-click ,(lambda (_event) (funcall (react-props self :on-add) index -1))) "-1")
         (button (:class "remove" :on-click ,(lambda (_event) (funcall (react-props self :on-remove) index))) "remove")))))

(react-define-component 'counters
  :initial-state
  (lambda (_props) (list :counters '((:name "Apples" :count 3) (:name "Oranges" :count 0)) :draft ""))
  :render
  (lambda (self)
    (let* ((counters (react-state self :counters))
           (add (lambda (index amount)
                  (react-set-state
                   self :counters
                   (seq-map-indexed (lambda (counter i)
                                      (if (= i index)
                                          (list :name (plist-get counter :name)
                                                :count (+ amount (plist-get counter :count)))
                                        counter))
                                    (react-state self :counters)))))
           (remove (lambda (index)
                     (react-set-state
                      self :counters
                      (seq-remove #'null
                                  (seq-map-indexed (lambda (counter i) (and (/= i index) counter))
                                                   (react-state self :counters))))))
           (create (lambda (_event)
                     (let ((name (string-trim (react-state self :draft))))
                       (unless (string-empty-p name)
                         (react-set-state self
                                          :counters (append (react-state self :counters)
                                                            (list (list :name name :count 0)))
                                          :draft ""))))))
      `(main ()
         (h1 () "Counters")
         (p (:class "total")
            ,(format "%d counters, total %d" (length counters)
                     (apply #'+ (mapcar (lambda (counter) (plist-get counter :count)) counters))))
         ,(seq-map-indexed (lambda (counter index)
                             `(counter-row (:index ,index :name ,(plist-get counter :name)
                                            :count ,(plist-get counter :count)
                                            :on-add ,add :on-remove ,remove)))
                           counters)
         (form (:class "row" :on-submit ,create)
           (input (:class "draft" :placeholder "new counter" :value ,(react-state self :draft)
                   :on-input ,(lambda (event) (react-set-state self :draft (plist-get event :value)))))
           (button (:class "create" :disabled ,(string-empty-p (string-trim (react-state self :draft))))
             "add"))))))

(react-mount '(counters) "#app")
