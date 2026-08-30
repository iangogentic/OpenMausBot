import { describe, expect, it } from "vitest";

import { cloudComputerRemovalConfirmation } from "../lib/cloud-computer-removal";

describe("cloud computer destructive confirmations", () => {
  it("makes hosted Box deletion, data loss, and non-recreation explicit", () => {
    const copy = cloudComputerRemovalConfirmation("box", "Scout");

    expect(copy).toMatch(/Permanently delete Scout's hosted Box/i);
    expect(copy).toMatch(/every file and browser session/i);
    expect(copy).toMatch(/cannot be undone/i);
    expect(copy).toMatch(/turned Off.*does not recreate/i);
  });

  it("distinguishes removing the managed container from deleting the VPS", () => {
    const copy = cloudComputerRemovalConfirmation("vps", "Scout");

    expect(copy).toMatch(/Remove Scout's managed VPS container/i);
    expect(copy).toMatch(/permanently erases files stored only inside/i);
    expect(copy).toMatch(/does not delete the VPS itself/i);
    expect(copy).toMatch(/turned Off.*does not recreate/i);
  });
});
