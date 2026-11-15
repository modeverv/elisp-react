// A static file server for development and tests.
import { createReadStream, realpathSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".el": "text/plain; charset=utf-8",
};

/** Serve ROOT on PORT (0: any free port), except hidden files and EXCLUDEPATHS.
 * Exclusions are relative to ROOT and also apply through symlink aliases.
 * Resolves with { server, origin }.
 */
export async function serveDirectory(root, { port = 0, host = "127.0.0.1", excludePaths = [] } = {}) {
  // The native implementation also resolves actual on-disk casing on macOS.
  // The JS implementation preserves input case there, bypassing exclusions.
  root = realpathSync.native(resolve(root));
  const exclusions = excludePaths.map((path) => resolve(root, path));
  const contains = (directory, file) => {
    const path = relative(directory, file);
    return !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
  };
  // Check the target too: a visible symlink (including index.html) must not
  // expose an outside file or a hidden file under the served directory.
  const publicFile = (file) => {
    const target = realpathSync.native(file);
    const path = relative(root, target);
    if (!contains(root, target) || path.split(sep).some((part) => part.startsWith("."))) return null;
    if (exclusions.some((excluded) => {
      // The excluded directory need not exist when the server starts.
      let canonical = excluded;
      try { canonical = realpathSync.native(excluded); } catch { /* not created yet */ }
      return contains(excluded, file) || contains(canonical, target);
    })) return null;
    return target;
  };
  const server = createServer((request, response) => {
    let url, path;
    try {
      url = new URL(request.url, "http://localhost");
      path = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end("bad request");
      return;
    }
    if (path.includes("\0") || path.includes("\\") || path.split("/").some((part) => part.startsWith("."))) {
      response.writeHead(404).end("not found");
      return;
    }
    let file, info;
    try {
      file = publicFile(join(root, path));
      if (file && statSync(file).isDirectory()) {
        if (!path.endsWith("/")) {
          // Encode path components again and keep a single leading slash:
          // decoded ?, #, or // must not change the redirect's destination.
          const location = path.split("/").map(encodeURIComponent).join("/").replace(/^\/+/, "/");
          response.writeHead(301, { Location: `${location}/${url.search}` }).end();
          return;
        }
        file = publicFile(join(file, "index.html"));
      }
      info = file && statSync(file);
    } catch { /* Missing or inaccessible files are not public. */ }
    if (!info?.isFile()) {
      response.writeHead(404).end("not found");
      return;
    }
    // Like GitHub Pages: any origin may read the files, and a part of one
    // (Emacs reads its Lisp files as ranges of one large file).
    const headers = {
      "Content-Type": mimeTypes[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    };
    const size = info.size;
    const send = (options) => {
      const stream = createReadStream(file, options);
      stream.on("error", () => response.destroy());
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    };
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
    if (range && Number(range[1]) <= Number(range[2]) && Number(range[1]) < size) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), size - 1);
      response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      send({ start, end });
      return;
    }
    response.writeHead(200, headers);
    send();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { server, origin: `http://${host}:${server.address().port}` };
}
