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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveDirectory } from "../tools/static-server.mjs";
import { CdpClient, chromePath, devToolsUrl, evaluate, pause, waitUntil } from "./lib/cdp.mjs";
import { realtimeServer } from "./lib/realtime-server.mjs";

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

  // ---- fetch ------------------------------------------------------------------
  await open("fetch");
  await click(".bytes");
  await until("document.querySelector('.bytes-result').textContent !== ''", "the bytes arrive");
  assert.equal(await text(".bytes-result"), "256 0 255 nil application/octet-stream");
  pass("fetch: a binary body reaches Lisp intact as a unibyte string (:as 'base64), with the response's headers");
  const upload = join(workDir, "photo.txt");
  await writeFile(upload, "twelve bytes");
  const { root: documentNode } = await client.send("DOM.getDocument", {}, sessionId);
  const { nodeId } = await client.send("DOM.querySelector", { nodeId: documentNode.nodeId, selector: ".photos" }, sessionId);
  await client.send("DOM.setFileInputFiles", { nodeId, files: [upload] }, sessionId);
  await js("document.querySelector('form.upload').requestSubmit(); true");
  await until("document.querySelector('.echo').textContent !== ''", "the form is sent");
  assert.deepEqual(JSON.parse(await text(".echo")),
    { entries: [["title", "Holiday"], ["photos", "photo.txt 12"]], credentials: "include", cache: "no-store", method: "POST" });
  pass("fetch: :form sends fields and the chosen files as FormData; :credentials and :cache reach fetch");

  // ---- realtime -----------------------------------------------------------------
  const realtime = await realtimeServer();
  servers.push(realtime.server);
  await open("realtime", `&server=${encodeURIComponent(realtime.origin)}`);
  await until("document.querySelectorAll('#app li').length >= 5 && /ws close/.test(document.querySelector('#app').textContent)", "the events and the echo arrive").catch(async (error) => {
    console.log(await js("[document.querySelector('#app').innerHTML, document.querySelector('#elisp-react-error')?.textContent]"));
    throw error;
  });
  const log = await js("[...document.querySelectorAll('#app li')].map((node) => node.textContent)");
  assert.deepEqual(log.filter((line) => line.startsWith("sse")), ["sse message one nil", "sse tick two 9"]);
  assert.deepEqual(log.filter((line) => line.startsWith("ws")), ["ws open", "ws echo: hello", "ws close 1000 done"]);
  pass("realtime: server-sent events (named ones too), a WebSocket's messages and its closing reach Lisp");

  // ---- storage in two tabs --------------------------------------------------------
  await open("storage-tabs");
  await js("localStorage.clear(); true");
  await open("storage-tabs");
  const other = await client.send("Target.createTarget", { url: `${site.origin}/test/pages/storage-tabs/${wasmacsQuery}` });
  const { sessionId: otherSession } = await client.send("Target.attachToTarget", { targetId: other.targetId, flatten: true });
  await client.send("Runtime.enable", {}, otherSession);
  const otherJs = (expression) => evaluate(client, otherSession, expression);
  await waitUntil(() => otherJs("window.elispReact?.ready.then(() => true)").catch(() => false), "the second tab is up");
  await click(".add");
  await waitUntil(() => otherJs("document.querySelector('.items').textContent === 'item 1'"), "the second tab sees the first tab's item");
  await otherJs("document.querySelector('.add').click(); true");
  await until("document.querySelector('.items').textContent === 'item 2, item 1'", "the first tab sees the merge");
  assert.equal(await js("localStorage.getItem('elisp-react:/test/pages/storage-tabs/:later')"), '("item 2" "item 1")');
  await client.send("Target.closeTarget", { targetId: other.targetId });
  pass("storage: a value stored in another tab reaches Lisp (react-storage-watch), so tabs merge instead of losing entries");

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
