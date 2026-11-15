;;; app.el --- a page under a strict Content-Security-Policy  -*- lexical-binding: t; -*-
(react-define-component 'Strict
  :initial-state (lambda (_props) (list :n 0))
  :render (lambda (self)
            (jsx (div (p (:class "styled" :style (list :color "rgb(0, 128, 0)" :width 120)) "styled")
                      (button (:class "count" :on-click (lambda (_event) (react-set-state self :n (1+ (react-state self :n)))))
                              (format "%d" (react-state self :n)))))))
(react-mount '(Strict) "#app")
