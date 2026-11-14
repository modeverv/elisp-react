// Development server.
//
//   node tools/serve.mjs
//
// Serves this repository on http://127.0.0.1:5180.  The pages load Emacs from
// the public wasmacs site by default.  When a wasmacs checkout with a built
// site is next to this one (../wasmacs/docs, or $WASMACS_DOCS), that is
// served on a second port and the printed URLs use it: no network needed.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { serveDirectory } from "./static-server.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const wasmacsDocs = process.env.WASMACS_DOCS || `${root}/../wasmacs/docs`;
const site = await serveDirectory(root, { port: Number(process.env.PORT || 5180) });
let query = "";
if (existsSync(`${wasmacsDocs}/app/src/emacs-eval-client.js`)) {
  // "localhost" for the pages, "127.0.0.1" for wasmacs: two origins, as in production.
  const wasmacs = await serveDirectory(wasmacsDocs, { port: Number(process.env.WASMACS_PORT || 5181) });
  query = `?wasmacs=${wasmacs.origin}/`;
  console.log(`wasmacs from ${wasmacsDocs} at ${wasmacs.origin}`);
} else {
  console.log("wasmacs from https://modeverv.github.io/wasmacs/ (no local build found)");
}
const port = new URL(site.origin).port;
console.log(`counter:  http://localhost:${port}/examples/counter/${query}`);
console.log(`counters: http://localhost:${port}/examples/counters/${query}`);
