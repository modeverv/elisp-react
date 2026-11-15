// Compile a page's Emacs Lisp ahead of time, so that its first visit
// compiles nothing.
//
//   node tools/compile.mjs [-o compiled.json] [--library lisp/react.el] FILE.el...
//
// FILE.el... are the page's Lisp files in the order the page loads them.
// The output is a manifest the page names with
// <meta name="elisp-react:compiled" content="compiled.json">: for each file,
// its byte code under the hash the host computes (Emacs's version, the
// hash of the file loaded before, the source).  A file whose hash differs
// in the page (another react.el, an edited file) is compiled there as
// before.
//
// Byte code belongs to an Emacs version, so this compiles in the Emacs the
// page runs, WebAssembly Emacs 30.2 under Node, from a wasmacs checkout next
// to this one (../wasmacs, or $WASMACS).
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
let output = null, library = `${root}lisp/react.el`;
const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "-o") output = args[++i];
  else if (args[i] === "--library") library = args[++i];
  else files.push(args[i]);
}
const wasmacs = process.env.WASMACS || `${root}../wasmacs`;
const { evalService, docsArtifactDir } = await import(`${wasmacs}/tools/scripts/lib/pdump-node-harness.mjs`);
const { service, info } = await evalService({ artifactDir: docsArtifactDir, appDir: `${wasmacs}/docs/app/src` });

const lispString = (text) => `"${String(text).replace(/[\\"]/g, "\\$&")}"`;
const hashOf = (text) => createHash("sha256").update(text).digest("hex");
const manifest = { version: info.version, files: {} };
let previous = "";
for (const path of [library, ...files]) {
  const text = readFileSync(path, "utf8");
  const source = /^.*lexical-binding:/.test(text) ? text : `;;; -*- lexical-binding: t; -*-\n${text}`;
  const hash = hashOf(`${info.version}\n${previous}\n${source}`);
  const file = `/tmp/elisp-react-compile/${hash}.el`;
  const compiled = service.eval(`(let ((coding-system-for-write 'utf-8-unix))
    (make-directory (file-name-directory ${lispString(file)}) t)
    (with-temp-file ${lispString(file)} (insert ${lispString(source)}))
    (and (byte-compile-file ${lispString(file)})
         (progn (load ${lispString(`${file}c`)} nil t)
                (with-temp-buffer
                  (set-buffer-multibyte nil)
                  (insert-file-contents-literally ${lispString(`${file}c`)})
                  (base64-encode-string (buffer-string) t)))))`);
  if (!compiled.ok || !compiled.value) {
    console.error(`${path}: does not compile${compiled.error ? `: ${compiled.error.message}` : ""}\n${compiled.output}`);
    process.exit(1);
  }
  const log = String(compiled.output || "").split("\n")
    .filter((line) => line && !/^(Compiling |Wrote |Loading |Source file .* newer)/.test(line)).join("\n");
  if (log) console.error(`${path}:\n${log}`);
  manifest.files[hash] = { name: path, code: compiled.value, log };
  previous = hash;
}
const json = `${JSON.stringify(manifest)}\n`;
if (output) writeFileSync(output, json); else process.stdout.write(json);
console.error(`compiled ${files.length + 1} files for Emacs ${info.version}${output ? ` into ${output}` : ""}`);
process.exit(0);
