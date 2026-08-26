import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupBrokenLegacyStartMenuShortcut } from "@/utils/windows-shortcut-cleanup";

describe("cleanupBrokenLegacyStartMenuShortcut", () => {
  const appDataPath = path.resolve("user-app-data");
  const installRoot = path.resolve("msi-install");
  const executablePath = path.join(
    installRoot,
    "app-2.0.0",
    "ai-image-manager.exe"
  );
  const installInfoPath = path.join(installRoot, ".installInfo.json");
  const shortcutPath = path.join(
    appDataPath,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
    "AI Image Manager.lnk"
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes a broken per-user shortcut from an MSI installation", () => {
    const missingTarget = path.resolve("uninstalled-squirrel", "app.exe");
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const value = String(candidate);
      return value === installInfoPath || value === shortcutPath;
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ productCode: "test-product-code" })
    );
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      // Prevent the unit test from touching the real Start Menu.
    });

    expect(
      cleanupBrokenLegacyStartMenuShortcut({
        appDataPath,
        executablePath,
        readShortcutLink: () => ({ target: missingTarget }),
      })
    ).toBe("shortcut-removed");
    expect(unlink).toHaveBeenCalledWith(shortcutPath);
  });

  it("preserves a per-user shortcut whose target still exists", () => {
    const liveTarget = path.resolve("active-squirrel", "app.exe");
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) => {
      const value = String(candidate);
      return (
        value === installInfoPath ||
        value === shortcutPath ||
        value === liveTarget
      );
    });
    vi.spyOn(fs, "readFileSync").mockReturnValue(
      JSON.stringify({ productCode: "test-product-code" })
    );
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      // Prevent the unit test from touching the real Start Menu.
    });

    expect(
      cleanupBrokenLegacyStartMenuShortcut({
        appDataPath,
        executablePath,
        readShortcutLink: () => ({ target: liveTarget }),
      })
    ).toBe("shortcut-valid");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("does nothing outside an MSI-managed installation", () => {
    const unpackedExecutable = path.resolve(
      "out",
      "AI Image Manager-win32-x64",
      "ai-image-manager.exe"
    );
    const unlink = vi.spyOn(fs, "unlinkSync").mockImplementation(() => {
      // Prevent the unit test from touching the real Start Menu.
    });

    expect(
      cleanupBrokenLegacyStartMenuShortcut({
        appDataPath,
        executablePath: unpackedExecutable,
        readShortcutLink: vi.fn(),
      })
    ).toBe("not-msi-install");
    expect(unlink).not.toHaveBeenCalled();
  });
});
