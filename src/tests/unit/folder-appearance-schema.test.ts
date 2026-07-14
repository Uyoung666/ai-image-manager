import { describe, expect, it } from "vitest";
import { FolderAppearanceSchema } from "@/ipc/photos/handlers/shared";

describe("FolderAppearanceSchema", () => {
  it("accepts a curated icon, a strict hex color, and reset values", () => {
    expect(
      FolderAppearanceSchema.safeParse({
        color: "#5E6AD2",
        icon: "camera",
        id: 1,
      }).success
    ).toBe(true);
    expect(
      FolderAppearanceSchema.safeParse({ color: null, icon: null, id: 1 })
        .success
    ).toBe(true);
  });

  it("rejects invalid colors and unknown icons", () => {
    expect(
      FolderAppearanceSchema.safeParse({ color: "5E6AD2", icon: null, id: 1 })
        .success
    ).toBe(false);
    expect(
      FolderAppearanceSchema.safeParse({
        color: null,
        icon: "unknown",
        id: 1,
      }).success
    ).toBe(false);
  });
});
