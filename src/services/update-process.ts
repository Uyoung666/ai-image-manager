import { execFile } from "node:child_process";
import path from "node:path";

const CREATION_TICKS = /^\d+$/;

export interface InstallerIdentity {
  installerCreatedAt?: string;
  installerPath?: string;
  installerPid?: number;
}
export type InstallerProbe = "matched" | "exited" | "mismatch" | "unknown";

/** Query only the named PID. Never interpret access denial as proof of ownership. */
export function readInstallerIdentity(
  pid: number
): Promise<InstallerIdentity | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.resolve(null);
  }
  const script = `$ErrorActionPreference='Stop'; try { $p=[Diagnostics.Process]::GetProcessById(${pid}); try { @{installerPid=$p.Id;installerCreatedAt=$p.StartTime.ToUniversalTime().Ticks.ToString();installerPath=$p.MainModule.FileName}|ConvertTo-Json -Compress } finally {$p.Dispose()} } catch [ArgumentException] { 'null' }`;
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const value = JSON.parse(stdout.trim());
          if (value === null) {
            resolve(null);
            return;
          }
          if (
            value.installerPid !== pid ||
            typeof value.installerPath !== "string" ||
            !value.installerPath ||
            !CREATION_TICKS.test(value.installerCreatedAt)
          ) {
            throw new Error("Invalid installer identity");
          }
          resolve(value);
        } catch (failure) {
          reject(failure);
        }
      }
    );
  });
}

export async function probeInstaller(
  expected: InstallerIdentity
): Promise<InstallerProbe> {
  if (!expected.installerPid) {
    return "exited";
  }
  try {
    const actual = await readInstallerIdentity(expected.installerPid);
    if (!actual) {
      return "exited";
    }
    if (
      expected.installerPath &&
      path.win32.resolve(actual.installerPath ?? "").toLowerCase() !==
        path.win32.resolve(expected.installerPath).toLowerCase()
    ) {
      return "mismatch";
    }
    if (
      expected.installerCreatedAt &&
      actual.installerCreatedAt !== expected.installerCreatedAt
    ) {
      return "mismatch";
    }
    return expected.installerPath && expected.installerCreatedAt
      ? "matched"
      : "unknown";
  } catch {
    return "unknown";
  }
}
