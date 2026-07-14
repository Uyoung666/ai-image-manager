import { describe, expect, it } from "vitest";
import {
  getAutomaticFolderColor,
  getFolderAppearance,
  getFolderInitial,
} from "@/lib/folder-appearance";

describe("folder appearance", () => {
  it("generates a stable automatic color from the path", () => {
    expect(getAutomaticFolderColor("C:/Photos")).toBe(
      getAutomaticFolderColor("C:/Photos")
    );
    expect(getAutomaticFolderColor("C:/Photos")).not.toBe(
      getAutomaticFolderColor("D:/Archive")
    );
  });

  it("extracts Unicode graphemes and uppercases Latin initials", () => {
    expect(getFolderInitial("  photos")).toBe("P");
    expect(getFolderInitial("旅行")).toBe("旅");
    expect(getFolderInitial("👨‍👩‍👧 Family")).toBe("👨‍👩‍👧");
    expect(getFolderInitial("   ")).toBe("?");
  });

  it("lets custom values override automatic values", () => {
    expect(
      getFolderAppearance({
        appearanceColor: "#DC2626",
        appearanceIcon: "camera",
        displayName: "Photos",
        path: "C:/Photos",
      })
    ).toEqual({ color: "#DC2626", icon: "camera", initial: "P" });
  });
});
