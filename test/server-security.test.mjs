// Regression checks for the native example server's public/private file boundary.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { link, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));

test("the native server only publishes public files", { timeout: 30000 }, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "elisp-react-security-"));
  const root = join(temporary, "site");
  const example = join(root, "examples/server");
  const wasm = join(temporary, "wasmacs");
  const dataName = "café.eld";
  const dataFile = join(root, dataName);
  const dataUrl = `/${encodeURIComponent(dataName)}`;
  const upperUrl = `/${encodeURIComponent(dataName.toUpperCase())}`;
  let child;
  let logs = "";
  t.after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
    }
    await rm(temporary, { recursive: true, force: true });
  });
  await Promise.all([
    mkdir(join(example, "data"), { recursive: true }),
    mkdir(join(root, ".git"), { recursive: true }),
    mkdir(join(root, "hidden-index"), { recursive: true }),
    mkdir(join(root, "%77asmacs"), { recursive: true }),
    mkdir(wasm, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "public.el"), "PUBLIC_APP"),
    writeFile(join(root, "%77asmacs/public.el"), "PUBLIC_APP_ENCODED"),
    writeFile(join(wasm, "public.el"), "PUBLIC_WASMACS"),
    writeFile(dataFile, '((:id 1 :text "PRIVATE_NOTE" :done nil))\n'),
    writeFile(`${dataFile}~`, "PRIVATE_BACKUP"),
    writeFile(`${dataFile}.~1~`, "PRIVATE_NUMBERED_BACKUP"),
    writeFile(join(example, "data/notes.eld"), "PRIVATE_DEFAULT"),
    writeFile(join(example, "data/notes.eld~"), "PRIVATE_DEFAULT_BACKUP"),
    writeFile(join(root, ".git/config"), "PRIVATE_GIT"),
    writeFile(join(temporary, "outside.txt"), "PRIVATE_OUTSIDE"),
  ]);
  await Promise.all([
    symlink(dataFile, join(root, "notes-alias.txt")),
    link(dataFile, join(root, "notes-hardlink.txt")),
    symlink(`${dataFile}~`, join(root, "backup-alias.txt")),
    symlink(join(example, "data"), join(root, "data-alias")),
    symlink(join(root, ".git/config"), join(root, "hidden-alias.txt")),
    symlink(join(root, ".git"), join(root, "hidden-directory")),
    symlink(join(root, ".git/config"), join(root, "hidden-index/index.html")),
    symlink(dataFile, join(wasm, "notes-alias.txt")),
    symlink(join(temporary, "outside.txt"), join(root, "outside-alias.txt")),
  ]);
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const port = probe.address().port;
      probe.close(() => resolve(port));
    });
  });
  const emacs = execFileSync(join(repo, "tools/find-emacs.sh"), { encoding: "utf8" }).trim();
  const config = `(setq elisp-react-server-port ${port}
    elisp-react-server-root ${JSON.stringify(`${root}/`)}
    elisp-react-server-wasmacs ${JSON.stringify(`${wasm}/`)}
    elisp-react-server--directory ${JSON.stringify(`${example}/`)}
    elisp-react-server-data-file ${JSON.stringify(dataFile)})`;
  // As in run.sh, a peer disconnect must not end batch Emacs with SIGPIPE.
  child = spawn("/bin/sh", ["-c", "trap '' PIPE; exec \"$@\"", "elisp-react-security-test", emacs,
    "--batch", "-Q", "-l", join(repo, "examples/server/server.el"), "--eval", config,
    "-f", "elisp-react-server-run"], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { logs = (logs + chunk).slice(-8192); });
  const origin = `http://127.0.0.1:${port}`;
  const request = (path, options) => fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3000), ...options });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { ready = (await request("/api/info")).status === 200; } catch {}
    if (ready || child.exitCode !== null || child.signalCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(ready, `native server did not start: ${logs}`);

  await t.test("public application files remain readable without wildcard CORS", async () => {
    for (const headers of [{}, { Origin: origin }]) {
      const response = await request("/public.el", { headers });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "PUBLIC_APP");
      assert.equal(response.headers.get("access-control-allow-origin"), null);
    }
  });

  await t.test("foreign pages cannot read application files", async () => {
    for (const headers of [
      { Origin: "https://attacker.invalid" },
      { "Sec-Fetch-Site": "cross-site" },
    ]) {
      assert.equal((await request("/public.el", { headers })).status, 403);
      assert.equal((await request("/%2577asmacs/public.el", { headers })).status, 403);
    }
  });

  await t.test("wasmacs files retain cross-origin access", async () => {
    for (const path of ["/wasmacs/public.el", "/%77asmacs/public.el", "/wasmacs%2fpublic.el"]) {
      const response = await request(path, {
        headers: { Origin: "https://application.invalid", "Sec-Fetch-Site": "cross-site" },
      });
      assert.equal(response.status, 200, path);
      assert.equal(await response.text(), "PUBLIC_WASMACS");
      assert.equal(response.headers.get("access-control-allow-origin"), "*");
    }
  });

  await t.test("private state, backups and symlink aliases are never static files", async () => {
    for (const path of [
      dataUrl, `${dataUrl}~`, `${dataUrl}.~1~`,
      "/examples/server/data/notes.eld", "/examples/server/data/notes.eld~",
      "/notes-alias.txt", "/notes-hardlink.txt", "/backup-alias.txt", "/data-alias/notes.eld",
      "/.git/config", "/hidden-alias.txt", "/hidden-directory/config", "/hidden-index/", "/outside-alias.txt",
      "/wasmacs/notes-alias.txt",
      `/wasmacs/%2e%2e%2fsite%2f${encodeURIComponent(dataName)}`,
    ]) {
      assert.equal((await request(path)).status, 404, path);
    }
  });

  await t.test("case aliases do not expose private files on case-insensitive filesystems", async (t) => {
    if (!await stat(join(root, dataName.toUpperCase())).catch(() => null)) {
      t.skip("the fixture filesystem is case-sensitive");
      return;
    }
    for (const path of [upperUrl, `${upperUrl}~`, `${upperUrl}.~1~`,
      "/EXAMPLES/SERVER/DATA/NOTES.ELD", "/DATA-ALIAS/NOTES.ELD"]) {
      assert.equal((await request(path)).status, 404, path);
    }
  });

  await t.test("API origin checks and normal persisted actions still work", async () => {
    assert.equal((await request("/api/notes", { headers: { Origin: "https://attacker.invalid" } })).status, 403);
    const response = await request("/api/notes", {
      method: "POST", headers: { Origin: origin }, body: '(add "NORMAL_NOTE")',
    });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /NORMAL_NOTE/);
    assert.match(await readFile(dataFile, "utf8"), /NORMAL_NOTE/);
    assert.match(await (await request("/api/notes")).text(), /NORMAL_NOTE/);
  });

  await t.test("Unicode backup aliases stay private without an original; distinct public names still work", async () => {
    const saved = await readFile(dataFile);
    await unlink(dataFile);
    const decomposedName = `${dataName.normalize("NFD")}~`;
    const decomposedFile = join(root, decomposedName);
    const originalBackup = await stat(`${dataFile}~`);
    const alias = await stat(decomposedFile).catch(() => null);
    const sameFile = alias && alias.dev === originalBackup.dev && alias.ino === originalBackup.ino;
    if (!sameFile) await writeFile(decomposedFile, "PUBLIC_DISTINCT_UNICODE_NAME");
    assert.equal((await request(`${dataUrl}~`)).status, 404);
    const response = await request(`/${encodeURIComponent(decomposedName)}`);
    assert.equal(response.status, sameFile ? 404 : 200);
    if (!sameFile) {
      assert.equal(await response.text(), "PUBLIC_DISTINCT_UNICODE_NAME");
      await unlink(decomposedFile);
    }
    // A different Unicode backup is an ordinary public fixture, not a note.
    await writeFile(join(root, "résumé.eld~"), "PUBLIC_OTHER_BACKUP");
    assert.equal(await (await request(`/${encodeURIComponent("résumé.eld~")}`)).text(), "PUBLIC_OTHER_BACKUP");
    await writeFile(dataFile, saved);
  });

  await t.test("configured symlink names and backups stay private after deleting the original", async () => {
    const actual = join(root, "actual-notes.eld");
    await rename(dataFile, actual);
    await symlink(actual, dataFile);
    await writeFile(`${actual}~`, "PRIVATE_TARGET_BACKUP");
    for (const path of [dataUrl, "/actual-notes.eld", `${dataUrl}~`, "/actual-notes.eld~"]) {
      assert.equal((await request(path)).status, 404, path);
    }
    await unlink(actual);
    for (const path of [`${dataUrl}~`, `${dataUrl}.~1~`, "/backup-alias.txt", "/actual-notes.eld~"]) {
      assert.equal((await request(path)).status, 404, path);
    }
    if (await stat(`${dataFile.toUpperCase()}~`).catch(() => null)) {
      assert.equal((await request(`${upperUrl}~`)).status, 404);
    }
  });
});
