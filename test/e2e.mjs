// The examples in real Chrome: Emacs runs in the page, Emacs Lisp renders,
// clicks reach Lisp, and the DOM is patched rather than rebuilt.
//
//   node test/e2e.mjs
//
// Emacs comes from a wasmacs checkout next to this repository
// (../wasmacs/docs, or $WASMACS_DOCS), served on a second origin as in
// production; without one, from the public site
// (https://modeverv.github.io/wasmacs/), which downloads about 150 MB.
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

// E2E_SITE=https://modeverv.github.io/elisp-react tests a deployed copy (with
// the public wasmacs) instead of this checkout.
const servers = [];
let siteOrigin = (process.env.E2E_SITE || "").replace(/\/$/, "");
let wasmacsQuery = "";
if (siteOrigin) {
  console.log(`site: ${siteOrigin} (deployed; Emacs from the public wasmacs site)`);
} else {
  const site = await serveDirectory(root, { host: "localhost" });
  servers.push(site.server);
  siteOrigin = site.origin;
  if (existsSync(`${wasmacsDocs}/app/src/emacs-eval-client.js`)) {
    const wasmacs = await serveDirectory(wasmacsDocs);
    servers.push(wasmacs.server);
    wasmacsQuery = `?wasmacs=${wasmacs.origin}/`;
    console.log(`wasmacs: ${wasmacsDocs}`);
  } else {
    console.log("wasmacs: the public site (large download)");
  }
}

const workDir = await mkdtemp(join(tmpdir(), "elisp-react-"));
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
  const pageErrors = [];
  client.onEvent = ({ method, params }) => {
    if (method === "Runtime.exceptionThrown") pageErrors.push(params.exceptionDetails?.exception?.description || "exception");
    if (method === "Runtime.consoleAPICalled" && params.type === "error") {
      pageErrors.push((params.args || []).map((arg) => arg.value ?? arg.description ?? "").join(" "));
    }
  };
  const js = (expression) => evaluate(client, sessionId, expression);
  const text = (selector) => js(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((node) => node.textContent)`);
  const click = (selector, index = 0) => js(`document.querySelectorAll(${JSON.stringify(selector)})[${index}].click(); true`);
  const until = (expression, label) => waitUntil(() => js(expression).catch(() => false), label, process.env.E2E_SITE ? 300_000 : 20_000);
  const open = async (path) => {
    const t0 = Date.now();
    await client.send("Page.navigate", { url: `${siteOrigin}${path}${wasmacsQuery}` }, sessionId);
    await until("Boolean(window.elispReact)", `${path}: the host script runs`);
    const info = await js("window.elispReact.ready.then((app) => ({ version: app.version, bootMs: app.bootMs }))");
    return { ...info, totalMs: Date.now() - t0 };
  };

  // ---- counter --------------------------------------------------------------
  const counter = await open("/examples/counter/");
  assert.equal(counter.version, "30.2");
  assert.deepEqual(await text(".count"), ["Apples: 3", "Oranges: 0"]);
  assert.match((await text("#app p"))[0], /Rendered by GNU Emacs 30\.2/);
  assert.equal(await js("document.querySelector('.loading')"), null);
  pass(`counter: Emacs ${counter.version} rendered the page (${counter.totalMs} ms from navigation, ${counter.bootMs} ms to start Emacs)`);

  // Tag the nodes: a re-render must keep them (patched, not rebuilt).
  await js("document.querySelectorAll('#app *').forEach((node, index) => { node.dataset.seen = index; }); true");
  const nodesBefore = await js("document.querySelectorAll('#app *').length");
  await click(".increment", 0);
  await until("document.querySelector('.count').textContent === 'Apples: 4'", "the first counter increments");
  await click(".increment", 0);
  await click(".increment", 1);
  await until("document.querySelectorAll('.count')[1].textContent === 'Oranges: 1'", "the second counter increments");
  assert.deepEqual(await text(".count"), ["Apples: 5", "Oranges: 1"]);
  assert.equal(await js("document.querySelectorAll('#app [data-seen]').length"), nodesBefore);
  pass("counter: clicks run Emacs Lisp; each instance keeps its own state; no DOM node was recreated");

  assert.deepEqual(await js("[...document.querySelectorAll('.reset')].map((node) => node.disabled)"), [false, false]);
  await click(".reset", 0);
  await until("document.querySelector('.count').textContent === 'Apples: 0'", "reset");
  assert.deepEqual(await js("[...document.querySelectorAll('.reset')].map((node) => node.disabled)"), [true, false]);
  pass("counter: an attribute follows the state (reset is disabled at 0)");

  // 200 clicks in one go: every one is answered, in order.
  const burst = await js(`(async () => {
    const button = document.querySelectorAll('.increment')[1];
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) button.click();
    while (document.querySelectorAll('.count')[1].textContent !== 'Oranges: 201') await new Promise((resolve) => setTimeout(resolve, 5));
    return performance.now() - t0;
  })()`);
  pass(`counter: 200 clicks rendered in ${burst.toFixed(0)} ms (${(burst / 200).toFixed(2)} ms per click)`);

  // ---- counters ---------------------------------------------------------------
  await open("/examples/counters/");
  assert.deepEqual(await text(".name"), ["Apples: 3", "Oranges: 0"]);
  assert.deepEqual(await text(".total"), ["2 counters, total 3"]);
  await click(".increment", 1);
  await click(".decrement", 0);
  await until("document.querySelector('.total').textContent === '2 counters, total 3'"
    + " && document.querySelectorAll('.name')[1].textContent === 'Oranges: 1'", "children report to the parent");
  assert.deepEqual(await text(".name"), ["Apples: 2", "Oranges: 1"]);
  pass("counters: the parent's state flows down as props and the rows call back up");

  // A controlled input: what is typed goes to Lisp state and comes back.
  assert.equal(await js("document.querySelector('.create').disabled"), true);
  await js(`(() => {
    const input = document.querySelector('.draft');
    input.value = 'Pears';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await until("document.querySelector('.create').disabled === false", "typing enables the add button");
  await js("document.querySelector('form').requestSubmit(); true");
  await until("document.querySelectorAll('.name').length === 3", "the form adds a row");
  assert.deepEqual(await text(".name"), ["Apples: 2", "Oranges: 1", "Pears: 0"]);
  assert.equal(await js("document.querySelector('.draft').value"), "");
  assert.deepEqual(await text(".total"), ["3 counters, total 3"]);
  pass("counters: a controlled input and a form submit add a row");

  await click(".remove", 0);
  await until("document.querySelectorAll('.name').length === 2", "a row is removed");
  assert.deepEqual(await text(".name"), ["Oranges: 1", "Pears: 0"]);
  await click(".increment", 1);
  await until("document.querySelectorAll('.name')[1].textContent === 'Pears: 1'", "the remaining rows still work");
  assert.deepEqual(await text(".total"), ["2 counters, total 2"]);
  pass("counters: removing a row keeps the others working");

  assert.deepEqual(pageErrors, []);
  assert.equal(await js("document.querySelector('#elisp-react-error')"), null);
  pass("no page errors");
  console.log("e2e passed");
} finally {
  client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), pause(2000)]);
  }
  for (const server of servers) server.close();
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
