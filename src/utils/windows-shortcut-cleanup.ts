import fs from "node:fs";
import path from "node:path";

export type LegacyShortcutCleanupResult =
  | "not-msi-install"
  | "shortcut-missing"
  | "shortcut-valid"
  | "shortcut-removed"
  | "cleanup-failed";

interface CleanupLegacyShortcutOptions {
  appDataPath: string;
  executablePath: string;
  readShortcutLink: (shortcutPath: string) => { target: string };
}

interface MsiInstallInfo {
  productCode?: unknown;
}

/**
 * MSI installs create a machine-wide shortcut, but an uninstalled Squirrel
 * build can leave a higher-priority per-user shortcut behind. If that legacy
 * target no longer exists, Windows resolves the shared AppUserModelID to a
 * generic icon. Remove only that verified-broken shortcut so Windows falls
 * back to the MSI-managed shortcut and icon.
 */
export function cleanupBrokenLegacyStartMenuShortcut({
  appDataPath,
  executablePath,
  readShortcutLink,
}: CleanupLegacyShortcutOptions): LegacyShortcutCleanupResult {
  try {
    const versionDirectory = path.dirname(executablePath);
    if (!path.basename(versionDirectory).startsWith("app-")) {
      return "not-msi-install";
    }

    const installRoot = path.dirname(versionDirectory);
    const installInfoPath = path.join(installRoot, ".installInfo.json");
    if (!fs.existsSync(installInfoPath)) {
      return "not-msi-install";
    }

    const installInfo = JSON.parse(
      fs.readFileSync(installInfoPath, "utf8")
    ) as MsiInstallInfo;
    if (
      typeof installInfo.productCode !== "string" ||
      installInfo.productCode.length === 0
    ) {
      return "not-msi-install";
    }

    const shortcutPath = path.join(
      appDataPath,
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "AI Image Manager.lnk"
    );
    if (!fs.existsSync(shortcutPath)) {
      return "shortcut-missing";
    }

    const { target } = readShortcutLink(shortcutPath);
    if (target && fs.existsSync(target)) {
      return "shortcut-valid";
    }

    fs.unlinkSync(shortcutPath);
    return "shortcut-removed";
  } catch {
    return "cleanup-failed";
  }
}
