import type { Action } from "@/state/store";

/** The collapse affordance is destination-independent: loading, Android,
 * errors, and every computer backend must all close through the same explicit
 * reducer action instead of relying on a toggle with potentially stale state. */
export function collapseComputerPanel(dispatch: (action: Action) => void): void {
  dispatch({ type: "toggleComputer", open: false });
}

/** Escape belongs to an open child editor/warning first. In every ordinary
 * panel state it is the keyboard equivalent of the always-visible Collapse
 * button. */
export function escapeClosesComputerPanel(input: {
  key: string;
  defaultPrevented: boolean;
  routineEditorOpen: boolean;
  warningOpen: boolean;
}): boolean {
  return input.key === "Escape" &&
    !input.defaultPrevented &&
    !input.routineEditorOpen &&
    !input.warningOpen;
}
