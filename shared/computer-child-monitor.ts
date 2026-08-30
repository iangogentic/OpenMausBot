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

/** Authority-free pixels from the broker's existing trusted post-action
 * capture. Identity and monotonic ordering are supplied by the owning child
 * runtime, keeping this payload reusable across Local VM and physical lanes. */
export interface ComputerChildFrame {
  readonly mime: "image/png" | "image/jpeg" | "image/webp";
  readonly data: string;
  readonly hash: string;
}

/** The only action argument projected to the monitor surface. Coordinates
 * are emitted only after the corresponding bounded action was authorized and
 * forwarded; tool names and all other arguments remain private. */
export interface ComputerChildCursor {
  readonly x: number;
  readonly y: number;
}

/** Brokers enqueue listener invocations in accepted action order. The owning
 * runtime can therefore assign one monotonic per-child sequence at callback
 * entry without trusting a provider-supplied counter. */
export type ComputerChildFrameListener = (frame: ComputerChildFrame) => void | Promise<void>;
export type ComputerChildCursorListener = (cursor: ComputerChildCursor) => void | Promise<void>;

/** Latest public visual state for one child. Sequence numbers are allocated
 * by the trusted server, never accepted from the provider. */
export interface ComputerChildVisualState {
  readonly childId: string;
  readonly lastSeq: number;
  readonly frame?: ComputerChildFrame & {
    readonly seq: number;
    readonly at: number;
    readonly width: number;
    readonly height: number;
  };
  readonly cursor?: ComputerChildCursor & {
    readonly seq: number;
    readonly at: number;
  };
}
