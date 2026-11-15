// What the host does for Lisp beyond rendering, in real Chrome: one page per
// feature under test/pages/.
//
//   node test/e2e-host.mjs
//
// Emacs comes from a wasmacs checkout next to this repository
// (../wasmacs/docs, or $WASMACS_DOCS), served on a second origin; without
// one, from the public site.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

  // ---- commands of the page --------------------------------------------------------
  await open("page-commands");
  await until("document.querySelector('.ticks').textContent === '3' && document.querySelector('.double').textContent === '42'", "the page answers Lisp");
  assert.equal(await text(".width"), "240");
  assert.equal(await text(".refused"), "nil no, thank you");
  assert.equal(await js("document.title"), "titled by Lisp");
  await pause(200);
  assert.equal(await js("window.tickerStopped"), 3);
  assert.equal(await text(".ticks"), "3");
  pass("page commands: Lisp calls commands the page registered (answers, repeated answers, refusals, a DOM node, a notice); react-cancel stops one");
  await js("window.elispReact.send('page-greet', 'page', 7)");
  assert.equal(await text(".greeting"), "hello page 7");
  pass("page commands: the page's script calls a Lisp function (elispReact.send) and the page shows the result when it resolves");

  // ---- the address ----------------------------------------------------------------
  await open("location", "&q=%E6%8B%AC%E5%BC%A7");
  assert.match(await text(".query"), /\("q" \. "括弧"\)/);
  await click(".go");
  await until("document.querySelector('.hash').textContent === '#/watch?v=a'", "react-navigate");
  assert.equal(await js("location.hash"), "#/watch?v=a");
  await js("history.back(); true");
  await until("document.querySelector('.hash').textContent === ''", "Back reaches Lisp");
  await click(".link");
  await until("document.querySelector('.hash').textContent === '#/linked'", "a hash link reaches Lisp");
  await click(".title");
  await until("document.title === 'Set by Lisp'", "the title");
  assert.equal(await js("document.querySelector('meta[name=description]').content"), "about the page");
  assert.equal(await js("document.querySelector('meta[property=\"og:title\"]').content"), "shared");
  pass("location: Lisp reads the address and its query, hears links and Back, navigates, and sets the title and meta");
  await open("location", "&mode=memory");
  assert.equal(await text(".href"), "/");
  await click(".link");
  await until("document.querySelector('.hash').textContent === '#/linked'", "a hash link in memory");
  await click(".go");
  await until("document.querySelector('.hash').textContent === '#/watch?v=a'", "navigate in memory");
  assert.equal(await js("location.hash"), "");
  await click(".back");
  await until("document.querySelector('.hash').textContent === '#/linked'", "back in memory");
  pass("location: a page without an address of its own (elisp-studio's preview) gets one in memory, with links, history and Back");

  // ---- events of the page -------------------------------------------------------------
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] }, sessionId);
  await open("page-events");
  await until("document.querySelector('.seen').textContent === 'nil' && document.querySelector('.dark').textContent === 'nil'", "the first answers");
  const typed = await js(`(() => {
    const slash = new KeyboardEvent("keydown", { key: "/", cancelable: true, bubbles: true });
    const other = new KeyboardEvent("keydown", { key: "a", cancelable: true, bubbles: true });
    document.body.dispatchEvent(slash);
    document.body.dispatchEvent(other);
    return [slash.defaultPrevented, other.defaultPrevented];
  })()`);
  assert.deepEqual(typed, [true, false]);
  await until("document.querySelector('.keys').textContent === '/'", "the key reaches Lisp");
  await client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] }, sessionId);
  await until("document.querySelector('.dark').textContent === 't'", "the media query changes");
  await client.send("Emulation.setDeviceMetricsOverride", { width: 640, height: 480, deviceScaleFactor: 1, mobile: false }, sessionId);
  await until("document.querySelector('.width').textContent === '640'", "the resize reaches Lisp");
  await js("window.scrollTo(0, document.body.scrollHeight); true");
  await until("document.querySelector('.seen').textContent === 't'", "the end comes into view");
  await client.send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  await client.send("Emulation.setEmulatedMedia", { features: [] }, sessionId);
  pass("page events: a key on the window (filtered, its default prevented), a resize, a media query and an element coming into view reach Lisp");

  // ---- event control -------------------------------------------------------------
  await open("event-control");
  await click(".stopped");
  await click(".bubbles");
  await click(".link");
  const keys = await js(`(() => {
    const field = document.querySelector('.field');
    const enter = new KeyboardEvent("keydown", { key: "Enter", cancelable: true, bubbles: true });
    const other = new KeyboardEvent("keydown", { key: "x", cancelable: true, bubbles: true });
    field.dispatchEvent(enter);
    field.dispatchEvent(other);
    return [enter.defaultPrevented, other.defaultPrevented];
  })()`);
  assert.deepEqual(keys, [true, false]);
  await click(".dialog");
  await click(".backdrop");
  await until("document.querySelector('.log').textContent.split(' ').length >= 6", "the events arrive");
  assert.equal(await text(".log"), "stopped bubbles outer link enter outer backdrop");
  assert.equal(await js("location.hash"), "");
  pass("event control: :stop keeps parents from hearing, :prevent keeps a link from navigating, :keys filters, :self ignores children");

  // ---- what an event says ------------------------------------------------------------
  await open("event-payload");
  await js(`document.querySelector('.inner').dispatchEvent(new MouseEvent("click", { bubbles: true, shiftKey: true, button: 0, clientX: 12, clientY: 34 })); true`);
  await until("document.querySelector('.seen').textContent.startsWith(':shift')", "the click is described");
  const innerId = await js("document.querySelector('.area').__elispReactId + 1");
  assert.equal(await text(".seen"), `:shift=t :ctrl=nil :button=0 :x=12 :y=34 :target=${innerId}`);
  await js(`document.querySelector('.field').dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter", altKey: true, isComposing: true })); true`);
  await until("document.querySelector('.seen').textContent.startsWith(':key')", "the key is described");
  assert.equal(await text(".seen"), ':key="Enter" :code="Enter" :alt=t :composing=t :repeat=nil');
  await js("document.querySelector('.form').requestSubmit(); true");
  await until("document.querySelector('.seen').textContent.startsWith('括弧')", "the form's fields arrive");
  assert.equal(await text(".seen"), '括弧 ("a" "b")');
  pass("event payload: modifier keys, code, IME composition, button, coordinates, the target node and a form's fields reach Lisp");

  // ---- imperative DOM ---------------------------------------------------------------
  await open("imperative");
  await until("document.querySelector('.measured').textContent !== ''", "the list is measured");
  assert.equal(await text(".measured"), "200 120 500");
  assert.deepEqual(await js(`(() => {
    const field = document.querySelector('.field');
    return [document.querySelector('.box').indeterminate, field.selectionStart, field.selectionEnd,
            document.querySelector('.dialog').open, document.querySelector('.dialog').matches(':modal'), field.innerHTML];
  })()`), [true, 1, 3, true, true, ""]);
  pass("imperative DOM: Lisp sets allowed properties, calls methods with arguments (selection, scrollTo, showModal) and measures a node; innerHTML is refused");

  // ---- a failed render when source is loaded -------------------------------------------
  await open("event-payload");
  const failed = await js(`window.elispReact.load("broken.el", "(react-define-component 'Payload :render (lambda (_self) (car 1)))")
    .then((loaded) => ({ error: loaded.renderError?.message || null, box: document.querySelector('#elisp-react-error')?.textContent || null }))`);
  assert.match(failed.error, /wrong-type-argument|Wrong type argument: listp, 1, in Payload/);
  assert.match(failed.box, /Wrong type argument: listp, 1, in Payload/);
  await js(`window.elispReact.load("fixed.el", "(react-define-component 'Payload :render (lambda (_self) (jsx (p (:class \\"seen\\") \\"fixed\\"))))")`);
  assert.equal(await text(".seen"), "fixed");
  assert.equal(await js("document.querySelector('#elisp-react-error')"), null);
  pass("load: source whose render fails resolves with renderError naming the component; a good render clears the error box");

  // ---- svg ----------------------------------------------------------------------
  await open("svg");
  const svg = await js(`(() => {
    const chart = document.querySelector('.chart');
    const rects = [...chart.querySelectorAll('rect')];
    return { ns: chart.namespaceURI, rects: rects.map((rect) => [rect.namespaceURI === chart.namespaceURI, Math.round(rect.getBBox().height)]),
             text: chart.querySelector('text').getBBox().width > 0, href: chart.querySelector('a').getAttribute('href'),
             to: chart.querySelector('.anim').getAttribute('to') };
  })()`);
  assert.deepEqual(svg, { ns: "http://www.w3.org/2000/svg", rects: [[true, 30], [true, 70], [true, 50]], text: true, href: null, to: null });
  await click(".grow");
  await until("document.querySelectorAll('.chart rect').length === 4", "a bar is added");
  assert.equal(await js("document.querySelectorAll('.chart rect')[3].namespaceURI"), "http://www.w3.org/2000/svg");
  pass("svg: Lisp draws inline SVG in the SVG namespace (also elements added later); script URLs in links and animations are refused");

  // ---- forms ----------------------------------------------------------------------
  await open("forms");
  assert.equal(await js("document.querySelector('.fruit').value"), "b");
  await js(`(async () => {
    const field = document.querySelector('.slow');
    for (const letter of "abcdefgh") {
      field.value += letter;
      field.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return true;
  })()`);
  await until("document.querySelector('.text').textContent === 'abcdefgh'", "Lisp has every letter", 10_000);
  assert.equal(await js("document.querySelector('.slow').value"), "abcdefgh");
  pass("forms: typing faster than a slow render loses no letter; a controlled <select> shows its value from the start");

  // ---- HTML from elsewhere -----------------------------------------------------------
  await open("inner-html");
  await pause(300);
  const cleaned = await js(`(() => {
    const box = document.querySelector('.text');
    const links = [...box.querySelectorAll('a')];
    return { html: box.querySelector('p').innerHTML, img: box.querySelector('img')?.getAttributeNames().sort(),
             links: links.map((link) => link.getAttributeNames().sort().map((name) => name + '=' + link.getAttribute(name))),
             gone: ['script', 'iframe', 'svg'].map((tag) => box.querySelector(tag)),
             bad: [window.bad1, window.bad2, window.bad3, window.bad4, window.bad5, window.bad6] };
  })()`);
  assert.deepEqual(cleaned, {
    html: "Hi <b>there</b> kept text", img: ["alt", "src"],
    links: [[], ["href=https://example.com/", "rel=noopener noreferrer"]],
    gone: [null, null, null], bad: [null, null, null, null, null, null],
  });
  await click(".next");
  await until("document.querySelector('.text').innerHTML === '<p>next</p>'", "new HTML replaces the old");
  pass("inner HTML: HTML from elsewhere is shown cleaned: no scripts, handlers, script URLs, frames or styles; unknown tags keep their text");

  // ---- compiled code kept by the files before it --------------------------------------
  await open("cache-chain", "&macro=v1");
  await js("localStorage.clear(); true");
  await open("cache-chain", "&macro=v1");
  assert.equal(await text(".greeting"), "v1");
  assert.equal(await js("Object.keys(localStorage).filter((key) => key.startsWith('elisp-react:compiled:')).length"), 3);
  // Only the file with the macro changed: the file that uses it is compiled again.
  await open("cache-chain", "&macro=v2");
  assert.equal(await text(".greeting"), "v2");
  await js("localStorage.clear(); true");
  await open("cache-chain", "&macro=v3&cache=no");
  assert.equal(await text(".greeting"), "v3");
  assert.equal(await js("Object.keys(localStorage).filter((key) => key.startsWith('elisp-react:compiled:')).length"), 0);
  pass("compiled code: a change in a file loaded before (a macro) compiles the files after it again; cache:false keeps nothing");

  // ---- compiled ahead of time -----------------------------------------------------------
  execFileSync("node", [`${root}/tools/compile.mjs`, "-o", `${root}/test/pages/precompiled/compiled.json`,
                        `${root}/test/pages/precompiled/app.el`], { stdio: ["ignore", "ignore", "pipe"] });
  await open("precompiled");
  await js("localStorage.clear(); true");
  await open("precompiled");
  assert.equal(await text(".greeting"), "compiled before the visit");
  assert.deepEqual(await js("[window.elispReact.library.from, ...window.elispReact.compileLogs.map((each) => each.from)]"), ["manifest", "manifest"]);
  assert.equal(await js("Object.keys(localStorage).filter((key) => key.startsWith('elisp-react:compiled:')).length"), 0);
  pass("compiled ahead of time: with a manifest from tools/compile.mjs the first visit compiles neither react.el nor the page's Lisp");

  // ---- the start: progress, and a time limit ----------------------------------------
  await open("progress");
  const steps = await js("window.steps");
  assert.equal(steps[0], "build id");
  assert.equal(steps.includes("emacs"), true);
  assert.deepEqual(steps.slice(-2), ["lisp", "lisp"]);
  pass(`start: the page hears how the start goes (${[...new Set(steps)].join(", ")})`);
  // A wasmacs site that never sends temacs.wasm.
  const stalled = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://x").pathname);
    if (path.endsWith("temacs.wasm")) return;          // never answered
    const file = join(resolve(wasmacsDocs), path);
    if (!file.startsWith(resolve(wasmacsDocs)) || !existsSync(file) || !statSync(file).isFile()) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": file.endsWith(".js") ? "text/javascript" : "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve) => stalled.listen(0, "127.0.0.1", resolve));
  servers.push(stalled);
  await client.send("Page.navigate", { url: `${site.origin}/test/pages/boot-timeout/?wasmacs=http://127.0.0.1:${stalled.address().port}/` }, sessionId);
  await until("/^boot-timeout: Emacs did not start within 3 s \\(it was at: /.test(document.querySelector('#elisp-react-error')?.textContent)",
    "a stalled start is reported", 15_000);
  pass(`start: a start that stalls (temacs.wasm never comes) ends after its time limit and says where it was: ${(await text("#elisp-react-error")).trim()}`);
  stalled.closeAllConnections?.();

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
