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
const testRoot = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-diagnostics-${process.pid}-${Date.now()}`
);
const userDataDirectory = path.join(testRoot, "user-data");
const downloadsDirectory = path.join(testRoot, "downloads");

test.setTimeout(60_000);

test.beforeAll(async () => {
  fs.mkdirSync(downloadsDirectory, { recursive: true });
  electronApp = await electron.launch({
    args: [
      "--disable-gpu-sandbox",
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      path.resolve("."),
    ],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: userDataDirectory,
      CI: "e2e",
    },
    timeout: 20_000,
  });
  page = await electronApp.firstWindow();
  await electronApp.evaluate(({ app, shell }, outputDirectory) => {
    const state = globalThis as typeof globalThis & {
      __diagnosticHandoff?: { issueUrl?: string; selectedPath?: string };
    };
    state.__diagnosticHandoff = {};
    app.setPath("downloads", outputDirectory);
    shell.openExternal = (url) => {
      state.__diagnosticHandoff = {
        ...state.__diagnosticHandoff,
        issueUrl: url,
      };
      return Promise.resolve();
    };
    shell.showItemInFolder = (selectedPath) => {
      state.__diagnosticHandoff = {
        ...state.__diagnosticHandoff,
        selectedPath,
      };
    };
  }, downloadsDirectory);
});

test.afterAll(async () => {
  await electronApp?.close();
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

  const issueUrl = new URL(handoff?.issueUrl ?? "");
  expect(issueUrl.hostname).toBe("github.com");
  expect(issueUrl.searchParams.get("title")).toContain("[Bug][v1.4.0]");
  expect(issueUrl.searchParams.get("body")).toContain("Clicked AI indexing");
  expect(issueUrl.searchParams.get("body")).toContain(
    "Drag the ZIP highlighted by the app here."
  );
});
