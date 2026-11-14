#!/usr/bin/env bash
# Run the Emacs Lisp tests of react.el with a native Emacs (no browser).
#   test/run-ert.sh            uses $EMACS, or "emacs" on PATH, or a macOS app
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
emacs_bin="${EMACS:-}"
if [ -z "${emacs_bin}" ]; then
  # An "emacs" on PATH that is a link into a macOS app bundle does not start;
  # take the first candidate that really runs.
  for candidate in "$(command -v emacs || true)" \
                   /Applications/Emacs.app/Contents/MacOS/Emacs \
                   /Applications/Emacs-takaxp/Emacs.app/Contents/MacOS/Emacs; do
    if [ -n "${candidate}" ] && [ -x "${candidate}" ] \
       && "${candidate}" --batch -Q --eval t >/dev/null 2>&1; then
      emacs_bin="${candidate}"; break
    fi
  done
fi
[ -n "${emacs_bin}" ] || { echo "no Emacs found; set EMACS" >&2; exit 127; }
exec "${emacs_bin}" --batch -Q -L "${here}/lisp" -L "${here}/test" \
  --eval '(setq byte-compile-error-on-warn t)' \
  --eval "(unless (byte-compile-file \"${here}/lisp/react.el\") (kill-emacs 1))" \
  --eval "(delete-file \"${here}/lisp/react.elc\")" \
  -l react-test -f ert-run-tests-batch-and-exit
