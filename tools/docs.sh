#!/bin/sh
# doc/api.md and its Japanese translation doc/api.ja.md as the web pages
# api/ and api/ja/ of the site (tools/api-doc.mjs).  A link to an anchor
# that is not there stops it.
#   tools/docs.sh OUT-DIR [--commit SHA]
set -eu
cd "$(dirname "$0")/.."
out="${1:?usage: tools/docs.sh OUT-DIR [--commit SHA]}"; shift
doc="node tools/api-doc.mjs --repo modeverv/elisp-react --version main"
$doc "$@" --in doc/api.md --out "$out/api/index.html" --title "elisp-react API" \
  --alt "日本語=ja/" --nav "elisp-next API=https://modeverv.github.io/elisp-next/api/" --nav "Examples=../"
$doc "$@" --in doc/api.ja.md --out "$out/api/ja/index.html" --title "elisp-react API（日本語）" --lang ja \
  --link "doc/api.md=../" --alt "English=../" \
  --nav "elisp-next API=https://modeverv.github.io/elisp-next/api/ja/" --nav "サンプル=../../"
