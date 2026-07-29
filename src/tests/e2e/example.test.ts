import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

/*
 * Using Playwright with Electron:
 * https://www.electronjs.org/pt/docs/latest/tutorial/automated-testing#using-playwright
 */

let electronApp: ElectronApplication | undefined;
const e2eUserDataDir = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-${process.pid}-${Date.now()}`
);
const FIRST_EMPTY_STATE_TITLE =
  /^(添加照片文件夹开始整理|Add a photo folder to get started)$/;

test.setTimeout(30_000);

test.beforeAll(async () => {
  process.env.CI = "e2e";

  electronApp = await electron.launch({
    args: [
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      `--user-data-dir=${e2eUserDataDir}`,
      path.resolve("."),
    ],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: e2eUserDataDir,
      CI: "e2e",
    },
    timeout: 15_000,
  });
  electronApp.on("window", (page) => {
    const filename = page.url()?.split("/").pop();
    console.log(`Window opened: ${filename}`);

    page.on("pageerror", (error) => {
      console.error(error);
    });
    page.on("console", (msg) => {
      console.log(msg.text());
    });
  });
});

test.afterAll(async () => {
  await electronApp?.close();
});

test("renders the first page", async () => {
  if (!electronApp) {
    throw new Error("Electron application failed to launch");
  }
  const page: Page = await electronApp.firstWindow();

  const title = page.getByRole("heading", { name: FIRST_EMPTY_STATE_TITLE });
  await expect(title).toBeVisible({ timeout: 10_000 });
});
