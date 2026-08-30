const DEFAULT_MAX_DESKTOP_VIEWERS = 16;

function desktopViewerContextId(rawContextId) {
  if (Object.prototype.toString.call(rawContextId) !== "[object String]") {
    throw new Error("A desktop viewer context is required");
  }
  const contextId = rawContextId.trim();
  if (!contextId) throw new Error("A desktop viewer context is required");
  if (contextId.length > 120) throw new Error("The desktop viewer context is too long");
  if (/[\u0000-\u001f\u007f]/u.test(contextId)) {
    throw new Error("The desktop viewer context is invalid");
  }
  return contextId;
}

/**
 * Identity-fenced lifecycle registry for Electron desktop authority windows.
 *
 * A context is one bot. Different contexts coexist; replacing a context first
 * publishes the new record and then destroys only the old record. Publishing
 * first is intentional: Electron emits `closed` synchronously from destroy(),
 * and that stale callback must not delete or notify for the replacement.
 */
function createDesktopViewerRegistry(options) {
  const {
    destroyViewer,
    isViewerDestroyed,
    isOwnerDestroyed,
    notifyOwner,
    maxViewers = DEFAULT_MAX_DESKTOP_VIEWERS,
  } = options ?? {};
  if (typeof destroyViewer !== "function" || typeof isViewerDestroyed !== "function") {
    throw new Error("Desktop viewer destruction hooks are required");
  }
  if (typeof isOwnerDestroyed !== "function" || typeof notifyOwner !== "function") {
    throw new Error("Desktop viewer owner hooks are required");
  }
  if (!Number.isSafeInteger(maxViewers) || maxViewers < 1 || maxViewers > 64) {
    throw new Error("The desktop viewer limit is invalid");
  }

  const records = new Map();

  const liveRecord = (contextId) => {
    const record = records.get(contextId);
    if (!record) return null;
    if (!isViewerDestroyed(record.viewer)) return record;
    // Electron normally delivers `closed` synchronously from destroy(). If a
    // platform delay lets a state query observe destruction first, perform
    // the exact same identity-fenced cleanup and notification here.
    handleClosed(record);
    return null;
  };

  const owns = (record, owner) => Boolean(owner && record.owner === owner);

  const liveCount = () => {
    let count = 0;
    for (const contextId of records.keys()) {
      if (liveRecord(contextId)) count += 1;
    }
    return count;
  };

  const sendState = (record, open) => {
    if (!record || isOwnerDestroyed(record.owner)) return;
    try {
      notifyOwner(record.owner, { open, contextId: record.contextId });
    } catch {
      // The owning renderer may disappear between isDestroyed() and send().
      // Its server lease is short-lived; never crash main while reporting the
      // already-enforced viewer destruction boundary.
    }
  };

  const handleClosed = (record) => {
    if (!record || records.get(record.contextId) !== record) return false;
    records.delete(record.contextId);
    sendState(record, false);
    return true;
  };

  const destroyRecord = (record) => {
    if (!record || isViewerDestroyed(record.viewer)) {
      handleClosed(record);
      return true;
    }
    destroyViewer(record.viewer);
    if (isViewerDestroyed(record.viewer)) handleClosed(record);
    return isViewerDestroyed(record.viewer);
  };

  const isCurrent = (record) => Boolean(record && liveRecord(record.contextId) === record);

  return {
    contextId: desktopViewerContextId,

    install(rawContextId, record) {
      const contextId = desktopViewerContextId(rawContextId);
      if (!record || !record.viewer || !record.owner) {
        throw new Error("A desktop viewer record is required");
      }
      const previous = liveRecord(contextId);
      if (previous?.owner !== undefined && previous.owner !== record.owner) {
        throw new Error("A different renderer document owns this desktop viewer");
      }
      if (!previous && liveCount() >= maxViewers) {
        throw new Error(`At most ${maxViewers} live desktop viewers may be open`);
      }

      record.contextId = contextId;
      records.set(contextId, record);
      if (previous && previous !== record && !destroyRecord(previous)) {
        // Never allow a replacement to coexist with an old interactive window
        // for the same bot. Destroy the new window and restore the old record
        // as the only tracked authority if Electron fails to tear the old one
        // down synchronously.
        records.delete(contextId);
        destroyRecord(record);
        if (!isViewerDestroyed(previous.viewer)) records.set(contextId, previous);
        throw new Error("The previous live desktop could not be closed");
      }
      return contextId;
    },

    isCurrent(record) {
      return isCurrent(record);
    },

    state(rawContextId, owner) {
      const contextId = desktopViewerContextId(rawContextId);
      const record = liveRecord(contextId);
      return {
        open: Boolean(record && owns(record, owner)),
        contextId,
      };
    },

    states(owner) {
      const states = [];
      for (const contextId of [...records.keys()]) {
        const record = liveRecord(contextId);
        if (record && owns(record, owner)) states.push({ open: true, contextId });
      }
      return states;
    },

    notifyOpen(record) {
      if (!isCurrent(record)) return false;
      sendState(record, true);
      return true;
    },

    close(rawContextId, owner) {
      const contextId = desktopViewerContextId(rawContextId);
      const record = liveRecord(contextId);
      if (!record || !owns(record, owner)) return false;
      return destroyRecord(record);
    },

    closeRecord(record) {
      if (!isCurrent(record)) return false;
      return destroyRecord(record);
    },

    handleClosed,

    size() {
      return liveCount();
    },
  };
}

module.exports = {
  DEFAULT_MAX_DESKTOP_VIEWERS,
  createDesktopViewerRegistry,
  desktopViewerContextId,
};
