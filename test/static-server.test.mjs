import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serveDirectory } from "../tools/static-server.mjs";

// Keep the raw path: fetch/new URL would normalize traversal probes first.
function get(origin, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(origin, { path, headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
      response.on("error", reject);
    });
    req.on("error", reject);
    req.end();
  });
}

test("static files stay inside the public root", async (t) => {
  const fixture = mkdtempSync(join(tmpdir(), "elisp-react-static-"));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, "site");
  const write = (path, text) => writeFileSync(join(fixture, path), text);
  for (const dir of ["site", "site/public", "site/a b", "site/.hidden", "site/.git", "site/hidden-index", "site/outside-index", "site-prefix", "outside"]) {
    mkdirSync(join(fixture, dir), { recursive: true });
  }
  write("site/index.html", "home");
  write("site/public/index.html", "public index");
  write("site/a b/index.html", "space index");
  write("site/public/data.txt", "0123456789");
  for (const path of ["site/.env", "site/.hidden/secret.txt", "site/.git/config", "site-prefix/secret.txt", "outside/secret.txt"]) {
    write(path, "private fixture");
  }
  symlinkSync(join(root, "public/data.txt"), join(root, "inside-file"));
  symlinkSync(join(root, "public"), join(root, "inside-dir"));
  symlinkSync(join(fixture, "outside/secret.txt"), join(root, "outside-file"));
  symlinkSync(join(fixture, "site-prefix/secret.txt"), join(root, "prefix-file"));
  symlinkSync(join(fixture, "outside"), join(root, "outside-dir"));
  symlinkSync(join(fixture, "outside/secret.txt"), join(root, "outside-index/index.html"));
  symlinkSync(join(root, ".env"), join(root, "hidden-file"));
  symlinkSync(join(root, ".hidden"), join(root, "hidden-dir"));
  symlinkSync(join(root, ".hidden/secret.txt"), join(root, "hidden-index/index.html"));
  // A configured root may itself be a symlink (e.g. a development checkout).
  symlinkSync(root, join(fixture, "root-link"));
  const { server, origin } = await serveDirectory(join(fixture, "root-link"), { excludePaths: ["private-data"] });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));

  await t.test("serves ordinary and percent-encoded public paths", async () => {
    for (const [path, body] of [["/", "home"], ["/public/data.txt", "0123456789"], ["/a%20b/", "space index"], ["/%70ublic/data.txt", "0123456789"]]) {
      const result = await get(origin, path);
      assert.equal(result.status, 200, path);
      assert.equal(result.body, body, path);
      assert.equal(result.headers["access-control-allow-origin"], "*");
    }
    const redirect = await get(origin, "/a%20b?test=1");
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.location, "/a%20b/?test=1");
  });

  await t.test("allows symlinks to public files and directories inside the root", async () => {
    for (const [path, body] of [["/inside-file", "0123456789"], ["/inside-dir/", "public index"], ["/inside-dir/data.txt", "0123456789"]]) {
      const result = await get(origin, path);
      assert.equal(result.status, 200, path);
      assert.equal(result.body, body, path);
    }
  });

  await t.test("rejects traversal to sibling names sharing the root prefix", async () => {
    for (const path of ["/..%2fsite-prefix/secret.txt", "/%2e%2e%2fsite-prefix/secret.txt", "/public/..%2f..%2fsite-prefix/secret.txt", "/..%5csite-prefix/secret.txt"]) {
      const result = await get(origin, path);
      assert.equal(result.status, 404, path);
      assert.equal(result.body, "not found", path);
    }
  });

  await t.test("rejects outside file and directory symlinks", async () => {
    for (const path of ["/outside-file", "/prefix-file", "/outside-dir", "/outside-dir/secret.txt", "/outside-index/"]) {
      assert.equal((await get(origin, path)).status, 404, path);
    }
  });

  await t.test("excludes configured private data even when created after startup or aliased", async () => {
    mkdirSync(join(root, "private-data"));
    write("site/private-data/notes.eld", "private notes");
    symlinkSync(join(root, "private-data"), join(root, "notes-alias"));
    symlinkSync(join(root, "private-data/notes.eld"), join(root, "notes.eld"));
    mkdirSync(join(root, "private-data-public"));
    write("site/private-data-public/notes.eld", "public example data");
    for (const path of ["/private-data/notes.eld", "/notes-alias/notes.eld", "/notes.eld",
                        "/PRIVATE-DATA/NOTES.ELD", "/NOTES-ALIAS/NOTES.ELD", "/NOTES.ELD"]) {
      assert.equal((await get(origin, path)).status, 404, path);
    }
    assert.equal((await get(origin, "/private-data-public/notes.eld")).body, "public example data");
    // On case-insensitive filesystems these are real aliases, not missing
    // paths. Public case aliases must still work while private ones fail.
    if (existsSync(join(root, "PUBLIC/DATA.TXT"))) {
      assert.equal((await get(origin, "/PUBLIC/DATA.TXT")).body, "0123456789");
      const alternate = await serveDirectory(join(fixture, "ROOT-LINK"), { excludePaths: ["PRIVATE-DATA"] });
      try {
        assert.equal((await get(alternate.origin, "/private-data/notes.eld")).status, 404);
        assert.equal((await get(alternate.origin, "/NOTES.ELD")).status, 404);
        assert.equal((await get(alternate.origin, "/public/data.txt")).body, "0123456789");
      } finally {
        await new Promise((resolve, reject) => alternate.server.close((error) => error ? reject(error) : resolve()));
      }
    }
  });

  await t.test("rejects hidden paths, visible aliases, and hidden index targets", async () => {
    for (const path of ["/.env", "/%2eenv", "/.hidden/secret.txt", "/.git/config", "/hidden-file", "/hidden-dir", "/hidden-dir/secret.txt", "/hidden-index/"]) {
      const result = await get(origin, path);
      assert.equal(result.status, 404, path);
      assert.equal(result.body, "not found", path);
    }
  });

  await t.test("keeps byte ranges and cross-origin responses", async () => {
    const result = await get(origin, "/public/data.txt", { Range: "bytes=2-5", Origin: "https://example.test" });
    assert.equal(result.status, 206);
    assert.equal(result.body, "2345");
    assert.equal(result.headers["content-range"], "bytes 2-5/10");
    assert.equal(result.headers["content-length"], "4");
    assert.equal(result.headers["access-control-allow-origin"], "*");
  });

  await t.test("malformed encodings fail without stopping the server", async () => {
    for (const path of ["/%", "/%GG", "/%E0%A4"]) assert.equal((await get(origin, path)).status, 400, path);
    assert.equal((await get(origin, "/%00")).status, 404);
    assert.equal((await get(origin, "/")).body, "home");
  });
});
