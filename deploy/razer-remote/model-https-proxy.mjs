import http from "node:http";
import https from "node:https";

const LISTEN_HOST = "127.0.0.1";
const LISTEN_PORT = 18011;
const UPSTREAM_HOST = "models.zai-brain.com";
const MAX_REQUEST_BYTES = 256 * 1024 * 1024;

const server = http.createServer((request, response) => {
  if (!request.url?.startsWith("/v1/") || !["GET", "POST"].includes(request.method ?? "")) {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
    return;
  }

  let received = 0;
  request.on("data", (chunk) => {
    received += chunk.length;
    if (received > MAX_REQUEST_BYTES) request.destroy(new Error("request too large"));
  });

  const headers = { ...request.headers, host: UPSTREAM_HOST };
  delete headers.connection;
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];

  const upstream = https.request({
    protocol: "https:",
    hostname: UPSTREAM_HOST,
    port: 443,
    servername: UPSTREAM_HOST,
    method: request.method,
    path: request.url,
    headers,
    rejectUnauthorized: true,
    timeout: 10 * 60_000,
  });

  upstream.on("response", (incoming) => {
    const responseHeaders = { ...incoming.headers };
    delete responseHeaders.connection;
    response.writeHead(incoming.statusCode ?? 502, responseHeaders);
    incoming.pipe(response);
  });
  upstream.on("timeout", () => upstream.destroy(new Error("upstream timeout")));
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "application/json" });
    response.end('{"error":"model gateway unavailable"}');
  });
  request.on("error", () => upstream.destroy());
  request.pipe(upstream);
});

server.requestTimeout = 11 * 60_000;
server.headersTimeout = 30_000;
server.keepAliveTimeout = 5_000;
server.maxRequestsPerSocket = 128;
server.listen(LISTEN_PORT, LISTEN_HOST);
