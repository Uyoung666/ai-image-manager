import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WIX_VERSION = "3.14.0.8606";
const WIX_DOWNLOAD_URL =
  "https://github.com/wixtoolset/wix3/releases/download/wix314rtm/wix314-binaries.zip";
const WIX_ARCHIVE_SHA256 =
  "13f067f38969faf163d93a804b48ea0576790a202c8f10291f2000f0e356e934";
const BUILD_TOOLS_ROOT = path.join(
  process.env.LOCALAPPDATA ?? os.homedir(),
  "AIImageManagerBuildTools"
);
const WIX_DIRECTORY = path.join(BUILD_TOOLS_ROOT, "wix-3.14.0");
const WIX_ARCHIVE = path.join(BUILD_TOOLS_ROOT, "wix314-binaries.zip");

function commandHasExpectedVersion(command) {
  const result = spawnSync(command, ["-?"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  // Some Windows shells report a null exit status for a GUI-hidden native
  // executable even though it ran successfully and printed its version.
  // The version banner plus the absence of a spawn error is the reliable
  // signal that candle/light are usable.
  return !result.error && output.includes(WIX_VERSION);
}

function cachedToolsetIsReady() {
  return ["candle.exe", "light.exe"].every((executable) =>
    commandHasExpectedVersion(path.join(WIX_DIRECTORY, executable))
  );
}

function archiveHash() {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(WIX_ARCHIVE));
  return hash.digest("hex");
}

async function downloadArchive() {
  console.log(`[wix] Downloading WiX ${WIX_VERSION} from the official release`);
  const response = await fetch(WIX_DOWNLOAD_URL, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `WiX download failed: ${response.status} ${response.statusText}`
    );
  }
  fs.writeFileSync(WIX_ARCHIVE, Buffer.from(await response.arrayBuffer()));
}

function extractArchive() {
  const result = spawnSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $env:AIM_WIX_ARCHIVE -DestinationPath $env:AIM_WIX_DESTINATION -Force",
    ],
    {
      env: {
        ...process.env,
        AIM_WIX_ARCHIVE: WIX_ARCHIVE,
        AIM_WIX_DESTINATION: WIX_DIRECTORY,
      },
      stdio: "inherit",
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    throw new Error(`WiX extraction failed with exit code ${result.status}`);
  }
}

async function main() {
  if (process.platform !== "win32") {
    return;
  }
  if (
    commandHasExpectedVersion("candle.exe") &&
    commandHasExpectedVersion("light.exe")
  ) {
    console.log(`[wix] WiX ${WIX_VERSION} is available on PATH`);
    return;
  }
  if (cachedToolsetIsReady()) {
    console.log(`[wix] WiX ${WIX_VERSION} is ready at ${WIX_DIRECTORY}`);
    return;
  }

  fs.mkdirSync(BUILD_TOOLS_ROOT, { recursive: true });
  if (!fs.existsSync(WIX_ARCHIVE) || archiveHash() !== WIX_ARCHIVE_SHA256) {
    await downloadArchive();
  }
  const actualHash = archiveHash();
  if (actualHash !== WIX_ARCHIVE_SHA256) {
    throw new Error(
      `WiX archive checksum mismatch: expected ${WIX_ARCHIVE_SHA256}, received ${actualHash}`
    );
  }

  fs.mkdirSync(WIX_DIRECTORY, { recursive: true });
  extractArchive();
  if (!cachedToolsetIsReady()) {
    throw new Error(`WiX ${WIX_VERSION} was extracted but cannot be executed`);
  }
  console.log(`[wix] WiX ${WIX_VERSION} is ready at ${WIX_DIRECTORY}`);
}

await main();
