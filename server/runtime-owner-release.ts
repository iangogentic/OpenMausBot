/** Finish the exact runtime while its provider-owner lookup is still live.
 * Finished listeners use that lookup to cancel hidden child work; releasing
 * it first would turn exact parent cancellation into a no-op. */
export function finishRuntimeWithRetainedOwner<T>(
  finishRuntime: () => T,
  releaseOwner: () => void,
): T {
  const result = finishRuntime();
  releaseOwner();
  return result;
}
