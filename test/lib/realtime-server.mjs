// A server for the realtime tests: server-sent events at /events and a
// WebSocket echo at /echo.  Plain node:http, no dependencies.
import { createHash } from "node:crypto";
import { createServer } from "node:http";

function frame(opcode, payload) {
  const length = payload.length;
  const header = length < 126 ? Buffer.from([0x80 | opcode, length])
    : Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  return Buffer.concat([header, payload]);
}

export async function realtimeServer() {
  const server = createServer((request, response) => {
    if (request.url === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store",
                                "Access-Control-Allow-Origin": "*" });
      response.write("data: one\n\n");
      setTimeout(() => response.write("event: tick\nid: 9\ndata: two\n\n"), 100);
      return;
    }
    response.writeHead(404).end();
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buffered = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffered = Buffer.concat([buffered, chunk]);
      while (buffered.length >= 6) {
        const opcode = buffered[0] & 0x0f;
        let length = buffered[1] & 0x7f, offset = 2;
        if (length === 126) { length = buffered.readUInt16BE(2); offset = 4; }
        if (buffered.length < offset + 4 + length) return;
        const mask = buffered.subarray(offset, offset + 4);
        const payload = Buffer.from(buffered.subarray(offset + 4, offset + 4 + length).map((byte, i) => byte ^ mask[i % 4]));
        buffered = buffered.subarray(offset + 4 + length);
        // "bye" makes the server close the connection (1000, "done").
        if (opcode === 1 && String(payload) === "bye") { socket.write(frame(8, Buffer.concat([Buffer.from([0x03, 0xe8]), Buffer.from("done")]))); socket.end(); }
        else if (opcode === 1) socket.write(frame(1, Buffer.from(`echo: ${payload}`)));
        if (opcode === 8) { socket.write(frame(8, Buffer.from([0x03, 0xe8]))); socket.end(); }
      }
    });
    socket.on("error", () => {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
