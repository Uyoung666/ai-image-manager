import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const SETTINGS_NAME = /^(设置|Settings)$/;
const DIAGNOSTICS_NAME = /^(帮助与诊断|Help & Diagnostics)$/;
const GENERATE_NAME = /^(生成诊断包并前往反馈|Generate bundle and report)$/;
const READY_NAME = /^(诊断包已准备好|Diagnostic bundle is ready)$/;
const DIAGNOSTIC_ZIP_PATTERN = /AI-Image-Manager-Diagnostics-AIM-.*\.zip$/;

let electronApp: ElectronApplication | undefined;
let page: Page | undefined;
let selectedBundlePath: string | undefined;
const packagedExecutable = process.env.AIM_PACKAGED_E2E_EXECUTABLE;
const performSystemHandoff = process.env.AIM_FULL_SYSTEM_E2E === "1";
const testRoot = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-diagnostics-${process.pid}-${Date.now()}`
);
const userDataDirectory = path.join(testRoot, "user-data");
const downloadsDirectory = path.join(testRoot, "downloads");

test.setTimeout(60_000);

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(packagedExecutable ? 90_000 : 30_000);
  fs.mkdirSync(downloadsDirectory, { recursive: true });
  const electronArgs = [
    "--disable-gpu-sandbox",
    "--no-sandbox",
    "--enable-unsafe-swiftshader",
    "--use-angle=swiftshader",
    "--e2e",
  ];
  electronApp = await electron.launch({
    args: packagedExecutable
      ? electronArgs
      : [...electronArgs, path.resolve(".")],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: userDataDirectory,
      CI: "e2e",
    },
    executablePath: packagedExecutable
      ? path.resolve(packagedExecutable)
      : undefined,
    timeout: packagedExecutable ? 60_000 : 20_000,
  });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(
    ({ app, shell }, handoff) => {
      const state = globalThis as typeof globalThis & {
        __diagnosticHandoff?: { issueUrl?: string; selectedPath?: string };
      };
      const openExternal = handoff.performSystemHandoff
        ? shell.openExternal.bind(shell)
        : undefined;
      const showItemInFolder = handoff.performSystemHandoff
        ? shell.showItemInFolder.bind(shell)
        : undefined;
      state.__diagnosticHandoff = {};
      app.setPath("downloads", handoff.outputDirectory);
      shell.openExternal = (url) => {
        state.__diagnosticHandoff = {
          ...state.__diagnosticHandoff,
          issueUrl: url,
        };
        return openExternal ? openExternal(url) : Promise.resolve();
      };
      shell.showItemInFolder = (selectedPath) => {
        state.__diagnosticHandoff = {
          ...state.__diagnosticHandoff,
          selectedPath,
        };
        showItemInFolder?.(selectedPath);
      };
    },
    { outputDirectory: downloadsDirectory, performSystemHandoff }
  );
});

test.afterAll(async () => {
  await electronApp?.close();
  if (performSystemHandoff && selectedBundlePath) {
    closeExplorerWindowSelecting(selectedBundlePath);
  }
  if (path.dirname(testRoot) === os.tmpdir()) {
    fs.rmSync(testRoot, { force: true, recursive: true });
  }
});

test("exports within the target time and hands off a prefilled issue", async () => {
  if (!(electronApp && page)) {
    throw new Error("Electron application failed to launch");
  }
  await expect
    .poll(
      () => electronApp?.windows().filter((window) => window.url()).length ?? 0,
      { timeout: 30_000 }
    )
    .toBeGreaterThan(0);
  page = electronApp.windows().find((window) => window.url()) ?? page;
  await page.getByRole("button", { name: SETTINGS_NAME }).click();
  await page.getByRole("button", { name: DIAGNOSTICS_NAME }).click();
  await expect(
    page.getByRole("heading", { name: DIAGNOSTICS_NAME })
  ).toBeVisible();

  const fields = page.locator("textarea");
  await fields.nth(0).fill("Clicked AI indexing");
  await fields.nth(1).fill("The page became blank");
  const startedAt = Date.now();
  await page.getByRole("button", { name: GENERATE_NAME }).click();
  await expect(page.getByText(READY_NAME)).toBeVisible({ timeout: 5000 });
  expect(Date.now() - startedAt).toBeLessThanOrEqual(5000);

  const handoff = await electronApp.evaluate(() => {
    const state = globalThis as typeof globalThis & {
      __diagnosticHandoff?: { issueUrl?: string; selectedPath?: string };
    };
    return state.__diagnosticHandoff;
  });
  expect(handoff?.selectedPath).toMatch(DIAGNOSTIC_ZIP_PATTERN);
  expect(path.dirname(handoff?.selectedPath ?? "")).toBe(downloadsDirectory);
  expect(fs.existsSync(handoff?.selectedPath ?? "")).toBe(true);
  selectedBundlePath = handoff?.selectedPath;

  if (performSystemHandoff && selectedBundlePath) {
    await expect
      .poll(() => getExplorerSelections(), { timeout: 10_000 })
      .toContain(path.resolve(selectedBundlePath).toLowerCase());
  }

  const issueUrl = new URL(handoff?.issueUrl ?? "");
  expect(issueUrl.hostname).toBe("github.com");
  expect(issueUrl.searchParams.get("title")).toContain("[Bug][v2.0.0]");
  expect(issueUrl.searchParams.get("body")).toContain("Clicked AI indexing");
  expect(issueUrl.searchParams.get("body")).toContain(
    "Drag the ZIP highlighted by the app here."
  );
});

function getExplorerSelections(): string[] {
  const output = execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$shell = New-Object -ComObject Shell.Application; $paths = @(); foreach ($window in @($shell.Windows())) { try { foreach ($item in @($window.Document.SelectedItems())) { $paths += $item.Path.ToLowerInvariant() } } catch {} }; $paths | ConvertTo-Json -Compress",
    ],
    { encoding: "utf8" }
  ).trim();
  if (!output) {
    return [];
  }
  const parsed = JSON.parse(output) as string | string[];
  return Array.isArray(parsed) ? parsed : [parsed];
}

function closeExplorerWindowSelecting(selectedPath: string): void {
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$target = $env:AIM_E2E_SELECTED_PATH; $shell = New-Object -ComObject Shell.Application; foreach ($window in @($shell.Windows())) { try { $selected = @($window.Document.SelectedItems()) | Where-Object { $_.Path -eq $target }; if ($selected.Count -gt 0) { $window.Quit() } } catch {} }",
    ],
    {
      encoding: "utf8",
      env: { ...process.env, AIM_E2E_SELECTED_PATH: selectedPath },
    }
  );
}
