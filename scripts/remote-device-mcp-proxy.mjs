#!/usr/bin/node
import fs from "node:fs";
import net from "node:net";

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const host = option("--host", "127.0.0.1");
const port = Number(option("--port", "18798"));
const tokenFile = option("--token-file", "");
if (host !== "127.0.0.1" || !Number.isInteger(port) || port < 1024 || port > 65535 || !tokenFile) {
  process.stderr.write("Invalid remote physical-device bridge configuration\n");
  process.exit(64);
}

let token;
try {
  const stat = fs.lstatSync(tokenFile);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error();
  token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error();
} catch {
  process.stderr.write("Remote physical-device bridge token is unavailable or unsafe\n");
  process.exit(78);
}

const socket = net.createConnection({ host, port });
let handshake = Buffer.alloc(0);
let ready = false;
let queued = [];
const fail = (message, code = 1) => {
  if (message) process.stderr.write(`${message}\n`);
  socket.destroy();
  process.exitCode = code;
};

process.stdin.on("data", (chunk) => {
  if (ready) socket.write(chunk);
  else queued.push(Buffer.from(chunk));
});
process.stdin.on("end", () => {
  if (ready) socket.end();
});
process.stdin.on("error", () => socket.destroy());

socket.setTimeout(10_000, () => fail("Remote physical-device bridge timed out"));
socket.once("connect", () => socket.write(`OMB-DEVICE-BRIDGE/1 ${token}\n`));
socket.on("data", function receive(chunk) {
  if (ready) {
    process.stdout.write(chunk);
    return;
  }
  handshake = Buffer.concat([handshake, chunk]);
  const newline = handshake.indexOf(0x0a);
  if (newline < 0) {
    if (handshake.length > 64) fail("Invalid remote physical-device bridge handshake");
    return;
  }
  const response = handshake.subarray(0, newline).toString("utf8").replace(/\r$/, "");
  if (response !== "OK") {
    fail(response === "DENIED" ? "Physical-device access was denied" : "Physical device is unavailable", 77);
    return;
  }
  ready = true;
  socket.setTimeout(0);
  const remainder = handshake.subarray(newline + 1);
  if (remainder.length) process.stdout.write(remainder);
  for (const buffered of queued) socket.write(buffered);
  queued = [];
});
socket.once("error", (error) => fail(`Remote physical-device bridge connection failed: ${error.message}`));
socket.once("close", () => {
  if (!ready && process.exitCode === undefined) fail("Remote physical-device bridge closed before authentication");
  process.stdin.pause();
});
process.once("SIGTERM", () => socket.destroy());
process.once("SIGINT", () => socket.destroy());
