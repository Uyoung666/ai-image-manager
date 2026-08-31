#!/usr/bin/env node

/**
 * Windows installer upgrade gates used by the release pipeline.
 *
 * Upgrade operations require an explicitly configured, publicly reachable
 * previous artifact and its SHA-256. Missing baselines are errors; the
 * script never turns an install-only check into a false upgrade pass. The
 * fresh MSI operation exists only to bootstrap the first official MSI
 * baseline. Both installer paths also exercise the candidate installer.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

const WINDOWS_EXE_PATTERN = /\.exe$/iu;
const WINDOWS_MSI_PATTERN = /\.msi$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/iu;
const VERSION_PREFIX_PATTERN = /^v/iu;
const STABLE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const TRAILING_SLASH_PATTERN = /\/$/u;
const WINDOWS_TRAILING_SLASH_PATTERN = /[\\/]+$/u;
const REGISTRY_LINE_PATTERN = /^\s{4}([^\s]+)\s+REG_\w+\s+(.*)$/u;
const REGISTRY_LINE_SPLIT_PATTERN = /\r?\n/gu;
const APPLICATION_NAME_PATTERN = /AI Image Manager/iu;
const PACKAGED_EXECUTABLE_PATTERN = /(?:^|[\\/])ai-image-manager\.exe$/iu;
const SQUIRREL_APP_VERSION_PATH_PATTERN =
  /[\\/]app-(\d+\.\d+\.\d+)(?:[\\/]|$)/iu;
const READY_MARKER_PATTERN = /^WHENREADY\s/imu;
const APP_READY_MARKER_PATTERN =
  /Window ready — starting background services\.\.\./u;
const STARTUP_FAILURE_MARKER_PATTERN = /^CATCH\s/imu;
const ALLOWED_MSI_EXIT_CODES = new Set([0, 1641, 3010]);
const SQUIRREL_EXIT_CODES = new Set([0]);
const PACKAGED_E2E_STARTUP_TIMEOUT_MS = 2 * 60 * 1000;
const PACKAGED_E2E_READY_STABILITY_MS = 1000;
const PACKAGED_E2E_POLL_INTERVAL_MS = 250;
const PACKAGED_E2E_TERMINATION_TIMEOUT_MS = 15 * 1000;

function usage() {
  console.error(`Usage:
  node scripts/windows-installer-smoke.mjs setup-upgrade --setup <candidate Setup.exe> --version <new version> --feed <testing feed>
  node scripts/windows-installer-smoke.mjs msi-upgrade --msi <candidate MSI> --version <new version> --feed <testing feed>
  node scripts/windows-installer-smoke.mjs msi-fresh --msi <candidate MSI> --version <first MSI version>

setup-upgrade requires AIM_OLD_SETUP_URL, AIM_OLD_SETUP_SHA256,
AIM_OLD_SETUP_VERSION, AIM_OLD_SQUIRREL_FULL_URL, and
AIM_OLD_SQUIRREL_FULL_SHA256. The msi-upgrade operation requires
AIM_OLD_MSI_URL, AIM_OLD_MSI_SHA256, and AIM_OLD_MSI_VERSION. msi-fresh
does not accept a previous MSI and must be gated to the first official MSI
version by the calling workflow.
`);
}

function parseOptions(args) {
  const options = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      throw new Error(`Unexpected argument: ${argument}`);
    }
    const name = argument.slice(2);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Option --${name} requires a value`);
    }
    options.set(name, value);
    index += 1;
  }
  return options;
}

function requiredOption(options, name, environmentName = undefined) {
  const value =
    options.get(name)?.trim() ||
    (environmentName ? process.env[environmentName]?.trim() : undefined);
  if (!value) {
    throw new Error(
      environmentName
        ? `Missing --${name} (or ${environmentName})`
        : `Missing --${name}`
    );
  }
  return value;
}

function requiredPath(options, name, environmentName, pattern) {
  const value = requiredOption(options, name, environmentName);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Installer artifact does not exist: ${resolved}`);
  }
  if (!pattern.test(resolved)) {
    throw new Error(
      `Installer artifact has an unexpected extension: ${resolved}`
    );
  }
  return resolved;
}

function requiredVersion(options) {
  return normalizeStableVersion(
    requiredOption(options, "version", "AIM_RELEASE_VERSION"),
    "candidate version"
  );
}

function validateFeed(value) {
  let feed;
  try {
    feed = new URL(value);
  } catch {
    throw new Error(`Testing feed is not a valid URL: ${value}`);
  }
  if (feed.protocol !== "https:") {
    throw new Error("Testing feed must use HTTPS");
  }
  return feed.toString().replace(TRAILING_SLASH_PATTERN, "");
}

function normalizeStableVersion(value, label) {
  const version = String(value ?? "")
    .trim()
    .replace(VERSION_PREFIX_PATTERN, "");
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error(
      `${label} must be a stable MAJOR.MINOR.PATCH version: ${String(value)}`
    );
  }
  return version;
}

function compareStableVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] - rightParts[index];
    }
  }
  return 0;
}

function assertUpgradeVersion(oldVersion, candidateVersion, installerName) {
  if (compareStableVersions(oldVersion, candidateVersion) >= 0) {
    throw new Error(
      `${installerName} smoke requires candidate ${candidateVersion} to be newer than previous ${oldVersion}`
    );
  }
}

function run(
  command,
  args,
  label,
  allowedExitCodes = SQUIRREL_EXIT_CODES,
  environment = process.env
) {
  console.log(`[installer-smoke] ${label}`);
  const result = spawnSync(command, args, {
    env: environment,
    stdio: "inherit",
    timeout: 10 * 60 * 1000,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (!allowedExitCodes.has(result.status ?? -1)) {
    throw new Error(`${label} failed with exit code ${result.status ?? 1}`);
  }
  return result.status ?? 0;
}

function runCapture(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? 1}`);
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

async function downloadVerifiedAsset(urlValue, expectedHash, suffix) {
  let url;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error(`Public baseline URL is not valid: ${urlValue}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`Public baseline URL must use HTTPS: ${urlValue}`);
  }
  if (!SHA256_PATTERN.test(expectedHash)) {
    throw new Error(
      "Baseline SHA-256 must be a 64-character hexadecimal value"
    );
  }
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(
      `Baseline download failed: ${response.status} ${response.statusText}`
    );
  }
  if (response.url) {
    let finalUrl;
    try {
      finalUrl = new URL(response.url);
    } catch {
      throw new Error(`Baseline response URL is not valid: ${response.url}`);
    }
    if (finalUrl.protocol !== "https:") {
      throw new Error(
        `Baseline download redirected to a non-HTTPS URL: ${response.url}`
      );
    }
  }
  const destinationDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), `ai-image-manager-baseline-${suffix}-`)
  );
  const destination = path.join(destinationDirectory, `baseline${suffix}`);
  if (!response.body) {
    throw new Error(`Baseline response has no readable body: ${urlValue}`);
  }
  await pipeline(
    Readable.fromWeb(response.body),
    fs.createWriteStream(destination)
  );
  const actualHash = await sha256File(destination);
  if (actualHash.toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(
      `Baseline SHA-256 mismatch for ${urlValue}: expected ${expectedHash}, received ${actualHash}`
    );
  }
  console.log(
    `[installer-smoke] verified baseline ${urlValue} (${actualHash})`
  );
  return destination;
}

function squirrelRoots() {
  const localAppData = process.env.LOCALAPPDATA;
  return [
    process.env.AIM_SQUIRREL_INSTALL_ROOT,
    localAppData && path.join(localAppData, "ai-image-manager"),
    localAppData && path.join(localAppData, "AI Image Manager"),
  ].filter(Boolean);
}

function findSquirrelRoot(version) {
  for (const root of squirrelRoots()) {
    if (fs.existsSync(path.join(root, `app-${version}`, "Update.exe"))) {
      return root;
    }
    if (fs.existsSync(path.join(root, "Update.exe"))) {
      return root;
    }
  }
  return undefined;
}

async function waitForPath(filePath, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForPathGone(filePath, timeoutMs = 2 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(filePath)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for uninstall cleanup of ${filePath}`);
}

async function waitForSquirrelRoot(version, timeoutMs = 5 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const root = findSquirrelRoot(version);
    if (root) {
      return root;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `Timed out waiting for previous Squirrel installation ${version}`
  );
}

function childHasExited(child) {
  return (
    (child.exitCode !== null && child.exitCode !== undefined) ||
    (child.signalCode !== null && child.signalCode !== undefined)
  );
}

function describeChildExit(
  child,
  code = child.exitCode,
  signal = child.signalCode
) {
  if (signal) {
    return `signal ${signal}`;
  }
  if (code !== null && code !== undefined) {
    return `exit code ${code}`;
  }
  return "unknown exit status";
}

function readReadinessState(readinessLogPath) {
  try {
    const stat = fs.statSync(readinessLogPath);
    return {
      exists: true,
      mtimeMs: stat.mtimeMs,
      content: fs.readFileSync(readinessLogPath, "utf8"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, mtimeMs: 0, content: "" };
    }
    return {
      exists: false,
      mtimeMs: 0,
      content: "",
      error,
    };
  }
}

function isFreshReadinessState(previous, current) {
  if (!current.exists || current.error) {
    return false;
  }
  return (
    !previous.exists ||
    current.mtimeMs > previous.mtimeMs ||
    current.content !== previous.content
  );
}

function hasFreshLogMarker(previous, current, pattern) {
  if (!isFreshReadinessState(previous, current)) {
    return false;
  }
  const appendedContent =
    previous.exists && current.content.startsWith(previous.content)
      ? current.content.slice(previous.content.length)
      : current.content;
  return pattern.test(appendedContent);
}

function sameResolvedPath(left, right) {
  return (
    path
      .resolve(left)
      .replace(WINDOWS_TRAILING_SLASH_PATTERN, "")
      .toLowerCase() ===
    path
      .resolve(right)
      .replace(WINDOWS_TRAILING_SLASH_PATTERN, "")
      .toLowerCase()
  );
}

function assertPackagedExecutable(executable, expectedVersion = undefined) {
  const executablePath = path.resolve(executable);
  if (!fs.existsSync(executablePath)) {
    throw new Error(`Packaged executable does not exist: ${executablePath}`);
  }
  if (!fs.statSync(executablePath).isFile()) {
    throw new Error(`Packaged executable is not a file: ${executablePath}`);
  }
  if (!PACKAGED_EXECUTABLE_PATTERN.test(executablePath)) {
    throw new Error(
      `Packaged executable has an unexpected name: ${executablePath}`
    );
  }

  const normalizedExpectedVersion = expectedVersion
    ? normalizeStableVersion(expectedVersion, "packaged app version")
    : undefined;
  const pathVersion = executablePath.match(
    SQUIRREL_APP_VERSION_PATH_PATTERN
  )?.[1];
  if (
    normalizedExpectedVersion &&
    pathVersion !== undefined &&
    pathVersion !== normalizedExpectedVersion
  ) {
    throw new Error(
      `Packaged executable version mismatch: expected ${normalizedExpectedVersion}, received ${pathVersion} from ${executablePath}`
    );
  }

  return {
    path: executablePath,
    pathVersion,
  };
}

function assertPackagedProcessIdentity(child, executablePath) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error(
      `Packaged executable did not provide a valid process id: ${executablePath}`
    );
  }
  let processExecutable;
  if (typeof child.spawnfile === "string") {
    processExecutable = child.spawnfile;
  } else if (
    Array.isArray(child.spawnargs) &&
    typeof child.spawnargs[0] === "string"
  ) {
    processExecutable = child.spawnargs[0];
  }
  if (
    processExecutable &&
    !sameResolvedPath(processExecutable, executablePath)
  ) {
    throw new Error(
      `Packaged process executable mismatch: expected ${executablePath}, received ${processExecutable}`
    );
  }
}

function hasValidProcessId(child) {
  return Number.isInteger(child.pid) && child.pid > 0;
}

function inspectPackagedReadiness(
  child,
  executablePath,
  readinessLogPath,
  previousReadiness,
  appLogPath,
  previousAppLog,
  label,
  allowExited = false
) {
  if (childHasExited(child) && !allowExited) {
    return {
      error: new Error(
        `${label} exited before startup confirmation (${describeChildExit(child)})`
      ),
    };
  }
  try {
    assertPackagedProcessIdentity(child, executablePath);
  } catch (error) {
    return { error };
  }

  const currentReadiness = readReadinessState(readinessLogPath);
  if (currentReadiness.error) {
    return { ready: false };
  }
  if (
    hasFreshLogMarker(
      previousReadiness,
      currentReadiness,
      STARTUP_FAILURE_MARKER_PATTERN
    )
  ) {
    return {
      error: new Error(
        `${label} reported startup failure: ${currentReadiness.content.trim()}`
      ),
    };
  }
  if (
    !hasFreshLogMarker(
      previousReadiness,
      currentReadiness,
      READY_MARKER_PATTERN
    )
  ) {
    return { ready: false };
  }

  const currentMainLog = readReadinessState(appLogPath);
  if (currentMainLog.error) {
    return { ready: false };
  }
  if (
    !hasFreshLogMarker(previousAppLog, currentMainLog, APP_READY_MARKER_PATTERN)
  ) {
    return { ready: false };
  }
  return { ready: true, state: currentReadiness };
}
function waitForPackagedReady(
  child,
  executablePath,
  readinessLogPath,
  previousReadiness,
  appLogPath,
  previousAppLog,
  label,
  {
    startupTimeoutMs = PACKAGED_E2E_STARTUP_TIMEOUT_MS,
    pollIntervalMs = PACKAGED_E2E_POLL_INTERVAL_MS,
    readyStabilityMs = PACKAGED_E2E_READY_STABILITY_MS,
  } = {}
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let spawned = false;
    let readySince;
    let timer;
    let interval;

    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (interval) {
        clearInterval(interval);
      }
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onSpawn = () => {
      spawned = true;
      inspect();
    };
    const onError = (error) => {
      fail(new Error(`${label} failed to start: ${error.message}`));
    };
    const onExit = (code, signal) => {
      if (code === 0) {
        const observation = inspectPackagedReadiness(
          child,
          executablePath,
          readinessLogPath,
          previousReadiness,
          appLogPath,
          previousAppLog,
          label,
          true
        );
        if (observation.error) {
          fail(observation.error);
          return;
        }
        if (observation.ready) {
          settled = true;
          cleanup();
          resolve(observation.state);
          return;
        }
      }
      fail(
        new Error(
          `${label} exited before startup confirmation (${describeChildExit(child, code, signal)})`
        )
      );
    };
    const inspect = () => {
      if (settled) {
        return;
      }
      if (!(spawned || hasValidProcessId(child))) {
        return;
      }
      spawned = true;
      const observation = inspectPackagedReadiness(
        child,
        executablePath,
        readinessLogPath,
        previousReadiness,
        appLogPath,
        previousAppLog,
        label
      );
      if (observation.error) {
        fail(observation.error);
        return;
      }
      if (!observation.ready) {
        readySince = undefined;
        return;
      }
      if (readySince === undefined) {
        readySince = Date.now();
        return;
      }
      if (Date.now() - readySince < readyStabilityMs) {
        return;
      }
      settled = true;
      cleanup();
      resolve(observation.state);
    };

    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => {
      fail(
        new Error(
          `${label} timed out waiting for fresh WHENREADY startup marker and fresh app.log startup marker after ${startupTimeoutMs}ms`
        )
      );
    }, startupTimeoutMs);
    interval = setInterval(inspect, pollIntervalMs);
    inspect();
  });
}
function waitForChildExit(child, timeoutMs) {
  if (childHasExited(child)) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    const done = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      resolve();
    };
    const onExit = () => done();
    const onError = () => done();
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function forceKillProcessTree(pid, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let killer;
    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      killer?.removeListener("error", onError);
      killer?.removeListener("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onError = (error) => finish(error);
    const onExit = (code) => {
      if (code === 0 || code === 128) {
        finish();
      } else {
        finish(new Error(`taskkill.exe failed with exit code ${code ?? 1}`));
      }
    };

    try {
      killer = spawnProcess("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", onError);
      killer.once("exit", onExit);
    } catch (error) {
      finish(error);
      return;
    }
    if (childHasExited(killer)) {
      onExit(killer.exitCode);
      return;
    }
    timer = setTimeout(
      () => finish(new Error("taskkill.exe timed out")),
      PACKAGED_E2E_TERMINATION_TIMEOUT_MS
    );
  });
}
function tryTerminatePackagedChild(child) {
  if (childHasExited(child)) {
    return undefined;
  }
  try {
    if (!child.kill()) {
      return new Error("child.kill() returned false");
    }
  } catch (error) {
    return error;
  }
  return undefined;
}

async function tryTerminatePackagedTree(child, spawnProcess, forceKill) {
  if (process.platform === "win32") {
    try {
      await forceKill(child.pid, spawnProcess);
      return undefined;
    } catch (error) {
      return childHasExited(child) ? undefined : error;
    }
  }
  if (!childHasExited(child)) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* best-effort final termination */
    }
  }
  return undefined;
}

function describeCleanupError(error) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForPackagedProcessExit(
  child,
  label,
  timeoutMs,
  initialKillError,
  treeKillError
) {
  if (childHasExited(child)) {
    return;
  }
  try {
    await waitForChildExit(child, timeoutMs);
  } catch (waitError) {
    const reasons = [initialKillError, treeKillError, waitError]
      .filter(Boolean)
      .map(describeCleanupError)
      .join("; ");
    throw new Error(`${label} cleanup failed after ${reasons}`);
  }
}

async function terminatePackagedProcess(
  child,
  label,
  {
    terminationTimeoutMs = PACKAGED_E2E_TERMINATION_TIMEOUT_MS,
    spawnProcess = spawn,
    forceKill = forceKillProcessTree,
  } = {}
) {
  if (!(child && hasValidProcessId(child))) {
    return;
  }

  const initialKillError = tryTerminatePackagedChild(child);
  const treeKillError = await tryTerminatePackagedTree(
    child,
    spawnProcess,
    forceKill
  );
  await waitForPackagedProcessExit(
    child,
    label,
    terminationTimeoutMs,
    initialKillError,
    treeKillError
  );
  if (treeKillError) {
    throw new Error(
      `${label} process-tree cleanup failed: ${describeCleanupError(treeKillError)}`
    );
  }
}
async function runPackagedE2E(
  executable,
  label,
  existingUserDataDirectory = undefined,
  expectedVersion = undefined,
  {
    spawnProcess = spawn,
    startupTimeoutMs = PACKAGED_E2E_STARTUP_TIMEOUT_MS,
    pollIntervalMs = PACKAGED_E2E_POLL_INTERVAL_MS,
    readyStabilityMs = PACKAGED_E2E_READY_STABILITY_MS,
    terminationTimeoutMs = PACKAGED_E2E_TERMINATION_TIMEOUT_MS,
    forceKill = forceKillProcessTree,
  } = {}
) {
  const executableInfo = assertPackagedExecutable(executable, expectedVersion);
  const userDataDirectory =
    existingUserDataDirectory ??
    fs.mkdtempSync(path.join(os.tmpdir(), "ai-image-manager-installer-e2e-"));
  const readinessLogPath = path.join(
    userDataDirectory,
    "logs",
    "whenReady.log"
  );
  const previousReadiness = readReadinessState(readinessLogPath);
  const appLogPath = path.join(userDataDirectory, "logs", "app.log");
  const previousAppLog = readReadinessState(appLogPath);
  let child;
  let failure;

  console.log(`[installer-smoke] ${label}`);
  try {
    child = spawnProcess(
      executableInfo.path,
      ["--e2e", "--e2e-quit-after-ready"],
      {
        env: {
          ...process.env,
          AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: userDataDirectory,
          CI: "e2e",
        },
        stdio: "ignore",
        windowsHide: true,
      }
    );
    await waitForPackagedReady(
      child,
      executableInfo.path,
      readinessLogPath,
      previousReadiness,
      appLogPath,
      previousAppLog,
      label,
      { startupTimeoutMs, pollIntervalMs, readyStabilityMs }
    );
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  }

  if (child) {
    try {
      await terminatePackagedProcess(child, label, {
        terminationTimeoutMs,
        spawnProcess,
        forceKill,
      });
    } catch (cleanupError) {
      if (failure) {
        console.error(
          `[installer-smoke] cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      } else {
        failure =
          cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError));
      }
    }
  }

  if (failure) {
    throw failure;
  }
  console.log(`[installer-smoke] ${label} ready and process stopped`);
  return userDataDirectory;
}

async function runSetupUpgradeSmoke(setupPath, version, feed) {
  const setupStat = fs.statSync(setupPath);
  if (!setupStat.isFile() || setupStat.size === 0) {
    throw new Error(`Candidate Setup.exe is empty: ${setupPath}`);
  }
  console.log(
    `[installer-smoke] verified candidate Setup.exe (${setupStat.size} bytes)`
  );
  const oldSetupUrl = requiredOption(
    new Map(),
    "old setup",
    "AIM_OLD_SETUP_URL"
  );
  const oldSetupHash = requiredOption(
    new Map(),
    "old setup hash",
    "AIM_OLD_SETUP_SHA256"
  );
  const oldVersion = requiredOption(
    new Map(),
    "old setup version",
    "AIM_OLD_SETUP_VERSION"
  );
  const oldFullUrl = requiredOption(
    new Map(),
    "old Squirrel full package",
    "AIM_OLD_SQUIRREL_FULL_URL"
  );
  const oldFullHash = requiredOption(
    new Map(),
    "old Squirrel full package hash",
    "AIM_OLD_SQUIRREL_FULL_SHA256"
  );
  const normalizedOldVersion = normalizeStableVersion(
    oldVersion,
    "AIM_OLD_SETUP_VERSION"
  );
  assertUpgradeVersion(normalizedOldVersion, version, "Squirrel Setup");

  const oldSetupPath = await downloadVerifiedAsset(
    oldSetupUrl,
    oldSetupHash,
    ".exe"
  );
  // Verify the separately published full baseline too. Setup embeds its
  // bootstrap metadata, while this full package is the exact delta baseline.
  await downloadVerifiedAsset(oldFullUrl, oldFullHash, ".nupkg");

  run(
    oldSetupPath,
    ["--silent"],
    `install verified previous Squirrel Setup ${normalizedOldVersion}`
  );
  const root = await waitForSquirrelRoot(normalizedOldVersion);
  const updateExecutable = path.join(root, "Update.exe");
  if (!fs.existsSync(updateExecutable)) {
    throw new Error(
      `Previous Squirrel Update.exe was not found: ${updateExecutable}`
    );
  }

  const oldExecutable = path.join(
    root,
    `app-${normalizedOldVersion}`,
    "ai-image-manager.exe"
  );
  if (!fs.existsSync(oldExecutable)) {
    throw new Error(
      `Previous Squirrel executable was not found: ${oldExecutable}`
    );
  }
  const sharedUserData = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-squirrel-user-data-")
  );
  await runPackagedE2E(
    oldExecutable,
    `launch old Squirrel app-${normalizedOldVersion}`,
    sharedUserData,
    normalizedOldVersion
  );
  const retentionMarker = path.join(
    sharedUserData,
    "release-upgrade-marker.txt"
  );
  const markerContents = `preserve-${normalizedOldVersion}\n`;
  fs.writeFileSync(retentionMarker, markerContents, "utf8");

  run(
    updateExecutable,
    ["--update", feed],
    `update previous Squirrel installation ${normalizedOldVersion} from testing feed to ${version}`
  );
  const upgradedExecutable = path.join(
    root,
    `app-${version}`,
    "ai-image-manager.exe"
  );
  await waitForPath(upgradedExecutable);
  if (
    !fs.existsSync(retentionMarker) ||
    fs.readFileSync(retentionMarker, "utf8") !== markerContents
  ) {
    throw new Error(
      "Squirrel upgrade did not preserve the shared user-data marker"
    );
  }
  await runPackagedE2E(
    upgradedExecutable,
    `launch upgraded Squirrel app-${version}`,
    sharedUserData,
    version
  );

  // Keep the runner clean and make uninstallation part of the gate. Do not
  // delete the runner's Temp files; Squirrel owns its install cleanup.
  run(
    updateExecutable,
    ["--uninstall"],
    `uninstall upgraded Squirrel ${version}`
  );
  await waitForPathGone(upgradedExecutable);

  // Exercise the candidate Setup.exe itself after the feed upgrade. The feed
  // update above consumes a NUPKG, so checking only that path would not catch
  // a corrupt bootstrapper. A fresh silent install, launch, and uninstall
  // closes that gap without deleting any runner Temp data.
  let freshRoot;
  let freshInstallActive = false;
  try {
    run(
      setupPath,
      ["--silent"],
      `fresh-install candidate Squirrel Setup ${version}`
    );
    freshRoot = await waitForSquirrelRoot(version);
    freshInstallActive = true;
    const freshExecutable = path.join(
      freshRoot,
      `app-${version}`,
      "ai-image-manager.exe"
    );
    await waitForPath(freshExecutable);
    await runPackagedE2E(
      freshExecutable,
      `launch fresh candidate Setup app-${version}`,
      undefined,
      version
    );
    const freshUpdateExecutable = path.join(freshRoot, "Update.exe");
    if (!fs.existsSync(freshUpdateExecutable)) {
      throw new Error(
        `Fresh candidate Squirrel Update.exe was not found: ${freshUpdateExecutable}`
      );
    }
    run(
      freshUpdateExecutable,
      ["--uninstall"],
      `uninstall fresh candidate Squirrel ${version}`
    );
    await waitForPathGone(freshExecutable);
    freshInstallActive = false;
  } finally {
    if (freshInstallActive && freshRoot) {
      try {
        run(
          path.join(freshRoot, "Update.exe"),
          ["--uninstall"],
          `cleanup failed fresh Squirrel install ${version}`
        );
        await waitForPathGone(
          path.join(freshRoot, `app-${version}`, "ai-image-manager.exe")
        );
      } catch (cleanupError) {
        console.error(
          `[installer-smoke] cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  }
  console.log("AIM_INSTALLER_SMOKE_SETUP_UPGRADE=passed");
}

function parseRegistryProducts(output) {
  const products = [];
  let product = {};
  for (const line of output.split(REGISTRY_LINE_SPLIT_PATTERN)) {
    const match = line.match(REGISTRY_LINE_PATTERN);
    if (!match) {
      if (line.trim() === "" && product.DisplayName) {
        products.push(product);
        product = {};
      }
      continue;
    }
    const property = match[1];
    if (
      property === "DisplayName" ||
      property === "DisplayVersion" ||
      property === "InstallLocation" ||
      property === "InstallPath" ||
      property === "UninstallString"
    ) {
      // electron-wix-msi records the directory as InstallPath. Some older
      // MSI authoring tools use InstallLocation, so normalize both spellings
      // for the upgrade and custom-directory assertions below.
      if (property === "InstallPath") {
        product.InstallLocation = match[2].trim();
      } else {
        product[property] = match[2].trim();
      }
    }
  }
  if (product.DisplayName) {
    products.push(product);
  }
  return products;
}

function registryProducts() {
  const hives = [
    "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  return hives
    .flatMap((hive) =>
      parseRegistryProducts(
        runCapture(
          "reg.exe",
          ["query", hive, "/s"],
          `query MSI products in ${hive}`
        )
      )
    )
    .filter((product) => APPLICATION_NAME_PATTERN.test(product.DisplayName));
}

function findInstalledExecutable(installLocation) {
  const resolvedRoot = path.resolve(installLocation);
  const directCandidates = [
    path.join(resolvedRoot, "ai-image-manager.exe"),
    path.join(resolvedRoot, "current", "ai-image-manager.exe"),
  ];
  const direct = directCandidates.find((candidate) => fs.existsSync(candidate));
  if (direct) {
    return direct;
  }

  const queue = [{ directory: resolvedRoot, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(current.directory, entry.name);
      if (
        entry.isFile() &&
        entry.name.toLowerCase() === "ai-image-manager.exe"
      ) {
        return candidate;
      }
      if (entry.isDirectory() && current.depth < 3) {
        queue.push({ directory: candidate, depth: current.depth + 1 });
      }
    }
  }
  return undefined;
}

async function waitForNoMsiProduct(timeoutMs = 2 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (registryProducts().length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    "Timed out waiting for AI Image Manager MSI uninstall registry cleanup"
  );
}

function assertMsiInstalled(version, expectedDirectory = undefined) {
  const matches = registryProducts();
  const product = matches.find(
    (candidate) => candidate.DisplayVersion === version
  );
  if (!product) {
    throw new Error(
      `AI Image Manager MSI ${version} was not found in uninstall registry. Observed: ${JSON.stringify(matches)}`
    );
  }
  if (!product.InstallLocation) {
    throw new Error(
      `AI Image Manager MSI ${version} has no InstallLocation in registry`
    );
  }
  if (!fs.existsSync(product.InstallLocation)) {
    throw new Error(
      `AI Image Manager MSI install location does not exist: ${product.InstallLocation}`
    );
  }
  if (expectedDirectory) {
    const expected = path
      .resolve(expectedDirectory)
      .replace(WINDOWS_TRAILING_SLASH_PATTERN, "")
      .toLowerCase();
    const actual = path
      .resolve(product.InstallLocation)
      .replace(WINDOWS_TRAILING_SLASH_PATTERN, "")
      .toLowerCase();
    if (actual !== expected) {
      throw new Error(
        `MSI custom directory mismatch: expected ${expected}, received ${actual}`
      );
    }
  }
  return product;
}

function assertMsiAutoUpdater(product) {
  const updater = path.join(product.InstallLocation, "Update.exe");
  if (!fs.existsSync(updater)) {
    throw new Error(`MSI auto-update component was not found: ${updater}`);
  }
  return updater;
}

async function runMsiFreshSmoke(currentMsiPath, version) {
  const candidateStat = fs.statSync(currentMsiPath);
  if (!candidateStat.isFile() || candidateStat.size === 0) {
    throw new Error(`Candidate MSI is empty: ${currentMsiPath}`);
  }
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-msi-fresh-")
  );
  const msiexec = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "msiexec.exe"
  );
  const runMsi = (args, label) =>
    run(msiexec, args, label, ALLOWED_MSI_EXIT_CODES);
  let productWasInstalled = false;
  try {
    runMsi(
      [
        "/i",
        currentMsiPath,
        "/qn",
        "/norestart",
        "/l*v",
        path.join(logDirectory, "default-install.log"),
      ],
      `fresh-install MSI ${version} in default directory`
    );
    productWasInstalled = true;
    const defaultProduct = assertMsiInstalled(version);
    assertMsiAutoUpdater(defaultProduct);
    const defaultExecutable = findInstalledExecutable(
      defaultProduct.InstallLocation
    );
    if (!defaultExecutable) {
      throw new Error(
        `Fresh MSI executable was not found under ${defaultProduct.InstallLocation}`
      );
    }
    await runPackagedE2E(
      defaultExecutable,
      `launch fresh MSI ${version}`,
      undefined,
      version
    );
    runMsi(
      [
        "/x",
        currentMsiPath,
        "/qn",
        "/norestart",
        "/l*v",
        path.join(logDirectory, "default-uninstall.log"),
      ],
      `uninstall fresh MSI ${version} from default directory`
    );
    await waitForNoMsiProduct();
    productWasInstalled = false;

    const customDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-msi-custom-")
    );
    runMsi(
      [
        "/i",
        currentMsiPath,
        "/qn",
        "/norestart",
        `APPLICATIONROOTDIRECTORY=${customDirectory}`,
        "/l*v",
        path.join(logDirectory, "custom-install.log"),
      ],
      `fresh-install MSI ${version} in custom directory`
    );
    productWasInstalled = true;
    const customProduct = assertMsiInstalled(version, customDirectory);
    assertMsiAutoUpdater(customProduct);
    const customExecutable = findInstalledExecutable(
      customProduct.InstallLocation
    );
    if (!customExecutable) {
      throw new Error(
        `Custom-directory MSI executable was not found under ${customProduct.InstallLocation}`
      );
    }
    await runPackagedE2E(
      customExecutable,
      `launch custom-directory MSI ${version}`,
      undefined,
      version
    );
    runMsi(
      [
        "/x",
        currentMsiPath,
        "/qn",
        "/norestart",
        "/l*v",
        path.join(logDirectory, "custom-uninstall.log"),
      ],
      `uninstall MSI ${version} from custom directory`
    );
    await waitForNoMsiProduct();
    productWasInstalled = false;
  } finally {
    if (productWasInstalled) {
      try {
        runMsi(
          ["/x", currentMsiPath, "/qn", "/norestart"],
          "cleanup failed fresh MSI smoke installation"
        );
      } catch (cleanupError) {
        console.error(
          `[installer-smoke] cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  }
  console.log(`AIM_INSTALLER_SMOKE_MSI_FRESH=passed logs=${logDirectory}`);
}

async function runMsiUpgradeSmoke(currentMsiPath, version, feed) {
  const oldMsiUrl = requiredOption(new Map(), "old MSI", "AIM_OLD_MSI_URL");
  const oldMsiHash = requiredOption(
    new Map(),
    "old MSI hash",
    "AIM_OLD_MSI_SHA256"
  );
  const oldVersion = requiredOption(
    new Map(),
    "old MSI version",
    "AIM_OLD_MSI_VERSION"
  );
  const normalizedOldVersion = normalizeStableVersion(
    oldVersion,
    "AIM_OLD_MSI_VERSION"
  );
  assertUpgradeVersion(normalizedOldVersion, version, "MSI");

  const oldMsiPath = await downloadVerifiedAsset(oldMsiUrl, oldMsiHash, ".msi");
  const logDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-msi-upgrade-")
  );
  const msiexec = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "msiexec.exe"
  );
  const runMsi = (args, label) =>
    run(msiexec, args, label, ALLOWED_MSI_EXIT_CODES);
  let productWasInstalled = false;
  let installedMsiPath;
  try {
    runMsi(
      [
        "/i",
        oldMsiPath,
        "/qn",
        "/norestart",
        "/l*v",
        path.join(logDirectory, "old-install.log"),
      ],
      `install verified previous MSI ${normalizedOldVersion} in default directory`
    );
    productWasInstalled = true;
    installedMsiPath = oldMsiPath;
    const oldProduct = assertMsiInstalled(normalizedOldVersion);
    const updateExecutable = assertMsiAutoUpdater(oldProduct);
    const sharedUserData = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-msi-user-data-")
    );
    const retentionMarker = path.join(
      sharedUserData,
      "release-upgrade-marker.txt"
    );
    fs.writeFileSync(
      retentionMarker,
      `preserve-${normalizedOldVersion}\n`,
      "utf8"
    );
    const oldExecutable = findInstalledExecutable(oldProduct.InstallLocation);
    if (!oldExecutable) {
      throw new Error(
        `Previous MSI executable was not found under ${oldProduct.InstallLocation}`
      );
    }
    await runPackagedE2E(
      oldExecutable,
      `launch old MSI ${normalizedOldVersion}`,
      sharedUserData,
      normalizedOldVersion
    );

    run(
      updateExecutable,
      ["--update", feed],
      `auto-update MSI installation ${normalizedOldVersion} to ${version} from testing feed`
    );
    installedMsiPath = oldMsiPath;
    await waitForPath(
      path.join(
        oldProduct.InstallLocation,
        `app-${version}`,
        "ai-image-manager.exe"
      )
    );
    const upgradedProduct = assertMsiInstalled(version);
    if (
      !fs.existsSync(retentionMarker) ||
      fs.readFileSync(retentionMarker, "utf8") !==
        `preserve-${normalizedOldVersion}\n`
    ) {
      throw new Error(
        "MSI upgrade did not preserve the shared user-data marker"
      );
    }
    const upgradedExecutable = findInstalledExecutable(
      upgradedProduct.InstallLocation
    );
    if (!upgradedExecutable) {
      throw new Error(
        `Upgraded MSI executable was not found under ${upgradedProduct.InstallLocation}`
      );
    }
    await runPackagedE2E(
      upgradedExecutable,
      `launch upgraded MSI ${version}`,
      sharedUserData,
      version
    );

    runMsi(
      [
        "/x",
        oldMsiPath,
        "/qn",
        "/norestart",
        "/l*v",
        path.join(logDirectory, "default-uninstall.log"),
      ],
      `uninstall auto-updated MSI ${version} from default directory`
    );
    await waitForNoMsiProduct();
    productWasInstalled = false;
    installedMsiPath = undefined;

    const customDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "ai-image-manager-msi-custom-")
    );
    runMsi(
      [
        "/i",
        currentMsiPath,
        "/qn",
        "/norestart",
        `APPLICATIONROOTDIRECTORY=${customDirectory}`,
        "/l*v",
        path.join(logDirectory, "custom-install.log"),
      ],
      `install MSI ${version} in custom directory`
    );
    productWasInstalled = true;
    installedMsiPath = currentMsiPath;
    const customProduct = assertMsiInstalled(version, customDirectory);
    assertMsiAutoUpdater(customProduct);
    const customExecutable = findInstalledExecutable(
      customProduct.InstallLocation
    );
    if (!customExecutable) {
      throw new Error(
        `Custom-directory MSI executable was not found under ${customProduct.InstallLocation}`
      );
    }
    await runPackagedE2E(
      customExecutable,
      `launch custom-directory MSI ${version}`,
      undefined,
      version
    );
    runMsi(
      [
        "/x",
        currentMsiPath,
        "/qn",
        "/norestart",
        "/l*v",
        path.join(logDirectory, "custom-uninstall.log"),
      ],
      `uninstall MSI ${version} from custom directory`
    );
    await waitForNoMsiProduct();
    productWasInstalled = false;
    installedMsiPath = undefined;
  } finally {
    if (productWasInstalled && installedMsiPath) {
      // Best effort cleanup after a failed assertion; preserve the original
      // failure while ensuring a rerun does not inherit an installed product.
      try {
        runMsi(
          ["/x", installedMsiPath, "/qn", "/norestart"],
          "cleanup failed MSI smoke installation"
        );
      } catch (cleanupError) {
        console.error(
          `[installer-smoke] cleanup warning: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  }
  console.log(`AIM_INSTALLER_SMOKE_MSI_UPGRADE=passed logs=${logDirectory}`);
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("Windows installer smoke must run on a Windows runner");
  }
  const [operation, ...rawArgs] = process.argv.slice(2);
  if (!operation || operation === "--help" || operation === "-h") {
    usage();
    return;
  }
  const options = parseOptions(rawArgs);
  const version = requiredVersion(options);
  if (operation === "setup-upgrade") {
    const setupPath = requiredPath(
      options,
      "setup",
      "AIM_SETUP_PATH",
      WINDOWS_EXE_PATTERN
    );
    const feed = validateFeed(requiredOption(options, "feed", "COS_APP_FEED"));
    await runSetupUpgradeSmoke(setupPath, version, feed);
    return;
  }
  if (operation === "msi-upgrade") {
    const msiPath = requiredPath(
      options,
      "msi",
      "AIM_MSI_PATH",
      WINDOWS_MSI_PATTERN
    );
    const feed = validateFeed(requiredOption(options, "feed", "COS_APP_FEED"));
    await runMsiUpgradeSmoke(msiPath, version, feed);
    return;
  }
  if (operation === "msi-fresh") {
    const msiPath = requiredPath(
      options,
      "msi",
      "AIM_MSI_PATH",
      WINDOWS_MSI_PATTERN
    );
    await runMsiFreshSmoke(msiPath, version);
    return;
  }
  usage();
  throw new Error(`Unknown operation: ${operation}`);
}

export {
  assertPackagedExecutable,
  forceKillProcessTree,
  readReadinessState,
  runPackagedE2E,
  terminatePackagedProcess,
  waitForPackagedReady,
};

const invokedDirectly =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(
      `[installer-smoke] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  });
}
