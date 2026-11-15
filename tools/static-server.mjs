// A static file server for development and tests.
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const mimeTypes = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json",
  ".wasm": "application/wasm", ".el": "text/plain; charset=utf-8",
};

/** Serve the directory ROOT on PORT (0: any free port).  Resolves with { server, origin }. */
export async function serveDirectory(root, { port = 0, host = "127.0.0.1" } = {}) {
  root = resolve(root);
  const server = createServer((request, response) => {
    let path = normalize(decodeURIComponent(new URL(request.url, "http://localhost").pathname));
    let file = join(root, path);
    if (file.startsWith(root) && existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith("/")) {
        response.writeHead(301, { Location: `${path}/` }).end();
        return;
      }
      file = join(file, "index.html");
    }
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
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
    const size = statSync(file).size;
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || "");
    if (range && Number(range[1]) <= Number(range[2]) && Number(range[1]) < size) {
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), size - 1);
      response.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, headers);
    createReadStream(file).pipe(response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  return { server, origin: `http://${host}:${server.address().port}` };
}
