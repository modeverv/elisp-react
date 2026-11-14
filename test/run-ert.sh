#!/usr/bin/env bash
# Run the Emacs Lisp tests of react.el with a native Emacs (no browser).
#   test/run-ert.sh            uses $EMACS, or "emacs" on PATH, or a macOS app
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
emacs_bin="$("${here}/tools/find-emacs.sh")"
exec "${emacs_bin}" --batch -Q -L "${here}/lisp" -L "${here}/test" \
  --eval '(setq byte-compile-error-on-warn t)' \
  --eval "(unless (byte-compile-file \"${here}/lisp/react.el\") (kill-emacs 1))" \
  --eval "(delete-file \"${here}/lisp/react.elc\")" \
  -l react-test -f ert-run-tests-batch-and-exit
