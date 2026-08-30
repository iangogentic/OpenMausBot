export const MAX_EVENT_STREAMS_PER_DEVICE = 2;
export const MAX_EVENT_STREAMS_GLOBAL = 32;
export const MAX_IN_FLIGHT_REQUESTS_PER_DEVICE = 8;
export const MAX_IN_FLIGHT_REQUESTS_GLOBAL = 64;

export interface ConnectedDeviceLimits {
  maxStreamsPerDevice: number;
  maxStreamsGlobal: number;
  maxRequestsPerDevice: number;
  maxRequestsGlobal: number;
}

const DEFAULT_LIMITS: ConnectedDeviceLimits = Object.freeze({
  maxStreamsPerDevice: MAX_EVENT_STREAMS_PER_DEVICE,
  maxStreamsGlobal: MAX_EVENT_STREAMS_GLOBAL,
  maxRequestsPerDevice: MAX_IN_FLIGHT_REQUESTS_PER_DEVICE,
  maxRequestsGlobal: MAX_IN_FLIGHT_REQUESTS_GLOBAL,
});

/** Count live authenticated event streams per device. A phone may briefly
 * overlap old and replacement streams while changing routes, so presence is a
 * reference count rather than a boolean. */
export function createConnectedDeviceTracker(limits: ConnectedDeviceLimits = DEFAULT_LIMITS) {
  interface ConnectedStream {
    closed: boolean;
    terminate: () => void;
  }

  const streams = new Map<string, Set<ConnectedStream>>();
  let streamCount = 0;

  /**
   * Requests need the same revocation property as event streams, but they
   * must not make a device look "connected" in the settings UI. Keep this
   * separate from `streams`: `ids()` deliberately continues to mean a live
   * event subscription, while `disconnect()` tears down both kinds.
   *
   * A cloud-desktop request is indexed separately because removing that
   * capability must kill a pending desktop join without needlessly dropping
   * the phone's ordinary chat/event connection.
   */
  interface InFlightRequest {
    closed: boolean;
    terminate: () => void;
    cloudDesktop: boolean;
  }
  const requests = new Map<string, Set<InFlightRequest>>();
  let requestCount = 0;

  const open = (deviceId: string, terminate: () => void = () => {}): (() => void) | null => {
    const active = streams.get(deviceId) ?? new Set<ConnectedStream>();
    if (active.size >= limits.maxStreamsPerDevice || streamCount >= limits.maxStreamsGlobal) return null;
    const stream = { closed: false, terminate };
    active.add(stream);
    streamCount += 1;
    streams.set(deviceId, active);
    return () => {
      if (stream.closed) return;
      stream.closed = true;
      streamCount = Math.max(0, streamCount - 1);
      const current = streams.get(deviceId);
      current?.delete(stream);
      if (current?.size === 0) streams.delete(deviceId);
    };
  };

  const ids = (): string[] => [...streams.keys()];

  const openRequest = (
    deviceId: string,
    terminate: () => void = () => {},
    scope: { cloudDesktop?: boolean } = {},
  ): (() => void) | null => {
    const active = requests.get(deviceId) ?? new Set<InFlightRequest>();
    if (active.size >= limits.maxRequestsPerDevice || requestCount >= limits.maxRequestsGlobal) return null;
    const request = { closed: false, terminate, cloudDesktop: scope.cloudDesktop === true };
    active.add(request);
    requestCount += 1;
    requests.set(deviceId, active);
    return () => {
      if (request.closed) return;
      request.closed = true;
      requestCount = Math.max(0, requestCount - 1);
      const current = requests.get(deviceId);
      current?.delete(request);
      if (current?.size === 0) requests.delete(deviceId);
    };
  };

  const terminateRequests = (deviceId: string, onlyCloudDesktop = false): boolean => {
    const active = requests.get(deviceId);
    if (!active) return false;
    let terminated = false;
    for (const request of [...active]) {
      if (request.closed || (onlyCloudDesktop && !request.cloudDesktop)) continue;
      request.closed = true;
      requestCount = Math.max(0, requestCount - 1);
      active.delete(request);
      terminated = true;
      try {
        request.terminate();
      } catch {
        // A broken response socket must not leave a second request running.
      }
    }
    if (active.size === 0) requests.delete(deviceId);
    return terminated;
  };

  const disconnect = (deviceId: string): boolean => {
    const active = streams.get(deviceId);
    const requestsDisconnected = terminateRequests(deviceId);
    if (!active) return requestsDisconnected;
    // Remove presence before terminating sockets. Their close handlers call
    // the per-stream cleanup again, which must be an idempotent no-op.
    streams.delete(deviceId);
    for (const stream of active) {
      if (stream.closed) continue;
      stream.closed = true;
      streamCount = Math.max(0, streamCount - 1);
      try {
        stream.terminate();
      } catch {
        // One broken socket must not keep the other revoked streams alive.
      }
    }
    return true;
  };

  /** Remove only in-flight full-desktop requests after that grant is revoked.
   * Ordinary companion requests remain alive; they have not lost their
   * device credential. */
  const disconnectCloudDesktop = (deviceId: string): boolean => terminateRequests(deviceId, true);

  return Object.freeze({ open, openRequest, ids, disconnect, disconnectCloudDesktop });
}
