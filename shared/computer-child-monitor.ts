/**
 * Public, read-only projection of one delegated computer child.
 *
 * This intentionally contains no target identity, capability, owner token,
 * prompt/tool arguments, provider/model identity, or provider error text. It
 * is safe to publish to an authenticated parent-turn UI without widening the
 * authority carried by the internal runtime record.
 */
export type ComputerChildMonitorStatus =
  | "queued"
  | "running"
  | "waiting-on-human"
  | "completed"
  | "failed"
  | "aborted"
  | "unknown";

export interface ComputerChildMonitor {
  readonly childId: string;
  readonly parent: {
    readonly botId: string;
    readonly threadId: string;
    readonly turnId: string;
  };
  readonly status: ComputerChildMonitorStatus;
  readonly actionCount: number;
  readonly actionLimit: number;
  readonly leaseHeld: boolean;
  readonly createdAt: number;
  readonly finishedAt?: number;
}

/** A fresh snapshot is emitted after each lifecycle transition. */
export type ComputerChildMonitorListener = (monitor: ComputerChildMonitor) => void;
