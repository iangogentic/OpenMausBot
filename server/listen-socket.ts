import { chmodSync } from "node:fs";
import type { Server } from "node:http";
import { isAbsolute } from "node:path";

const MAX_UNIX_SOCKET_BYTES = 96;

/** Validate an optional private HTTP Unix-socket endpoint.
 *
 * Production uses a systemd-owned TCP socket in front of this private UDS.
 * We deliberately never unlink here: removing an unexpected path from a
 * process environment would cross the service's authority boundary. The
 * service manager owns stale-socket cleanup for the exact configured path.
 */
export function privateListenSocket(
  raw: string | undefined,
  options: { platform?: NodeJS.Platform; label?: string } = {},
): string | null {
  const value = raw?.trim() ?? "";
  if (!value) return null;
  const label = options.label ?? "listen";
  const platform = options.platform ?? process.platform;
  if (
    platform === "win32" ||
    !isAbsolute(value) ||
    !value.endsWith(".sock") ||
    /[\0\r\n]/.test(value) ||
    Buffer.byteLength(value) > MAX_UNIX_SOCKET_BYTES
  ) {
    throw new Error(`${label} socket must be an absolute Unix-socket path ending in .sock`);
  }
  return value;
}

/** Bind a harness HTTP server to a private UDS or the ordinary loopback TCP
 * endpoint. Socket permissions are tightened before startup is announced.
 */
export async function listenHarnessServer(
  server: Server,
  options: { port: number; socketPath?: string; host?: string },
): Promise<{ socketPath: string | null; displayUrl: string }> {
  const host = options.host ?? "127.0.0.1";
  const socketPath = privateListenSocket(options.socketPath, { label: "harness listen" });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      if (socketPath) {
        try {
          chmodSync(socketPath, 0o600);
        } catch (error) {
          server.close();
          reject(error);
          return;
        }
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    if (socketPath) server.listen(socketPath);
    else server.listen(options.port, host);
  });
  // The public URL remains the systemd-owned TCP endpoint even when the
  // harness itself is reachable only through the private socket.
  return { socketPath, displayUrl: `http://${host}:${options.port}` };
}
