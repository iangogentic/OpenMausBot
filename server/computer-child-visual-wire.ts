import type { ComputerChildVisualState } from "../shared/computer-child-monitor.ts";

/** Project delegated telemetry onto a client's explicitly selected screen
 * policy. Cursor metadata is not a desktop capture; frame is the only pixel
 * bearing field and is removed rather than replaced with a misleading flag. */
export function computerChildVisualsForWire(
  visuals: Iterable<ComputerChildVisualState>,
  includeScreens: boolean,
): ComputerChildVisualState[] {
  return [...visuals].map((visual) => {
    if (includeScreens || !visual.frame) return visual;
    const { frame, ...withoutPixels } = visual;
    return withoutPixels;
  });
}
