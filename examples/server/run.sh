#!/usr/bin/env bash
# Start the notes server in an Emacs of its own (batch mode).
#   examples/server/run.sh [PORT]
# Stop it with C-c.  To run it inside the Emacs you are using instead, see
# the top of server.el.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
emacs_bin="$("${here}/../../tools/find-emacs.sh")"
# Emacs in batch mode dies of SIGPIPE, the signal for writing to a
# connection that the other side has closed.  Ignored here, it stays ignored
# in Emacs, which then gets an ordinary error for that connection.
trap '' PIPE
exec "${emacs_bin}" --batch -Q \
  --eval "(setq elisp-react-server-port ${1:-8017})" \
  ${ELISP_REACT_SERVER_DATA:+--eval "(setq elisp-react-server-data-file \"${ELISP_REACT_SERVER_DATA}\")"} \
  -l "${here}/server.el" -f elisp-react-server-run
