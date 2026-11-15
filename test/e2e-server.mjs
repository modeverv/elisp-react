// The server example in real Chrome: an Emacs process is the web server and
// keeps the notes, the Emacs in the page renders them.
//
//   node test/e2e-server.mjs
//
// Starts examples/server/run.sh on a free port with a temporary notes file.
// Emacs for the page comes from ../wasmacs/docs through the same server when
// that checkout exists, otherwise from the public wasmacs site.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CdpClient, chromePath, devToolsUrl, evaluate, pause, waitUntil } from "./lib/cdp.mjs";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const pass = (message) => console.log(`PASS ${message}`);

const port = await new Promise((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
});
const origin = `http://127.0.0.1:${port}`;
const workDir = await mkdtemp(join(tmpdir(), "elisp-react-server-"));
const dataFile = join(workDir, "notes.eld");
const server = spawn(join(root, "examples/server/run.sh"), [String(port)], {
  env: { ...process.env, ELISP_REACT_SERVER_DATA: dataFile }, stdio: ["ignore", "ignore", "pipe"],
});
let serverLog = "";
server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => { serverLog += chunk; });
const lisp = async (path, options) => (await fetch(`${origin}${path}`, options)).text();

let chrome = null, client = null;
try {
  await waitUntil(() => lisp("/api/info").then((text) => text.startsWith("(:emacs"), () => false), "the Emacs server answers", 20_000);
  const info = await lisp("/api/info");
  const serverPid = Number(/:pid (\d+)/.exec(info)[1]);
  assert.equal(serverPid, server.pid);   // run.sh execs Emacs: the server is that process
  pass(`an Emacs process is the web server: ${info}`);

  // It only takes the three actions, and only from its own pages.
  const refused = await fetch(`${origin}/api/notes`, { method: "POST", body: "(eval (kill-emacs))" });
  assert.equal(refused.status, 400);
  const foreign = await fetch(`${origin}/api/notes`, { headers: { Origin: "https://example.com" } });
  assert.equal(foreign.status, 403);
  assert.equal((await fetch(`${origin}/.gitignore`)).status, 404);
  pass("the server evaluates nothing it is sent and refuses other sites");

  // A visitor who asks and hangs up at once.  Writing to a connection that
  // the other side has closed raises SIGPIPE, which ends an Emacs in batch
  // mode unless run.sh had the signal ignored.
  const hangUp = (reset) => new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.on("error", () => resolve());
    socket.on("connect", () => socket.write(`GET /lisp/react.el HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`, () => {
      if (reset) socket.resetAndDestroy(); else socket.destroy();
      resolve();
    }));
  });
  for (const reset of [false, true]) {
    for (let i = 0; i < 30; i++) await hangUp(reset);
  }
  await pause(500);
  assert.equal(server.exitCode ?? server.signalCode, null, "the server ended");
  assert.equal((await lisp("/api/info")).startsWith("(:emacs"), true);
  pass("sixty visitors who hang up in the middle of an answer do not end the server");

  const wasmacs = existsSync(`${root}/../wasmacs/docs/app/src/emacs-eval-client.js`) ? `?wasmacs=${origin}/wasmacs/` : "";
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
  const until = (expression, label) => waitUntil(() => js(expression).catch(() => false), label, wasmacs ? 20_000 : 300_000);
  const texts = () => js("[...document.querySelectorAll('li.todo .text')].map((node) => node.textContent)");

  await client.send("Page.navigate", { url: `${origin}/examples/server/${wasmacs}` }, sessionId);
  await until("Boolean(window.elispReact)", "the host script runs");
  await js("window.elispReact.ready.then(() => true)");
  await until("document.querySelectorAll('li.todo').length === 2", "the notes arrive from the server");
  assert.match(await js("document.querySelector('.page-emacs').textContent"), /GNU Emacs 30\.2, WebAssembly/);
  await until(`document.querySelector('.server-emacs').textContent.includes('process ${serverPid}')`, "the page shows the server's Emacs");
  pass(`two Emacsen: ${await js("document.querySelector('.server-emacs').textContent")}`);

  // The page sends actions as Lisp; the server applies and saves them.
  await js(`(() => {
    const input = document.querySelector('.new-text');
    input.value = 'Written in the browser';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await until("document.querySelector('.add').disabled === false", "the shared check accepts the text");
  await js("document.querySelector('form.new').requestSubmit(); true");
  await until("document.querySelectorAll('li.todo').length === 3", "the server answers with the new list");
  assert.equal((await texts())[2], "Written in the browser");
  assert.match(readFileSync(dataFile, "utf8"), /\(:id 3 :text "Written in the browser" :done nil\)/);
  await js("document.querySelectorAll('.toggle')[2].click(); true");
  await until("document.querySelectorAll('li.todo')[2].classList.contains('done')", "a note is toggled");
  assert.match(readFileSync(dataFile, "utf8"), /\(:id 3 :text "Written in the browser" :done t\)/);
  pass("the page's actions reach the server's Emacs, which saves the notes as Lisp data");

  // Someone else changes the list: the page follows.
  await lisp("/api/notes", { method: "POST", body: '(add "Added behind the page\'s back")' });
  await until("document.querySelectorAll('li.todo').length === 4", "the page picks up a change it did not make");
  await js("document.querySelectorAll('.delete')[0].click(); true");
  await until("document.querySelectorAll('li.todo').length === 3", "a note is removed");
  assert.equal((await lisp("/api/notes")).includes("This list lives"), false);
  pass("changes from elsewhere appear in the page; removals reach the server");

  assert.equal(await js("document.querySelector('#elisp-react-error')"), null);
  console.log("server e2e passed");
} catch (error) {
  console.error(serverLog.split("\n").slice(-12).join("\n"));
  throw error;
} finally {
  client?.close();
  if (chrome) {
    chrome.kill("SIGTERM");
    await Promise.race([new Promise((resolve) => chrome.once("exit", resolve)), pause(2000)]);
  }
  server.kill("SIGTERM");
  await rm(workDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
