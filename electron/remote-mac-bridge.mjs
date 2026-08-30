// Compatibility tombstone for the retired reverse-port bridge.
//
// Older builds persisted a bearer beside cua-connection.json and listened on
// a reverse-forwarded TCP port. A provider shell sharing the server Unix UID
// could read that bearer and invoke physical CUA outside turn/action gates.
// Keeping these exports fail-closed gives stale imports an explicit error
// while ensuring no listener or secret file can ever be recreated.

const RETIRED =
  "The reverse-port physical bridge was retired for security; use the authenticated outbound app bridge";

export function ensureRemoteMacBridgeToken() {
  throw new Error(RETIRED);
}

export function ensureRemoteDeviceBridgeToken() {
  throw new Error(RETIRED);
}

export async function startRemoteMacBridge() {
  throw new Error(RETIRED);
}

export async function startRemoteDeviceBridge() {
  throw new Error(RETIRED);
}
