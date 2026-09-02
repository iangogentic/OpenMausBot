/** A small independently testable deadline used by stdio MCP relays. */
export function firstResponseDeadline(onTimeout: () => void, timeoutMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    onTimeout();
  }, timeoutMs);
  timer.unref?.();
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}
