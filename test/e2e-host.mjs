// What the host does for Lisp beyond rendering, in real Chrome: one page per
// feature under test/pages/.
//
//   node test/e2e-host.mjs
//
// Emacs comes from a wasmacs checkout next to this repository
// (../wasmacs/docs, or $WASMACS_DOCS), served on a second origin; without
// one, from the public site.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveDirectory } from "../tools/static-server.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, pause, waitUntil } from "./lib/cdp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const wasmacsDocs = process.env.WASMACS_DOCS || `${root}/../wasmacs/docs`;
const pass = (message) => console.log(`PASS ${message}`);

const servers = [];
const site = await serveDirectory(root, { host: "localhost" });
servers.push(site.server);
let wasmacsQuery = "";
if (existsSync(`${wasmacsDocs}/app/src/emacs-eval-client.js`)) {
  const wasmacs = await serveDirectory(wasmacsDocs);
  servers.push(wasmacs.server);
  wasmacsQuery = `?wasmacs=${wasmacs.origin}/`;
}

const workDir = await mkdtemp(join(tmpdir(), "elisp-react-host-"));
let chrome = null, client = null;
try {
  chrome = spawn(chromePath, [
    "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-port=0", `--user-data-dir=${join(workDir, "profile")}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  client = new CdpClient(await devToolsUrl(chrome));
  const { targetId } = await client.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await client.send("Target.attachToTarget", { targetId, flatten: true });
  await client.send("Page.enable", {}, sessionId);
  await client.send("Runtime.enable", {}, sessionId);
  const js = (expression) => evaluate(client, sessionId, expression);
  const until = (expression, label, ms = 20_000) => waitUntil(() => js(expression).catch(() => false), label, ms);
  const text = (selector) => js(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const click = (selector) => js(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  // Open test/pages/NAME/ and wait until the page is up.
  const open = async (name, query = "") => {
    await client.send("Page.navigate", { url: `${site.origin}/test/pages/${name}/${wasmacsQuery}${query}` }, sessionId);
    await until("Boolean(window.elispReact)", `${name}: the host script runs`);
    await js("window.elispReact.ready.then(() => true)");
  };

  // ---- watchdog ---------------------------------------------------------------
  await open("watchdog");
  await js("window.errors = []; document.addEventListener('elisp-react:error', (event) => errors.push(event.detail.symbol)); true");
  await click(".count");
  await until("document.querySelector('.count').textContent === '1'", "a click is answered");
  await click(".loop");
  await until("/^timeout: Emacs Lisp did not answer the click event within 1.5 s/.test(document.querySelector('#elisp-react-error')?.textContent)",
    "an endless loop is reported", 10_000);
  assert.deepEqual(await js("errors"), ["timeout"]);
  await click(".count");
  await pause(500);
  assert.equal(await text(".count"), "1");
  assert.deepEqual(await js("errors"), ["timeout"]);
  pass("watchdog: Lisp that does not answer within the timeout stops Emacs and is reported once");

  console.log("e2e host passed");
} finally {
  client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), pause(2000)]);
  }
  for (const server of servers) server.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
