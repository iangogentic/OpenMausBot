export interface TimedPreviewFrame {
  at: number;
}

export interface TargetedPreviewFrame {
  targetKey: string;
  targetGeneration: string;
}

/** Live SSE is authoritative only for the exact computer and dispatch the
 * panel most recently resolved from the server. */
export function frameMatchesPreviewTarget(
  frame: TargetedPreviewFrame | null | undefined,
  targetKey: string | null,
  targetGeneration: string | null,
): boolean {
  return Boolean(
    frame &&
      targetKey &&
      targetGeneration &&
      frame.targetKey === targetKey &&
      frame.targetGeneration === targetGeneration,
  );
}

/** A transcript frame may be the idle last-known fallback for one computer,
 * but an active dispatch must never inherit a same-machine frame from the
 * previous turn. */
export function historicalFrameMatchesPreviewTarget(
  frame: Partial<TargetedPreviewFrame> | null | undefined,
  targetKey: string | null,
  targetGeneration: string | null,
): boolean {
  return Boolean(
    frame &&
      targetKey &&
      frame.targetKey === targetKey &&
      (!targetGeneration || frame.targetGeneration === targetGeneration),
  );
}

/** Pick by capture time, not by transport priority. A delayed SSE message is
 * not more authoritative than a newer exact-target poll. */
export function newestPreviewFrame<T extends TimedPreviewFrame>(
  frames: Array<T | null | undefined>,
): T | null {
  let newest: T | null = null;
  for (const frame of frames) {
    if (!frame || !Number.isFinite(frame.at)) continue;
    if (!newest || frame.at > newest.at) newest = frame;
  }
  return newest;
}

export type PreviewFreshness = {
  stale: boolean;
  label: string;
};

export function previewFreshness(
  capturedAt: number | null,
  now: number,
  busy: boolean,
): PreviewFreshness {
  if (capturedAt === null || !Number.isFinite(capturedAt)) {
    return { stale: true, label: "Waiting for a frame" };
  }
  const ageMs = Math.max(0, now - capturedAt);
  const staleAfterMs = busy ? 12_000 : 45_000;
  const ageLabel = ageMs < 2_000
    ? "now"
    : ageMs < 60_000
      ? `${Math.floor(ageMs / 1_000)}s ago`
      : `${Math.floor(ageMs / 60_000)}m ago`;
  const stale = ageMs > staleAfterMs;
  return { stale, label: `${stale ? "Stale" : "Live"} · ${ageLabel}` };
}
