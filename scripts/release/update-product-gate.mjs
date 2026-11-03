import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import { sha256File } from "./checksums.mjs";
import { createProductUpdateProxy } from "./update-product-proxy.mjs";

const LEADING_PATH_SEPARATOR = /^[/\\]/;
const CONTINUE_BUTTON = /^(继续|Continue)$/;
const SAVE_CONTINUE_BUTTON = /^(保存并继续|Save and Continue|Save & Continue)$/;
const START_BUTTON = /^(开始使用|Get started|Start using)$/i;
const CLOSE_BEHAVIOR_LABEL = /^(关闭行为|Close behavior)$/;
const QUIT_OPTION = /^(退出应用|Quit the app)$/;
const NEW_ALBUM_BUTTON = /^(新建相册|New Album|New album)$/;
const ALBUM_NAME_PLACEHOLDER = /相册名称|Album name/i;
const CREATE_BUTTON = /^(创建|Create)$/;
const CHECK_BUTTON = /^(检查更新|Check for Updates|Check for updates)$/;
const INSTALL_BUTTON = /^(安装并重启|Install and restart)$/;
const CLOSE_BUTTON = /^(关闭|Close)$/;
const AUTO_UPDATE_CHECKBOX = /^(自动更新|Automatic updates)$/;

const execute = promisify(execFile);
const require = createRequire(import.meta.url);
const repository = "Uyoung666/ai-image-manager";
const sessions = new Map();
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

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
  directory
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
  const filename = `ai-image-manager-${version}-full.nupkg`;
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

async function waitFor(callback, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
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

/** Uses Chromium CDP only. Release fuses, updater code and TLS verification stay enabled. */
async function runUpgrade(
  executable,
  profile,
  manifest,
  packages,
  directory,
  expectConfirmation
) {
  await fsp.mkdir(directory, { recursive: true });
  const { chromium, expect } = await import("@playwright/test");
  const sourceExecutableSha256 = await sha256File(executable);
  const proxy = await createProductUpdateProxy(
    path.join(directory, "tls"),
    manifest,
    packages
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
  };
  let browser;
  let child;
  let page;
  let targetProcess;
  let primaryError;
  let stage = "launch";
  const target = installedTargetPath(executable, manifest.version);
  const connect = async () => {
    await waitFor(
      async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok,
      "CDP"
    );
    return chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  };
  try {
    child = spawn(
      executable,
      [
        `--proxy-server=${proxy.url}`,
        `--remote-debugging-port=${port}`,
        "--remote-debugging-address=127.0.0.1",
      ],
      { env, windowsHide: true, stdio: "ignore" }
    );
    child.on("error", () => undefined);
    browser = await connect();
    page = browser.contexts()[0].pages()[0];
    if (await page.evaluate(() => Boolean(window.electronAPI?.isE2E))) {
      throw new Error("Production startup bypass is enabled");
    }
    stage = "startup router";
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
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
    const album = "Product upgrade retention album";
    if ((await page.getByText(album, { exact: true }).count()) === 0) {
      await page
        .getByRole("button", { name: NEW_ALBUM_BUTTON })
        .first()
        .click();
      await page.getByPlaceholder(ALBUM_NAME_PLACEHOLDER).fill(album);
      await page.getByRole("button", { name: CREATE_BUTTON }).click();
    }
    await page.getByText(album, { exact: true }).waitFor();
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
    await page
      .getByRole("button", {
        name: CHECK_BUTTON,
      })
      .click();
    await page
      .getByRole("button", { name: INSTALL_BUTTON })
      .waitFor({ timeout: 180_000 });
    const stateFile = path.join(profile, "update-state.json");
    const before = JSON.parse(await fsp.readFile(stateFile, "utf8")).state;
    if (before.version !== manifest.version || before.phase !== "downloaded") {
      throw new Error("Real updater did not download target");
    }
    stage = "install and automatic restart";
    await expectRestart(
      browser,
      () => page.getByRole("button", { name: INSTALL_BUTTON }).click(),
      async () => JSON.parse(await fsp.readFile(stateFile, "utf8")).state
    );
    browser = await connect();
    page = browser.contexts()[0].pages()[0];
    targetProcess = await readBrowserProcess(browser);
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
    page = browser.contexts()[0].pages()[0];
    const secondProcess = await readBrowserProcess(browser);
    if (
      secondProcess.pid === targetProcess.pid ||
      path.resolve(secondProcess.path).toLowerCase() !==
        path.resolve(target).toLowerCase()
    ) {
      throw new Error("Ordinary restart did not start a new target process");
    }
    targetProcess = secondProcess;
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate("/albums"));
    await page
      .getByText("Product upgrade retention album", { exact: true })
      .waitFor();
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
    console.error(
      `[product-update] ${stage} failed: ${error.stack ?? String(error)}`
    );
    await saveProductFailure(directory, profile, page, {
      stage,
      message: String(error),
      stack: error.stack,
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
              await new Promise((resolve, reject) => {
                child.once("exit", resolve);
                child.once("error", reject);
                try {
                  child.kill();
                } finally {
                  // The cleanup deadline still observes exit; failed termination
                  // must not keep the validation helper alive indefinitely.
                  child.unref();
                }
              });
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
  stage
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
    true
  );
  sessions.set(kind, {
    executable,
    profile,
    candidateVersion,
    kind,
    directory,
    candidate,
    first,
  });
  return first;
}
async function finishProductChain({
  executable: _executable,
  profile,
  candidateVersion,
  kind,
  directory,
  candidate,
  first,
}) {
  const marker = await fsp.readFile(
    path.join(profile, "release-upgrade-marker.txt"),
    "utf8"
  );
  const nextVersion = candidateVersion
    .split(".")
    .map((part, index) => (index === 2 ? String(Number(part) + 1) : part))
    .join(".");
  const next = await createTestSuccessorPackage(
    first.target,
    nextVersion,
    path.join(directory, "successor")
  );
  const successor = {
    ...candidate,
    version: nextVersion,
    tag: `v${nextVersion}`,
    assetsBaseUrl: `https://github.com/${repository}/releases/download/v${nextVersion}`,
    releaseUrl: `https://github.com/${repository}/releases/tag/v${nextVersion}`,
    packages: { full: next.info },
  };
  const second = await runUpgrade(
    first.target,
    profile,
    successor,
    { [next.info.filename]: next.file },
    path.join(directory, "second"),
    true
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
