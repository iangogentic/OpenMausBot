/** A native dialog can only select paths on the desktop running the dialog.
 * In remote mode the shell/provider lives on the server, so forwarding a Mac
 * or Windows path would be both misleading and unusable.
 */
export function canUseNativeWorkingFolderPicker(
  connectionMode: "local" | "remote" | "browser" | undefined,
  pickerAvailable: boolean,
): boolean {
  return connectionMode !== "remote" && pickerAvailable;
}

export function workingFolderPlaceholder(
  connectionMode: "local" | "remote" | "browser" | undefined,
  serverName?: string,
  emptyLabel = "Private bot workspace",
): string {
  return connectionMode === "remote"
    ? `${emptyLabel} — or a managed workspace path on ${serverName?.trim() || "the server"}`
    : `${emptyLabel} — or an absolute path`;
}
