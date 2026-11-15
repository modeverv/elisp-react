# Security review — 2026-11-15

Scope: the browser host, Lisp data boundaries, native example server, and
development static server at baseline `bb0d3a2`. Page-authored Lisp and host
configuration are trusted code. Reproductions use temporary synthetic data.

## Milestones

- [x] #1: confine development static serving to public files inside its root
  (PR #4 merged as `3622430`, GitHub CI succeeded).
- [x] #2: prevent native static routes from exposing persisted notes or hidden files
  (PR #5 merged as `5e31ad7`, GitHub CI succeeded).
- [x] #3: prevent ordinary DOM attributes from turning input data into script
  (implemented and validated in this change).

Each confirmed issue gets its own branch and PR, regression coverage, an
independent review, passing checks, and a merge before the next fix starts.
GitHub issues and their linked PRs record the final merge/check status.

## Validation

- Baseline: `npm run test:lisp` — 33/33 passed.
- #1: `npm test` passed: static HTTP regressions 9/9, ERT 33/33,
  Chrome examples and native-server/Chrome integration. Independent review
  found an APFS case-alias bypass in the first exclusion implementation;
  native realpath canonicalization fixes it and the focused 9/9 suite passes
  with uppercase private/public alias controls. Private server notes are
  explicitly excluded by `tools/serve.mjs`.
- #2: `npm test` passed: native HTTP regressions 9/9, static HTTP 9/9,
  ERT 33/33, Chrome examples and native-server/Chrome integration. Fixtures
  cover cross-site requests, symlink/index/hardlink and APFS case aliases,
  encoded mount paths, backups after the original is deleted, and normal
  note writes. Public wasmacs assets retain their cross-origin delivery.
  Independent review additionally reproduced NFC/NFD filename aliases for
  backups with a missing original on APFS; existing backup-file identities
  now enforce that boundary without conflating distinct Linux filenames.
- #3: `npm test` passed: DOM policy 3/3, both HTTP suites 9/9 each, ERT
  33/33, Chrome examples including the real Lisp-to-DOM attack regressions,
  and native-server/Chrome integration. The new browser check fails against
  the original renderer. With the fix, markers never execute, rejected
  updates remove old attributes, and normal links, callbacks, text, data
  images and subsequent renders continue. The host remains a single JS file
  for compatibility with applications that copy it during export.
- Run the focused security regression tests added with each fix.
- Run `npm test` for the integrated native Emacs and real Chrome examples.
- Check PR CI and the merged default-branch revision on GitHub.

## Evidence and limits

- #1: temporary `.git/config` and a symlink to an outside marker both returned
  HTTP 200 with permissive CORS from the development server.
- #2: other-site requests received 403 for `/api/notes`, but 200 for the
  persisted notes file and a visible symlink to a hidden file.
- #3: real Chrome executed harmless markers from `javascript:` links, inline
  event attributes, and iframe `srcdoc` passed through the renderer.
- Runtime URL selection, source hashing/quoting, and source/bytecode loading
  were also inspected; no independent additional exploit was established.
- This review does not establish the absence of all security defects or make
  the example server suitable for untrusted public hosting.
