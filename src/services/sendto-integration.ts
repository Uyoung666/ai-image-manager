import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

const SENDTO_DIR = path.join(
  process.env.APPDATA || path.join(app.getPath("home"), "AppData", "Roaming"),
  "Microsoft",
  "Windows",
  "SendTo"
);

const SHORTCUT_NAME = "AI Image Manager.lnk";

/**
 * Create a Windows .lnk shortcut in the SendTo directory.
 * Uses a minimal .lnk binary format — just enough for the SendTo menu.
 */
export function setupSendToShortcut(): boolean {
  try {
    if (process.platform !== "win32") {
      return false;
    }

    const targetPath = process.execPath;
    const args = "--sendto";
    const shortcutPath = path.join(SENDTO_DIR, SHORTCUT_NAME);

    // Check if already exists and points to us
    if (fs.existsSync(shortcutPath)) {
      return true;
    }

    // Ensure SendTo directory exists
    if (!fs.existsSync(SENDTO_DIR)) {
      fs.mkdirSync(SENDTO_DIR, { recursive: true });
    }

    // Write a minimal .lnk file via PowerShell (reliable way to create shortcuts)
    const psScript = `
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut('${shortcutPath.replace(/'/g, "''")}')
$sc.TargetPath = '${targetPath.replace(/'/g, "''")}'
$sc.Arguments = '${args}'
$sc.WorkingDirectory = '${path.dirname(targetPath).replace(/'/g, "''")}'
$sc.Description = 'Send to AI Image Manager'
$sc.Save()
`;
    execSync(
      `powershell -NoProfile -NonInteractive -Command "${psScript.replace(/"/g, '\\"')}"`,
      { timeout: 5000, windowsHide: true }
    );

    console.log("[SendTo] Shortcut created in SendTo menu");
    return true;
  } catch (err) {
    console.warn(
      "[SendTo] Failed to create shortcut:",
      (err as Error)?.message
    );
    return false;
  }
}

export function removeSendToShortcut(): boolean {
  try {
    if (process.platform !== "win32") {
      return false;
    }
    const shortcutPath = path.join(SENDTO_DIR, SHORTCUT_NAME);
    if (fs.existsSync(shortcutPath)) {
      fs.unlinkSync(shortcutPath);
      console.log("[SendTo] Shortcut removed from SendTo menu");
    }
    return true;
  } catch (err) {
    console.warn(
      "[SendTo] Failed to remove shortcut:",
      (err as Error)?.message
    );
    return false;
  }
}

/**
 * Check if the app was launched via SendTo or with --sendto flag.
 * Returns array of file paths passed as arguments.
 */
export function getSendToFilePaths(): string[] {
  const args = process.argv.slice(1); // skip executable
  const paths: string[] = [];

  // Filter out electron/chromium flags
  for (const arg of args) {
    if (
      arg === "--sendto" ||
      arg.startsWith("--allow-file-access-from-files") ||
      arg.startsWith("--original-process-start-time") ||
      arg.startsWith("--") ||
      arg.startsWith("-")
    ) {
      continue;
    }
    // Only include existing files
    if (fs.existsSync(arg)) {
      const stat = fs.statSync(arg);
      if (stat.isFile()) {
        paths.push(arg);
      }
    }
  }

  return paths;
}

/**
 * Check SendTo status (whether shortcut exists).
 */
export function isSendToEnabled(): boolean {
  if (process.platform !== "win32") {
    return false;
  }
  return fs.existsSync(path.join(SENDTO_DIR, SHORTCUT_NAME));
}
