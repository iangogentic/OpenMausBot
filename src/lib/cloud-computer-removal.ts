export function cloudComputerRemovalConfirmation(backend: "box" | "vps", botName: string): string {
  return backend === "box"
    ? `Permanently delete ${botName}'s hosted Box?\n\nThis erases every file and browser session stored in that Box and cannot be undone. Computer tools will be turned Off first so OpenMausBot does not recreate it.`
    : `Remove ${botName}'s managed VPS container?\n\nThis permanently erases files stored only inside that container and cannot be undone. It does not delete the VPS itself. Computer tools will be turned Off first so OpenMausBot does not recreate the container.`;
}
