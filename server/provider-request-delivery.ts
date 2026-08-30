export type ProviderDeliveryResult<T> =
  | Readonly<{ status: "returned"; outcome: T }>
  | Readonly<{ status: "timed-out" }>;

/** Bound the UI-facing wait without pretending the underlying provider call
 * was retracted. Callers must re-check exact request ownership after this
 * returns: a request.resolved event may have won immediately before timeout. */
export async function deliverProviderRequestWithDeadline<T>(
  deliver: () => Promise<T>,
  timeoutMs: number,
): Promise<ProviderDeliveryResult<T>> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<ProviderDeliveryResult<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "timed-out" }), timeoutMs);
    timer.unref?.();
  });
  const delivery = Promise.resolve().then(deliver).then<ProviderDeliveryResult<T>>(
    (outcome) => ({ status: "returned", outcome }),
  );
  try {
    return await Promise.race([delivery, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Timeout is a recovery signal only while the exact generation still owns
 * the ask. If ownership disappeared, a canonical resolved/turn-finished event
 * won the race and cancellation would risk killing a successor. */
export function timedOutRequestStillOwned<T>(
  result: ProviderDeliveryResult<T>,
  exactGenerationStillOwnsRequest: boolean,
): boolean {
  return result.status === "timed-out" && exactGenerationStillOwnsRequest;
}
