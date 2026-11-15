;;; app.el --- a page whose Lisp is compiled ahead of time  -*- lexical-binding: t; -*-
(react-define-component 'Precompiled
  :render (lambda (_self) (jsx (p (:class "greeting") "compiled before the visit"))))
(react-mount '(Precompiled) "#app")
