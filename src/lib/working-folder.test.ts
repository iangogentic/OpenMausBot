import { describe, expect, it } from "vitest";

import { canUseNativeWorkingFolderPicker, workingFolderPlaceholder } from "./working-folder";

describe("working-folder location boundary", () => {
  it("never offers the Mac/Windows native picker for a remote server path", () => {
    expect(canUseNativeWorkingFolderPicker("remote", true)).toBe(false);
    expect(canUseNativeWorkingFolderPicker("local", true)).toBe(true);
    expect(canUseNativeWorkingFolderPicker("browser", false)).toBe(false);
  });

  it("names the machine whose path the user is entering", () => {
    expect(workingFolderPlaceholder("remote", "Razer"))
      .toBe("Private bot workspace — or a managed workspace path on Razer");
  });
});
