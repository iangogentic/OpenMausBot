export type ComputerAssignment = "cloud" | "vm" | "local" | "off" | undefined;

/**
 * Per-bot VM mode is an explicit fleet policy: every bot gets its own isolated
 * desktop. In that mode Automatic must select that desktop, rather than
 * silently reaching through a remote client to the person's physical machine.
 */
export function resolveComputerAssignment(
  assignment: ComputerAssignment,
  vmMode: "shared" | "per-bot",
  forceCloud = false,
): ComputerAssignment {
  if (forceCloud) return "cloud";
  if (assignment !== undefined) return assignment;
  return vmMode === "per-bot" ? "vm" : undefined;
}

export function assignmentUsesLocalVm(
  assignment: ComputerAssignment,
  vmMode: "shared" | "per-bot",
): boolean {
  return resolveComputerAssignment(assignment, vmMode) === "vm";
}
