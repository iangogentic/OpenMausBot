/**
 * Keep a remote renderer recoverable without reloading a healthy document for
 * an unrelated, transient health-probe miss. The renderer's own EventSource
 * reconnects when the server comes back; a full load is needed only when the
 * main document itself failed to load.
 */
export function watchRemoteServer(
  win,
  serverUrl,
  {
    fetchImpl = globalThis.fetch,
    setIntervalImpl = globalThis.setInterval,
    clearIntervalImpl = globalThis.clearInterval,
    timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
  } = {},
) {
  if (!serverUrl) return () => {};
  let loadFailed = false;
  let checking = false;
  let consecutiveFailures = 0;
  let confirmedOutage = false;

  const onFailedLoad = (_event, _code, _description, url, isMainFrame) => {
    if (isMainFrame !== false && url.startsWith(serverUrl)) {
      loadFailed = true;
    }
  };
  win.webContents.on("did-fail-load", onFailedLoad);

  const check = async () => {
    if (checking || win.isDestroyed()) return;
    checking = true;
    let reachable = false;
    try {
      const response = await fetchImpl(`${serverUrl}/api/health`, {
        signal: timeoutSignal(2_000),
      });
      reachable = response.ok;
    } catch {
      reachable = false;
    } finally {
      checking = false;
    }

    if (!reachable) {
      consecutiveFailures += 1;
      // Three bounded probes span at least six seconds. That filters a single
      // tunnel/latency wobble but still reloads the shipped UI after a real
      // backend restart or deploy, avoiding a stale protocol bundle forever.
      if (consecutiveFailures >= 3) confirmedOutage = true;
      return;
    }

    // A background health miss does not mean Chromium lost its document. Its
    // SSE client recovers in place and retains navigation/drafts. Reload only
    // after Electron reports that the main document itself failed.
    const shouldReload = loadFailed || confirmedOutage;
    consecutiveFailures = 0;
    confirmedOutage = false;
    if (shouldReload && !win.isDestroyed()) {
      loadFailed = false;
      void win.loadURL(serverUrl).catch(() => {
        loadFailed = true;
      });
    }
  };

  const timer = setIntervalImpl(() => void check(), 3_000);
  timer.unref?.();
  const stop = () => {
    clearIntervalImpl(timer);
    win.webContents.removeListener?.("did-fail-load", onFailedLoad);
  };
  win.once("closed", stop);
  void check();
  return stop;
}
