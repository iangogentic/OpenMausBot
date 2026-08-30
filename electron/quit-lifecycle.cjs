"use strict";

const DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS = 65_000;
const DEFAULT_AUXILIARY_CLEANUP_TIMEOUT_MS = 2_500;

function bounded(promise, timeoutMs, timers = {}) {
  const schedule = timers.setTimeout ?? setTimeout;
  const cancel = timers.clearTimeout ?? clearTimeout;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      cancel(timer);
      resolve(value);
    };
    const timer = schedule(() => finish({ status: "timeout" }), timeoutMs);
    timer?.unref?.();
    Promise.resolve(promise).then(
      (value) => finish({ status: "fulfilled", value }),
      (error) => finish({ status: "rejected", error }),
    );
  });
}

/** Attach immediately after fork. Keeping this promise for the lifetime of the
 * utility process means quit cannot miss an exit that happened before the user
 * closed the app, nor one emitted synchronously by kill() in a test/fake. */
function trackUtilityProcessExit(child) {
  if (!child?.once) {
    throw new TypeError("a utility process with an exit event is required");
  }
  return new Promise((resolve) => {
    child.once("exit", (code) => {
      resolve({ code: Number.isInteger(code) ? code : null });
    });
  });
}

async function stopServer(child, exitPromise, timeoutMs, timers) {
  if (!child || !exitPromise) return { ok: true, status: "not-running", code: null };

  let requestError = null;
  try {
    child.kill();
  } catch (error) {
    requestError = error;
  }

  const exit = await bounded(exitPromise, timeoutMs, timers);
  if (exit.status === "timeout") {
    return { ok: false, status: "timeout", code: null, requestError };
  }
  if (exit.status === "rejected") {
    return { ok: false, status: "exit-observer-failed", code: null, error: exit.error, requestError };
  }

  const code = exit.value?.code ?? null;
  return code === 0
    ? { ok: true, status: "exited", code }
    : { ok: false, status: "abnormal-exit", code, requestError };
}

/** Run CUA/bridge cleanup and packaged-server shutdown concurrently, but give
 * them independent bounds. A slow, healthy server is never cut off merely
 * because the short CUA cleanup budget elapsed. */
async function runQuitLifecycle({
  serverProcess = null,
  serverExit = null,
  stopAuxiliaries = () => Promise.resolve(),
  serverTimeoutMs = DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS,
  auxiliaryTimeoutMs = DEFAULT_AUXILIARY_CLEANUP_TIMEOUT_MS,
  timers,
} = {}) {
  const auxiliaryPromise = Promise.resolve().then(stopAuxiliaries);
  const [server, auxiliaries] = await Promise.all([
    stopServer(serverProcess, serverExit, serverTimeoutMs, timers),
    bounded(auxiliaryPromise, auxiliaryTimeoutMs, timers),
  ]);
  return { ok: server.ok, server, auxiliaries };
}

module.exports = {
  DEFAULT_AUXILIARY_CLEANUP_TIMEOUT_MS,
  DEFAULT_SERVER_SHUTDOWN_TIMEOUT_MS,
  bounded,
  runQuitLifecycle,
  trackUtilityProcessExit,
};
