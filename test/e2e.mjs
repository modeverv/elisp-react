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

  // The Lisp was byte-compiled in the page, and the compiled code is kept.
  assert.equal(await js("Object.keys(localStorage).filter((key) => key.startsWith('elisp-react:compiled:')).length"), 2);
  assert.equal(await js("window.elispReact.emacs.eval(\"(byte-code-function-p (symbol-function 'react-flush))\")"), true);
  pass("counter: react.el and counter.el run byte-compiled; the compiled code is stored for the next visit");

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

  // ---- todo -----------------------------------------------------------------
  await open("/examples/todo/");
  const todoTexts = () => text("li.todo .text");
  const typeInto = (selector, value) => js(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.value = ${JSON.stringify(value)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  assert.deepEqual(await todoTexts(), ["Write React in Emacs Lisp", "Give the rows keys", "Try it in a browser"]);
  assert.deepEqual(await text(".left"), ["2 items left"]);
  assert.deepEqual(await js("[...document.querySelectorAll('.toggle')].map((node) => node.checked)"), [true, false, false]);
  await until("document.activeElement?.classList.contains('new-text')", "the new-todo field has the focus");

  await typeInto(".new-text", "Sort the list");
  await until("document.querySelector('.add').disabled === false", "typing enables add");
  await js("document.querySelector('form.new').requestSubmit(); true");
  await until("document.querySelectorAll('li.todo').length === 4", "a todo is added");
  assert.equal((await todoTexts())[3], "Sort the list");
  assert.equal(await js("document.querySelector('.new-text').value"), "");
  assert.deepEqual(await text(".left"), ["3 items left"]);
  pass("todo: the form adds a todo");

  await click(".toggle", 1);
  await until("document.querySelector('.left').textContent === '2 items left'", "toggling a todo");
  assert.deepEqual(await js("[...document.querySelectorAll('li.todo')].map((node) => node.classList.contains('done'))"),
    [true, true, false, false]);
  pass("todo: a checkbox toggles a todo");

  // should-update: typing into the new-todo field renders the application
  // again at every key, but no row.
  const rowRenders = () => js(`window.elispReact.emacs.eval("todo-item-renders")`);
  await js(`window.elispReact.emacs.eval("(progn (defvar todo-item-renders 0) (advice-add 'react--render :before (lambda (instance) (when (eq (react--instance-type instance) 'TodoItem) (setq todo-item-renders (1+ todo-item-renders))))) todo-item-renders)")`);
  await typeInto(".new-text", "typing");
  await typeInto(".new-text", "typing more");
  await until("document.querySelector('.add').disabled === false", "the application rendered");
  assert.equal(await rowRenders(), 0);
  await click(".toggle", 2);
  await until("document.querySelector('.left').textContent === '1 item left'", "toggling the third row");
  assert.equal(await rowRenders(), 1);
  await click(".toggle", 2);
  await until("document.querySelector('.left').textContent === '2 items left'", "and back");
  await typeInto(".new-text", "");
  await until("document.querySelector('.add').disabled === true", "the field is empty again");
  pass("todo: rows that did not change are not rendered again (should-update)");

  // Keys: tag every row, start editing the last one (state of that row
  // alone), then move rows around it.  The row keeps its DOM node and its
  // half-typed text.
  await js("document.querySelectorAll('li.todo').forEach((node) => { node.dataset.row = node.querySelector('.text').textContent; }); true");
  await click(".edit-button", 3);
  await until("Boolean(document.querySelector('.edit-text'))", "a row switches to editing");
  // Lisp asked for the focus after its render put the field on the page.
  await until("document.activeElement === document.querySelector('.edit-text')", "the edit field gets the focus");
  assert.equal(await js("document.activeElement.selectionEnd - document.activeElement.selectionStart"), "Sort the list".length);
  await typeInto(".edit-text", "Sort the list (half typed");
  await click(".up", 2);       // "Try it in a browser" moves above "Give the rows keys"
  await until("document.querySelectorAll('li.todo .text')[1]?.textContent === 'Try it in a browser'", "a row moves up");
  await click(".delete", 0);   // the first row goes
  await until("document.querySelectorAll('li.todo').length === 3", "a row is deleted");
  assert.deepEqual(await js("[...document.querySelectorAll('li.todo')].map((node) => node.dataset.row)"),
    ["Try it in a browser", "Give the rows keys", "Sort the list"]);
  assert.equal(await js("document.querySelector('li.todo.editing').dataset.row"), "Sort the list");
  assert.equal(await js("document.querySelector('.edit-text').value"), "Sort the list (half typed");
  pass("todo: keyed rows keep their DOM nodes and their own state while rows move and disappear");

  await typeInto(".edit-text", "Sort the list by hand");
  await js("document.querySelector('form.edit').requestSubmit(); true");
  await until("!document.querySelector('.edit-text')", "saving ends the edit");
  assert.deepEqual(await todoTexts(), ["Try it in a browser", "Give the rows keys", "Sort the list by hand"]);
  pass("todo: an edited row is renamed");

  // Filters remove rows from the page and bring them back.
  await js("document.querySelector('[data-filter=active]').click(); true");
  await until("document.querySelectorAll('li.todo').length === 2", "the active filter");
  assert.deepEqual(await todoTexts(), ["Try it in a browser", "Sort the list by hand"]);
  await js("document.querySelector('[data-filter=done]').click(); true");
  await until("document.querySelectorAll('li.todo').length === 1", "the done filter");
  assert.deepEqual(await todoTexts(), ["Give the rows keys"]);
  await js("document.querySelector('[data-filter=all]').click(); true");
  await until("document.querySelectorAll('li.todo').length === 3", "all again");
  assert.deepEqual(await todoTexts(), ["Try it in a browser", "Give the rows keys", "Sort the list by hand"]);
  assert.deepEqual(await text(".clear"), ["clear done (1)"]);
  await click(".clear");
  await until("document.querySelectorAll('li.todo').length === 2 && !document.querySelector('.clear')", "clearing done todos");
  assert.deepEqual(await text(".left"), ["2 items left"]);
  pass("todo: filters and clearing done todos");

  // The list is in localStorage: a reload starts from it.
  await open("/examples/todo/");
  assert.deepEqual(await todoTexts(), ["Try it in a browser", "Sort the list by hand"]);
  await typeInto(".new-text", "Survive a reload");
  await js("document.querySelector('form.new').requestSubmit(); true");
  await until("document.querySelectorAll('li.todo').length === 3", "a todo is added after the reload");
  await open("/examples/todo/");
  assert.deepEqual(await todoTexts(), ["Try it in a browser", "Sort the list by hand", "Survive a reload"]);
  pass("todo: the list survives reloads (localStorage), and new ids continue after the stored ones");

  // ---- async ----------------------------------------------------------------
  await open("/examples/async/");
  assert.deepEqual(await text(".ticks"), ["0 ticks"]);
  await until("Number(document.querySelector('.ticks')?.textContent.split(' ')[0]) >= 2", "the clock ticks");
  assert.match((await text(".time"))[0], /^\d\d:\d\d:\d\d$/);
  await click(".show-clock");
  await until("!document.querySelector('.clock')", "the clock is taken down");
  const requestsBefore = pageErrors.length;
  await pause(1500);            // its interval is cancelled: nothing arrives for a clock that is gone
  assert.equal(pageErrors.length, requestsBefore);
  await click(".show-clock");
  await until("document.querySelector('.ticks')?.textContent === '0 ticks'", "a new clock starts from zero");
  await until("document.querySelector('.ticks')?.textContent === '1 ticks'", "and ticks");
  pass("async: an interval runs while its component is mounted");

  await click(".remind");
  await until("document.querySelector('.reminder').textContent === 'waiting…' && document.querySelector('.remind').disabled", "waiting");
  await until("document.querySelector('.reminder').textContent === 'Time is up.'", "the timeout fires");
  pass("async: a timeout changes state later");

  await click(".launch");
  await until("document.querySelector('.countdown').textContent === '3…'", "the countdown starts");
  await until("document.querySelector('.countdown').textContent === '1…'", "it counts");
  await until("document.querySelector('.countdown').textContent === 'Lift-off!' && !document.querySelector('.launch').disabled", "lift-off");
  pass("async: react-async runs a loop with a pause in it (await)");

  await click(".load");
  await until("document.querySelector('.status').textContent === 'loaded'", "the quotes load");
  assert.equal(await js("document.querySelectorAll('.quote-list li').length"), 3);
  assert.equal((await text(".quote-list cite"))[0], "Alan Perlis");
  await click(".load-missing");
  await until("document.querySelector('.status').textContent === 'failed'", "a missing file fails");
  assert.deepEqual(await text(".error"), ["HTTP 404"]);
  assert.equal(await js("document.querySelector('.quote-list')"), null);
  await click(".load");
  await until("document.querySelectorAll('.quote-list li').length === 3", "loading again works");
  pass("async: fetch with loading, data and error states");

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
