export class ComputerOperatorActiveConflictError extends Error {
  readonly status = 409;
}

/** Check and reserve synchronously before invoking start. JavaScript cannot
 * interleave another request between these operations, so a conflicting call
 * never creates an orphan child that then needs best-effort cancellation. */
export function reserveComputerOperator<T>(
  active: Map<string, T>,
  key: string,
  start: () => T,
): T {
  if (active.has(key)) throw new ComputerOperatorActiveConflictError("this parent turn already has an active computer operator");
  const value = start();
  active.set(key, value);
  return value;
}
