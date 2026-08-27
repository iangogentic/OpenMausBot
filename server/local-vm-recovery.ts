import type { ContainerComputerStatus, LifecycleAction } from "./container-computer.ts";

type RecoveryAction = Extract<LifecycleAction, "remove" | "run">;

export interface SelectedLocalVmRecovery {
  inspect: () => Promise<ContainerComputerStatus>;
  act: (action: RecoveryAction) => Promise<ContainerComputerStatus>;
  sleep?: (milliseconds: number) => Promise<void>;
  pollAttempts?: number;
  pollIntervalMs?: number;
}

const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * An explicitly selected Local VM is allowed to recover its disposable
 * container. Idle cleanup removes that container, while a host reboot leaves
 * it stopped; both cases retain the durable workspace and prepared image.
 * Never remove an unowned stopped container, and never pull/build implicitly.
 */
export async function recoverSelectedLocalVm({
  inspect,
  act,
  sleep = delay,
  pollAttempts = 30,
  pollIntervalMs = 500,
}: SelectedLocalVmRecovery): Promise<ContainerComputerStatus> {
  let status = await inspect();
  if (status.ready) return status;
  if (!status.daemonUp || !status.image || !status.create_supported) return status;

  if (status.container === "stopped") {
    if (!status.managed) return status;
    status = await act("remove");
  }
  if (status.container === "missing") status = await act("run");
  if (status.ready || status.container !== "running") return status;

  for (let attempt = 0; attempt < pollAttempts; attempt += 1) {
    await sleep(pollIntervalMs);
    status = await inspect();
    if (status.ready || status.container !== "running") return status;
  }
  return status;
}
