import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import {
  expectedIncomingMethod,
  requiresMetadataFallback,
} from "./acceptance.mjs";
import { sha256File } from "./checksums.mjs";
import {
  createProductUpdateProxy,
  PRODUCT_LATEST_MANIFEST,
  PRODUCT_RELEASE_LIST,
} from "./update-product-proxy.mjs";

const LEADING_PATH_SEPARATOR = /^[/\\]/;
const CONTINUE_BUTTON = /^(继续|Continue)$/;
const SAVE_CONTINUE_BUTTON = /^(保存并继续|Save and Continue|Save & Continue)$/;
const START_BUTTON = /^(开始使用|Get started|Start using)$/i;
const CLOSE_BEHAVIOR_LABEL = /^(关闭行为|Close behavior)$/;
const QUIT_OPTION = /^(退出应用|Quit the app)$/;
const NEW_ALBUM_BUTTON = /^(新建相册|New Album|New album)$/;
const ALBUM_NAME_PLACEHOLDER = /相册名称|Album name/i;
const RETENTION_ALBUM = "Product upgrade retention album";
const CREATE_BUTTON = /^(创建|Create)$/;
const CHECK_BUTTON = /^(检查更新|Check for Updates|Check for updates)$/;
const CHECK_OR_RETRY_BUTTON =
  /^(检查更新|Check for Updates|Check for updates|重试|Retry)$/;
const INSTALL_BUTTON = /^(安装并重启|Install and restart)$/;
const CLOSE_BUTTON = /^(关闭|Close)$/;
const AUTO_UPDATE_CHECKBOX = /^(自动更新|Automatic updates)$/;

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const repository = "Uyoung666/ai-image-manager";
const sessions = new Map();
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function startProductUpdateCheck(page) {
  return page.getByRole("button", { name: CHECK_OR_RETRY_BUTTON }).click();
}

export function installedTargetPath(executable, version) {
  const directory = path.dirname(executable);
  const root = path.basename(directory).startsWith("app-")
    ? path.dirname(directory)
    : directory;
  return path.join(root, `app-${version}`, path.basename(executable));
}

async function readBrowserProcess(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send("SystemInfo.getProcessInfo");
    const pid = processInfo.find((entry) => entry.type === "browser")?.id;
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new Error("Browser PID is missing");
    }
    const script = `$ErrorActionPreference='Stop'; $p=[Diagnostics.Process]::GetProcessById(${pid}); try { @{pid=$p.Id;createdAt=$p.StartTime.ToUniversalTime().Ticks.ToString();path=$p.MainModule.FileName}|ConvertTo-Json -Compress } finally {$p.Dispose()}`;
    const { stdout } = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { windowsHide: true, timeout: 5000 }
    );
    return JSON.parse(stdout.trim());
  } finally {
    await session.detach();
  }
}

export async function repackTestSuccessorArchive(archive, version, directory) {
  const asar = await import("@electron/asar");
  const source = path.join(directory, "asar-source");
  const entries = [];
  for (const entry of asar.listPackage(archive)) {
    const name = entry.replace(LEADING_PATH_SEPARATOR, "");
    const info = asar.statFile(archive, name, false);
    if (info.files) {
      entries.push({
        type: "directory",
        path: name,
        unpacked: Boolean(info.unpacked),
      });
      continue;
    }
    if (info.link) {
      throw new Error("Successor fixture does not accept linked ASAR entries");
    }
    const destination = path.resolve(source, name);
    if (!destination.startsWith(`${path.resolve(source)}${path.sep}`)) {
      throw new Error("Invalid ASAR fixture path");
    }
    // Production postPackage pruning intentionally removes non-runtime unpacked files.
    if (
      info.unpacked &&
      !fs.existsSync(path.join(`${archive}.unpacked`, name))
    ) {
      continue;
    }
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    await fsp.writeFile(destination, asar.extractFile(archive, name));
    entries.push({
      type: "file",
      path: name,
      unpacked: Boolean(info.unpacked),
      streamGenerator: () => fs.createReadStream(destination),
    });
  }
  const metadata = path.join(source, "package.json");
  const pkg = JSON.parse(await fsp.readFile(metadata, "utf8"));
  pkg.version = version;
  await fsp.writeFile(metadata, JSON.stringify(pkg));
  const temporaryArchive = path.join(directory, "next.asar");
  const output = await asar.createPackageFromStreams(
    temporaryArchive,
    entries.map((entry) =>
      entry.type === "file"
        ? { ...entry, stat: fs.statSync(path.join(source, entry.path)) }
        : entry
    )
  );
  await finished(output, { cleanup: true });
  return temporaryArchive;
}

export async function createTestSuccessorPackage(
  executable,
  version,
  directory,
  baseline
) {
  await fsp.mkdir(directory, { recursive: true });
  const asar = await import("@electron/asar");
  const payload = path.join(directory, "payload");
  await fsp.cp(path.dirname(executable), payload, { recursive: true });
  const archive = path.join(payload, "resources", "app.asar");
  const temporaryArchive = await repackTestSuccessorArchive(
    archive,
    version,
    directory
  );
  await fsp.copyFile(temporaryArchive, archive);
  if (fs.existsSync(`${temporaryArchive}.unpacked`)) {
    await fsp.cp(`${temporaryArchive}.unpacked`, `${archive}.unpacked`, {
      recursive: true,
    });
  }
  // Refresh the copied EXE's resource metadata, including the new ASAR header hash.
  const resedit = await require("resedit/cjs").load();
  const targetExecutable = path.join(payload, path.basename(executable));
  const pe = resedit.NtExecutable.from(await fsp.readFile(targetExecutable));
  const resource = resedit.NtExecutableResource.from(pe);
  const integrity = resource.entries.find(
    (entry) => entry.type === "INTEGRITY" && entry.id === "ELECTRONASAR"
  );
  if (!integrity) {
    throw new Error("Candidate has no embedded ASAR integrity resource");
  }
  integrity.bin = Buffer.from(
    JSON.stringify([
      {
        file: "resources\\app.asar",
        alg: "SHA256",
        value: createHash("sha256")
          .update(asar.getRawHeader(archive).headerString)
          .digest("hex"),
      },
    ])
  );
  for (const info of resedit.Resource.VersionInfo.fromEntries(
    resource.entries
  )) {
    info.setFileVersion(...version.split(".").map(Number), 0);
    info.setProductVersion(...version.split(".").map(Number), 0);
    for (const language of info.getAllLanguagesForStringValues()) {
      info.setStringValues(language, {
        FileVersion: version,
        ProductVersion: version,
      });
    }
    info.outputToResourceEntries(resource.entries);
  }
  resource.outputResource(pe);
  await fsp.writeFile(targetExecutable, Buffer.from(pe.generate()));
  const spec = path.join(directory, "next.nuspec");
  await fsp.writeFile(
    spec,
    `<?xml version="1.0"?><package><metadata><id>ai-image-manager</id><version>${version}</version><authors>Isolated CI validation</authors><description>TEST ONLY - NEVER PUBLISH</description></metadata><files><file src="**" target="lib\\net45" /></files></package>`
  );
  const vendor = path.resolve("node_modules/electron-winstaller/vendor");
  await execute(
    path.join(vendor, "nuget.exe"),
    [
      "pack",
      spec,
      "-BasePath",
      payload,
      "-OutputDirectory",
      directory,
      "-NoDefaultExcludes",
    ],
    { windowsHide: true, timeout: 300_000 }
  );
  const feed = path.join(directory, "feed");
  if (baseline) {
    await fsp.mkdir(feed, { recursive: true });
    await fsp.copyFile(baseline.file, path.join(feed, baseline.info.filename));
    await fsp.writeFile(
      path.join(feed, "RELEASES"),
      `${baseline.info.sha1} ${baseline.info.filename} ${baseline.info.size}\n`
    );
  }
  await execute(
    path.join(vendor, "Squirrel.exe"),
    [
      "--releasify",
      path.join(directory, `ai-image-manager.${version}.nupkg`),
      "--releaseDir",
      feed,
      "--no-msi",
    ],
    { windowsHide: true, timeout: 300_000 }
  );
  const full = await describeSuccessorPackage(feed, version, "full");
  if (!baseline) {
    return { full };
  }
  const delta = await describeSuccessorPackage(feed, version, "delta");
  if (delta.info.size >= full.info.size) {
    throw new Error(
      "Test successor delta must be smaller than its full package"
    );
  }
  delta.info.fromVersion = baseline.version;
  delta.info.toVersion = version;
  return { full, delta };
}

async function describeSuccessorPackage(feed, version, kind) {
  const filename = `ai-image-manager-${version}-${kind}.nupkg`;
  const file = path.join(feed, filename);
  const sha1 = createHash("sha1");
  for await (const chunk of fs.createReadStream(file)) {
    sha1.update(chunk);
  }
  return {
    file,
    info: {
      filename,
      size: (await fsp.stat(file)).size,
      sha1: sha1.digest("hex"),
      sha256: await sha256File(file),
      url: `https://github.com/${repository}/releases/download/v${version}/${filename}`,
    },
  };
}

const standardUserScript = path.join(
  import.meta.dirname,
  "start-standard-user.ps1"
);
const standardUserArgs = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-File",
  standardUserScript,
];

async function verifyStandardProcess(processInfo) {
  await execute("powershell.exe", standardUserArgs, {
    env: { ...process.env, AIM_STANDARD_VERIFY_PID: String(processInfo.pid) },
    windowsHide: true,
    timeout: 15_000,
  });
}

async function waitFor(callback, label, timeout = 180_000, signal = null) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const value = await callback().catch((error) => {
      lastError = error;
    });
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Product upgrade timed out: ${label}${lastError ? `: ${lastError}` : ""}`
  );
}

export async function expectRestart(browser, action, readState) {
  let timeout;
  let interval;
  let disconnected;
  const exited = new Promise((resolve, reject) => {
    disconnected = resolve;
    browser.once("disconnected", disconnected);
    timeout = setTimeout(
      () => reject(new Error("Product did not exit for restart")),
      300_000
    );
  });
  // Observe real updater errors while waiting, rather than hiding an immediate
  // install failure behind the five-minute restart deadline.
  const failed = new Promise((_, reject) => {
    if (readState) {
      let reading = false;
      interval = setInterval(async () => {
        if (reading) {
          return;
        }
        reading = true;
        try {
          const state = await readState();
          if (state.phase === "error") {
            reject(
              new Error(
                `Product updater failed before restart: ${JSON.stringify(state)}`
              )
            );
          }
        } catch {
          // State may be atomically replaced while the installer is running.
        } finally {
          reading = false;
        }
      }, 250);
    }
  });
  const outcome = Promise.race([exited, failed]);
  // Install can fail while the UI click is still resolving.
  outcome.catch(() => undefined);
  try {
    await action();
    await outcome;
  } finally {
    clearTimeout(timeout);
    clearInterval(interval);
    browser.off("disconnected", disconnected);
  }
}

export async function verifyProductDownload(
  state,
  manifest,
  trace,
  installRoot
) {
  const method = state.updateMethod;
  const info = manifest.packages[method];
  if (
    !(["delta", "full"].includes(method) && info) ||
    state.version !== manifest.version ||
    !trace.some(
      (request) =>
        request.host === "github.com" &&
        request.url === new URL(info.url).pathname
    )
  ) {
    throw new Error(
      "Product did not download a package declared by the published manifest"
    );
  }
  if (
    method === "delta" &&
    trace.some(
      ({ host, url }) =>
        host === "github.com" &&
        url === new URL(manifest.packages.full.url).pathname
    )
  ) {
    throw new Error("Delta upgrade requested the full fallback package");
  }
  const delta = manifest.packages.delta;
  if (
    method === "full" &&
    delta &&
    trace.some(
      ({ host, url }) =>
        host === "github.com" && url === new URL(delta.url).pathname
    )
  ) {
    throw new Error("Full upgrade requested an unexpected delta package");
  }
  const installedPackage = path.join(installRoot, "packages", info.filename);
  if (
    (await fsp.stat(installedPackage)).size !== info.size ||
    (await sha256File(installedPackage)) !== info.sha256
  ) {
    throw new Error(
      "Installed product package differs from the verified download"
    );
  }
  return { updateMethod: method, downloadedPackageSha256: info.sha256 };
}

export function verifyMetadataFallback(trace) {
  const limited = trace.findIndex(
    ({ host, url, status }) =>
      host === "api.github.com" &&
      url.split("?")[0] === PRODUCT_RELEASE_LIST &&
      status === 429
  );
  if (
    limited === -1 ||
    !trace
      .slice(limited + 1)
      .some(
        ({ host, url, status }) =>
          host === "github.com" &&
          url === PRODUCT_LATEST_MANIFEST &&
          status === 302
      )
  ) {
    throw new Error(
      "Updater did not use the official manifest after API rate limiting"
    );
  }
}

export async function cleanupProductSession(actions, primaryError) {
  const errors = [];
  for (const [stage, action, timeout = 5000] of actions) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve().then(action),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("cleanup deadline exceeded")),
            timeout
          );
        }),
      ]);
    } catch (error) {
      errors.push(`${stage}: ${error.message ?? String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (errors.length) {
    const message = `Product session cleanup failed: ${errors.join("; ")}`;
    if (!primaryError) {
      throw new Error(message);
    }
    console.error(message);
  }
}

async function saveProductFailure(directory, profile, page, details) {
  const ui = await page
    ?.locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => undefined);
  await fsp.writeFile(
    path.join(directory, "failure.json"),
    JSON.stringify({ ...details, ui }, null, 2)
  );
  await page
    ?.screenshot({ path: path.join(directory, "failure.png"), timeout: 5000 })
    .catch(() => undefined);
  const logs = path.join(profile, "logs");
  if (fs.existsSync(logs)) {
    await fsp.cp(logs, path.join(directory, "logs"), { recursive: true });
  }
}

export async function readProductStartupCrash(file, previousCrash) {
  const crash = await fsp.readFile(file, "utf8").catch(() => "");
  const startupCrash = (
    crash.startsWith(previousCrash) ? crash.slice(previousCrash.length) : crash
  ).slice(-32_768);
  if (startupCrash) {
    console.error(`[product-update] new crash log: ${startupCrash}`);
  }
  return startupCrash;
}

export function retentionAlbumCard(page) {
  return page.getByRole("link").filter({
    has: page.getByRole("heading", { name: RETENTION_ALBUM, exact: true }),
  });
}

export async function waitForProductPage(browser, timeout = 180_000) {
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("Product browser has no default context");
  }
  // Electron exposes CDP before creating its BrowserWindow. A page event alone
  // does not prove navigation/preload/router readiness, including after restart.
  const deadline = Date.now() + timeout;
  const page =
    context.pages().find((entry) => !entry.isClosed()) ??
    (await context.waitForEvent("page", { timeout }));
  await page.waitForFunction(
    () => typeof window.__e2eNavigate === "function",
    undefined,
    { timeout: Math.max(1, deadline - Date.now()) }
  );
  if (await page.evaluate(() => Boolean(window.electronAPI?.isE2E))) {
    throw new Error("Production startup bypass is enabled");
  }
  return page;
}

async function installThroughProduct(
  browser,
  page,
  stateFile,
  expectInstallFailure
) {
  try {
    await expectRestart(
      browser,
      () => page.getByRole("button", { name: INSTALL_BUTTON }).click(),
      async () => JSON.parse(await fsp.readFile(stateFile, "utf8")).state
    );
  } catch (error) {
    if (!expectInstallFailure) {
      throw error;
    }
    const failure = JSON.parse(await fsp.readFile(stateFile, "utf8")).state;
    if (
      failure.phase !== "error" ||
      failure.operation !== "install" ||
      failure.updateMethod !== "delta" ||
      !["UPDATE_INSTALL_INTERRUPTED", "UPDATE_INSTALL_ACCESS_DENIED"].includes(
        failure.message
      )
    ) {
      throw error;
    }
    return { status: "reproduced", message: failure.message };
  }
  if (expectInstallFailure) {
    throw new Error(
      "Original MSI delta failure was not reproduced under standard permissions"
    );
  }
  return null;
}

/** Uses Chromium CDP only. Release fuses, updater code and TLS verification stay enabled. */
async function runUpgrade(
  executable,
  profile,
  manifest,
  packages,
  directory,
  {
    expectConfirmation,
    seedAlbum = false,
    expectedMethod,
    kind,
    expectInstallFailure,
    rateLimitAPI = false,
  }
) {
  await fsp.mkdir(directory, { recursive: true });
  const { chromium, expect } = await import("@playwright/test");
  const sourceExecutableSha256 = await sha256File(executable);
  const proxy = await createProductUpdateProxy(
    path.join(directory, "tls"),
    manifest,
    packages,
    rateLimitAPI
  );
  const reservation = await import("node:net");
  const socket = reservation.createServer();
  await new Promise((resolve) => socket.listen(0, "127.0.0.1", resolve));
  const port = socket.address().port;
  await new Promise((resolve) => socket.close(resolve));
  const env = {
    ...process.env,
    CI: undefined,
    ELECTRON_RUN_AS_NODE: undefined,
    AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: undefined,
    AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
    SQUIRREL_TEMP: undefined,
    AIM_STANDARD_VERIFY_PID: undefined,
  };
  let browser;
  let child;
  let page;
  let targetProcess;
  let primaryError;
  let stage = "launch";
  const crashFile = path.join(profile, "logs", "crash.log");
  const previousCrash = await fsp.readFile(crashFile, "utf8").catch(() => "");
  const target = installedTargetPath(executable, manifest.version);
  const connect = async (signal) => {
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
      "CDP",
      180_000,
      signal
    );
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  };
  try {
    const args = [
      `--proxy-server=${proxy.url}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ];
    child = spawn("powershell.exe", standardUserArgs, {
      env: {
        ...env,
        AIM_STANDARD_EXECUTABLE: executable,
        AIM_STANDARD_ARGUMENTS: args.join(" "),
        AIM_STANDARD_MSI_ROOT:
          kind === "msi" ? path.dirname(path.dirname(target)) : undefined,
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "inherit"],
    });
    const launchFailed = new Promise((_, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        reject(
          new Error(
            `Standard-user launcher exited before CDP: ${signal ?? code}`
          )
        );
      });
    });
    const launch = new AbortController();
    try {
      browser = await Promise.race([connect(launch.signal), launchFailed]);
    } finally {
      launch.abort();
    }
    await verifyStandardProcess(await readBrowserProcess(browser));
    stage = "startup renderer";
    page = await waitForProductPage(browser);
    // Complete the real onboarding, if this isolated profile has never done so.
    stage = "first screen";
    // The released baseline replaces the entire layout during onboarding.
    await page
      .locator("main:visible, .onboarding-overlay:visible")
      .first()
      .waitFor();
    await page
      .locator(".startup-splash")
      .waitFor({ state: "hidden", timeout: 30_000 });
    if (await page.locator(".onboarding-overlay").isVisible()) {
      stage = "onboarding";
      await page.getByRole("button", { name: CONTINUE_BUTTON }).click();
      await page
        .getByRole("button", {
          name: SAVE_CONTINUE_BUTTON,
        })
        .click({ timeout: 120_000 });
      await page.getByRole("button", { name: START_BUTTON }).click();
      await page.locator(".onboarding-overlay").waitFor({ state: "hidden" });
    }
    await page.locator("main").first().waitFor();
    stage = "close preference";
    await page.evaluate(() => window.__e2eNavigate("/settings/behavior"));
    await page.getByRole("combobox", { name: CLOSE_BEHAVIOR_LABEL }).click();
    await page.getByRole("option", { name: QUIT_OPTION }).click();
    stage = "retention album";
    await page.evaluate(() => window.__e2eNavigate("/albums"));
    if (seedAlbum) {
      await page
        .getByRole("button", { name: NEW_ALBUM_BUTTON })
        .first()
        .click();
      await page.getByPlaceholder(ALBUM_NAME_PLACEHOLDER).fill(RETENTION_ALBUM);
      await page.getByRole("button", { name: CREATE_BUTTON }).click();
    }
    await retentionAlbumCard(page).waitFor();
    stage = "automatic update preference";
    await page.evaluate(() => window.__e2eNavigate("/settings/update"));
    const automaticUpdates = page.getByRole("checkbox", {
      name: AUTO_UPDATE_CHECKBOX,
    });
    await expect(automaticUpdates).toBeEnabled();
    if (await automaticUpdates.isChecked()) {
      await automaticUpdates.focus();
      await automaticUpdates.press("Space");
    }
    await expect(automaticUpdates).not.toBeChecked();
    await expect(automaticUpdates).toBeEnabled();
    stage = "download";
    proxy.activate();
    // An older client may already have failed its automatic check before
    // the fixture is activated. Retry starts a fresh check in that state.
    await startProductUpdateCheck(page);
    await page
      .getByRole("button", { name: INSTALL_BUTTON })
      .waitFor({ timeout: 180_000 });
    const stateFile = path.join(profile, "update-state.json");
    const before = JSON.parse(await fsp.readFile(stateFile, "utf8")).state;
    if (before.version !== manifest.version || before.phase !== "downloaded") {
      throw new Error("Real updater did not download target");
    }
    if (expectedMethod && before.updateMethod !== expectedMethod) {
      throw new Error(
        `Expected ${expectedMethod}, downloaded ${before.updateMethod} (fallbackReason=${before.fallbackReason})`
      );
    }
    if (rateLimitAPI) {
      verifyMetadataFallback(proxy.trace);
    }
    stage = "install and automatic restart";
    const reproduced = await installThroughProduct(
      browser,
      page,
      stateFile,
      expectInstallFailure
    );
    if (reproduced) {
      return reproduced;
    }
    stage = "automatic restart renderer";
    browser = await connect();
    page = await waitForProductPage(browser);
    targetProcess = await readBrowserProcess(browser);
    await verifyStandardProcess(targetProcess);
    if (
      path.resolve(targetProcess.path).toLowerCase() !==
      path.resolve(target).toLowerCase()
    ) {
      throw new Error("Automatic restart did not run the target executable");
    }
    stage = "target health confirmation";
    await waitFor(
      async () => {
        const state = JSON.parse(await fsp.readFile(stateFile, "utf8")).state;
        if (state.phase === "error") {
          throw new Error(JSON.stringify(state));
        }
        return (
          state.phase === "idle" &&
          (!expectConfirmation || Boolean(state.confirmedAt))
        );
      },
      "target health confirmation",
      300_000
    );
    await page.screenshot({ path: path.join(directory, "target.png") });
    if (!fs.existsSync(target)) {
      throw new Error("Target executable missing");
    }
    const download = await verifyProductDownload(
      before,
      manifest,
      proxy.trace,
      path.dirname(path.dirname(target))
    );
    // Exercise the ordinary restart IPC, then verify the same data after relaunch.
    stage = "second launch";
    await expectRestart(browser, () =>
      page.evaluate(() => window.electronAPI.restartApp())
    );
    browser = await connect();
    page = await waitForProductPage(browser);
    const secondProcess = await readBrowserProcess(browser);
    await verifyStandardProcess(secondProcess);
    if (
      secondProcess.pid === targetProcess.pid ||
      path.resolve(secondProcess.path).toLowerCase() !==
        path.resolve(target).toLowerCase()
    ) {
      throw new Error("Ordinary restart did not start a new target process");
    }
    targetProcess = secondProcess;
    await page.evaluate(() => window.__e2eNavigate("/albums"));
    await retentionAlbumCard(page).waitFor();
    if (
      JSON.parse(await fsp.readFile(stateFile, "utf8")).state.phase !== "idle"
    ) {
      throw new Error("Second launch reactivated the completed update");
    }
    await page.evaluate(() => window.__e2eNavigate("/settings/update"));
    await page
      .getByRole("button", {
        name: CHECK_BUTTON,
      })
      .waitFor();
    const result = {
      secondLaunch: "passed",
      dataRetained: "passed",
      target,
      targetVersion: manifest.version,
      confirmed: expectConfirmation,
      standardUser: true,
      sourceVersion: path.basename(path.dirname(executable)).slice(4),
      ...(rateLimitAPI ? { metadataSource: "asset-fallback" } : {}),
      ...download,
      actualProcess: targetProcess,
      sourceExecutableSha256,
      targetExecutableSha256: await sha256File(target),
      packageSha256: manifest.packages.full.sha256,
      trace: proxy.trace,
    };
    return result;
  } catch (error) {
    primaryError = error;
    const startupCrash = await readProductStartupCrash(
      crashFile,
      previousCrash
    );
    console.error(
      `[product-update] ${stage} failed: ${error.stack ?? String(error)}`
    );
    await saveProductFailure(directory, profile, page, {
      stage,
      message: String(error),
      stack: error.stack,
      startupCrash,
      targetVersion: manifest.version,
      trace: proxy.trace,
    }).catch((diagnosticError) =>
      console.error(
        `[product-update] diagnostic warning: ${diagnosticError.message}`
      )
    );
    throw error;
  } finally {
    await cleanupProductSession(
      [
        [
          "normal quit",
          async () => {
            if (page && !page.isClosed()) {
              await page
                .getByRole("button", { name: CLOSE_BUTTON })
                .first()
                .click({ timeout: 5000 });
              await waitFor(
                async () => {
                  try {
                    await fetch(`http://127.0.0.1:${port}/json/version`);
                    return false;
                  } catch {
                    return true;
                  }
                },
                "application quit",
                15_000
              );
            }
          },
          21_000,
        ],
        ["disconnect CDP", () => browser?.close()],
        [
          "stop owned child",
          async () => {
            if (child && child.exitCode === null && child.signalCode === null) {
              const exited = new Promise((resolve, reject) => {
                child.once("exit", resolve);
                child.once("error", reject);
              });
              try {
                await execute(
                  "taskkill.exe",
                  ["/PID", String(child.pid), "/T", "/F"],
                  {
                    windowsHide: true,
                    timeout: 5000,
                  }
                ).catch(() => child.kill());
                await exited;
              } finally {
                child.unref();
              }
            }
          },
        ],
        ["close proxy and certificate", () => proxy.close(), 35_000],
      ],
      primaryError
    );
  }
}

export async function runProductUpgradeChain(
  executable,
  profile,
  candidateVersion,
  kind,
  stage,
  { retentionPrepared = false, history } = {}
) {
  if (process.env.AIM_PRODUCT_UPDATE_GATE !== "1") {
    throw new Error("Product update gate must be explicitly enabled");
  }
  if (!versionPattern.test(candidateVersion)) {
    throw new Error("Invalid candidate version");
  }
  if (stage === "second") {
    const saved = sessions.get(kind);
    if (!saved) {
      throw new Error("Missing candidate upgrade evidence");
    }
    return finishProductChain(saved);
  }
  await fsp.mkdir(path.resolve(".test-runtime"), { recursive: true });
  const directory = await fsp.mkdtemp(
    path.resolve(".test-runtime", `product-update-${kind}-`)
  );
  const bundleRoot = path.resolve(
    process.env.RELEASE_BUNDLE ?? "release-bundle"
  );
  const candidate = JSON.parse(
    await fsp.readFile(
      path.join(bundleRoot, "download/update-manifest.json"),
      "utf8"
    )
  );
  const packages = Object.fromEntries(
    Object.values(candidate.packages).map((info) => [
      info.filename,
      path.join(bundleRoot, "files", info.filename),
    ])
  );
  if (candidate.version !== candidateVersion) {
    throw new Error("Candidate identity mismatch");
  }
  for (const info of Object.values(candidate.packages)) {
    if ((await sha256File(packages[info.filename])) !== info.sha256) {
      throw new Error("Candidate package digest mismatch");
    }
  }
  const first = await runUpgrade(
    executable,
    profile,
    candidate,
    packages,
    directory,
    {
      expectConfirmation: true,
      seedAlbum: !retentionPrepared,
      expectedMethod: expectedIncomingMethod(
        candidate,
        path.basename(path.dirname(executable)).slice(4),
        kind === "setup" || Boolean(history)
      ),
      kind,
    }
  );
  sessions.set(kind, {
    executable,
    profile,
    candidateVersion,
    kind,
    directory,
    candidate,
    first,
    history,
  });
  return first;
}

export async function establishHistoricalMsiUpgrade(
  executable,
  profile,
  fixture,
  fullPath,
  deltaPath
) {
  await fsp.mkdir(path.resolve(".test-runtime"), { recursive: true });
  const directory = await fsp.mkdtemp(
    path.resolve(".test-runtime", "product-update-msi-history-")
  );
  const base = `https://github.com/${repository}/releases`;
  const response = await fetch(
    `${base}/download/v${fixture.version}/update-manifest.json`,
    { signal: AbortSignal.timeout(30_000) }
  );
  if (!response.ok) {
    throw new Error(`Historical manifest fetch failed: ${response.status}`);
  }
  const manifest = await response.json();
  const full = manifest.packages?.full;
  if (
    manifest.version !== fixture.version ||
    full?.filename !== fixture.filename ||
    full?.size !== fixture.size ||
    full?.sha256 !== fixture.sha256 ||
    full?.sha1?.toLowerCase() !== fixture.sha1.toLowerCase()
  ) {
    throw new Error("Historical manifest does not match the verified baseline");
  }
  const delta = manifest.packages?.delta;
  if (
    deltaPath &&
    (delta?.filename !== fixture.delta.filename ||
      delta?.sha256 !== fixture.delta.sha256 ||
      delta?.size !== fixture.delta.size ||
      delta?.fromVersion !== "2.2.8")
  ) {
    throw new Error(
      "Historical delta manifest does not match the verified fixture"
    );
  }
  const upgrade = (userData) =>
    runUpgrade(
      executable,
      userData,
      manifest,
      {
        [full.filename]: fullPath,
        ...(deltaPath ? { [delta.filename]: deltaPath } : {}),
      },
      directory,
      {
        expectConfirmation: true,
        seedAlbum: !deltaPath,
        expectedMethod: deltaPath ? "delta" : "full",
        kind: "msi",
        expectInstallFailure: Boolean(deltaPath),
      }
    );
  const history = deltaPath
    ? await isolateHistoricalMsiControl(executable, profile, directory, upgrade)
    : await upgrade(profile);
  await cleanupProductArtifacts(directory);
  return history;
}

export async function isolateHistoricalMsiControl(
  executable,
  profile,
  directory,
  runControl
) {
  // The released client's failed task persists across restarts. Give the
  // negative control its own profile so it cannot pin the candidate test to
  // the old manifest or replace its Check for Updates action with Resume.
  const isolatedProfile = path.join(directory, "control-profile");
  const stateFile = path.join(profile, "update-state.json");
  const sourceExecutableSha256 = await sha256File(executable);
  const stateSha256 = await sha256File(stateFile);
  await fsp.cp(profile, isolatedProfile, { recursive: true });
  await allowProductProfileWrites(isolatedProfile);
  const result = await runControl(isolatedProfile);
  if (
    (await sha256File(stateFile)) !== stateSha256 ||
    (await sha256File(executable)) !== sourceExecutableSha256
  ) {
    throw new Error("Historical MSI control changed the candidate source");
  }
  return { ...result, profileIsolated: true, sourceExecutableSha256 };
}

export async function allowProductProfileWrites(profile) {
  if (process.platform !== "win32") {
    return;
  }
  const directory = path.resolve(profile);
  const runtime = path.resolve(".test-runtime");
  if (
    !directory.startsWith(`${runtime}${path.sep}`) ||
    path.basename(directory) !== "control-profile"
  ) {
    throw new Error("Profile permission change escaped the isolated control");
  }
  for (
    let ancestor = directory;
    ancestor !== path.dirname(ancestor);
    ancestor = path.dirname(ancestor)
  ) {
    if ((await fsp.lstat(ancestor)).isSymbolicLink()) {
      throw new Error("Linked profile permission target");
    }
  }
  // Hosted runners copy as administrators. CREATOR OWNER can then grant the
  // copied files only to Administrators, which our standard token disables.
  // Grant the real user Modify on this disposable profile only, recursively;
  // the installed application's protected parent and its token stay unchanged.
  const script = `$ErrorActionPreference='Stop'; $root='${directory.replaceAll("'", "''")}'; if(Get-ChildItem -LiteralPath $root -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Linked profile permission child' }; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $grant='*'+$sid+':(OI)(CI)M'; & "$env:SystemRoot\\System32\\icacls.exe" $root /grant $grant /Q; if($LASTEXITCODE -ne 0) { throw 'Could not grant isolated profile inheritance' }; $grant='*'+$sid+':M'; & "$env:SystemRoot\\System32\\icacls.exe" $root /grant $grant /T /Q; if($LASTEXITCODE -ne 0) { throw 'Could not grant isolated profile writes' }`;
  await execute(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { windowsHide: true, timeout: 30_000 }
  );
  const probe = path.join(path.dirname(directory), "profile-write-probe.cjs");
  const proof = path.join(directory, ".profile-write-proof.json");
  await fsp.writeFile(
    probe,
    `const fs=require('node:fs'),path=require('node:path'); let result={status:'passed'}; try { for(const name of ['logs/startup.log','update-state.json','app-config.json']) { const file=path.join(${JSON.stringify(directory)},name); if(fs.existsSync(file)) fs.closeSync(fs.openSync(file,'r+')); } } catch(error) { result={status:'blocked',code:error.code,message:error.message}; } fs.writeFileSync(${JSON.stringify(proof)},JSON.stringify(result));`,
    { flag: "wx" }
  );
  try {
    await execute("powershell.exe", standardUserArgs, {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        AIM_STANDARD_VERIFY_PID: undefined,
        AIM_STANDARD_MSI_ROOT: undefined,
        AIM_STANDARD_EXECUTABLE: process.execPath,
        AIM_STANDARD_ARGUMENTS: `"${probe}"`,
      },
      windowsHide: true,
      timeout: 15_000,
    });
    const result = JSON.parse(await fsp.readFile(proof, "utf8"));
    if (result.status !== "passed") {
      throw new Error(
        `Standard-user profile write probe failed: ${JSON.stringify(result)}`
      );
    }
  } finally {
    await fsp.unlink(probe);
    await fsp.unlink(proof).catch((error) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}

async function finishProductChain({
  executable: _executable,
  profile,
  candidateVersion,
  kind,
  directory,
  candidate,
  first,
  history,
}) {
  const marker = await fsp.readFile(
    path.join(profile, "release-upgrade-marker.txt"),
    "utf8"
  );
  const nextVersion = candidateVersion
    .split(".")
    .map((part, index) => (index === 2 ? String(Number(part) + 1) : part))
    .join(".");
  const method = process.env.AIM_PRODUCT_SUCCESSOR_METHOD || "full";
  if (!["full", "delta"].includes(method)) {
    throw new Error("Invalid test successor method");
  }
  const baseline = candidate.packages.full;
  const next = await createTestSuccessorPackage(
    first.target,
    nextVersion,
    path.join(directory, "successor"),
    method === "delta"
      ? {
          version: candidateVersion,
          file: path.join(
            process.env.RELEASE_BUNDLE ?? "release-bundle",
            "files",
            baseline.filename
          ),
          info: baseline,
        }
      : undefined
  );
  const successor = {
    ...candidate,
    version: nextVersion,
    tag: `v${nextVersion}`,
    assetsBaseUrl: `https://github.com/${repository}/releases/download/v${nextVersion}`,
    releaseUrl: `https://github.com/${repository}/releases/tag/v${nextVersion}`,
    packages: Object.fromEntries(
      Object.entries(next).map(([kind, record]) => [kind, record.info])
    ),
  };
  const second = await runUpgrade(
    first.target,
    profile,
    successor,
    Object.fromEntries(
      Object.values(next).map(({ info, file }) => [info.filename, file])
    ),
    path.join(directory, "second"),
    {
      expectConfirmation: true,
      expectedMethod: method,
      kind,
      rateLimitAPI: requiresMetadataFallback(candidateVersion),
    }
  );
  if (
    (await fsp.readFile(
      path.join(profile, "release-upgrade-marker.txt"),
      "utf8"
    )) !== marker
  ) {
    throw new Error("User data marker changed");
  }
  const evidence = {
    kind,
    version: candidateVersion,
    commit: process.env.RELEASE_COMMIT,
    bundleSha256: await sha256File(
      path.resolve(
        process.env.RELEASE_BUNDLE ?? "release-bundle",
        "bundle.json"
      )
    ),
    status: "passed",
    first,
    second,
    ...(history ? { history } : {}),
    testSuccessorOnly: true,
  };
  const output = path.resolve(
    process.env.AIM_PRODUCT_UPDATE_EVIDENCE ?? "release-evidence/product-update"
  );
  await fsp.mkdir(output, { recursive: true });
  await fsp.writeFile(
    path.join(output, `${kind}.json`),
    JSON.stringify(evidence, null, 2)
  );
  for (const [source, name] of [
    [path.join(directory, "target.png"), `${kind}-candidate.png`],
    [path.join(directory, "second", "target.png"), `${kind}-successor.png`],
  ]) {
    await fsp.copyFile(source, path.join(output, name));
  }
  await fsp.cp(path.join(profile, "logs"), path.join(output, `${kind}-logs`), {
    recursive: true,
  });
  const retained = await cleanupProductArtifacts(directory);
  if (retained.length) {
    console.log(
      `Protected product test artifacts retained: ${JSON.stringify(retained)}`
    );
  }
  return { first, second, directory };
}

/** Delete only this task's ordinary files, retaining all protected files and Temp trees. */
export async function cleanupProductArtifacts(directory) {
  const root = path.resolve(directory);
  if (
    path.dirname(root) !== path.resolve(".test-runtime") ||
    !path.basename(root).startsWith("product-update-")
  ) {
    throw new Error("Product cleanup escaped task runtime");
  }
  for (
    let ancestor = root;
    ancestor !== path.dirname(ancestor);
    ancestor = path.dirname(ancestor)
  ) {
    if ((await fsp.lstat(ancestor)).isSymbolicLink()) {
      throw new Error("Linked cleanup ancestor");
    }
  }
  const retained = [];
  async function clean(target) {
    const stat = await fsp.lstat(target);
    if (stat.isSymbolicLink()) {
      retained.push(target);
      return;
    }
    if (stat.isDirectory()) {
      if (path.basename(target).toLowerCase() === "temp") {
        retained.push(target);
        return;
      }
      for (const name of await fsp.readdir(target)) {
        await clean(path.join(target, name));
      }
      await fsp.rmdir(target).catch((error) => {
        if (error.code !== "ENOTEMPTY") {
          throw error;
        }
      });
    } else if ([".csv", ".xlsx"].includes(path.extname(target).toLowerCase())) {
      retained.push(target);
    } else {
      await fsp.unlink(target);
    }
  }
  await clean(root);
  return retained;
}
