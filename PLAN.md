# Security review — 2026-11-15

Scope: the browser host, Lisp data boundaries, native example server, and
development static server at baseline `bb0d3a2`. Page-authored Lisp and host
configuration are trusted code. Reproductions use temporary synthetic data.

## Milestones

- [x] #1: confine development static serving to public files inside its root
  (implemented and reviewed; PR CI/merge pending).
- [ ] #2: prevent native static routes from exposing persisted notes or hidden files.
- [ ] #3: prevent ordinary DOM attributes from turning input data into script.

Each confirmed issue gets its own branch and PR, regression coverage, an
independent review, passing checks, and a merge before the next fix starts.

## Validation

- Baseline: `npm run test:lisp` — 33/33 passed.
- #1: `npm test` passed: static HTTP regressions 9/9, ERT 33/33,
  Chrome examples and native-server/Chrome integration. Independent review
  found an APFS case-alias bypass in the first exclusion implementation;
  native realpath canonicalization fixes it and the focused 9/9 suite passes
  with uppercase private/public alias controls. Private server notes are
  explicitly excluded by `tools/serve.mjs`.
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
