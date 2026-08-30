export class ComputerOperatorActiveConflictError extends Error {
  readonly status = 409;
}

export class ComputerOperatorAlreadyUsedError extends Error {
  readonly status = 409;
}

/** A dedicated operator owns one complete visual outcome per parent turn.
 * Consume that authority synchronously so a confused model cannot start a
 * second sequential child after the first final screen has already returned. */
export function consumeComputerOperatorTurn(state: { delegated: boolean }): void {
  if (state.delegated) {
    throw new ComputerOperatorAlreadyUsedError(
      "the computer operator was already delegated for this parent turn; answer from its verified result",
    );
  }
  state.delegated = true;
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
