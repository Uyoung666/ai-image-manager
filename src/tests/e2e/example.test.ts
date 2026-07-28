import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { findLatestBuild, parseElectronApp } from "electron-playwright-helpers";

/*
 * Using Playwright with Electron:
 * https://www.electronjs.org/pt/docs/latest/tutorial/automated-testing#using-playwright
 */

let electronApp: ElectronApplication;
const FIRST_EMPTY_STATE_TITLE =
  /^(添加照片文件夹开始整理|Add a photo folder to get started)$/;

test.beforeAll(async () => {
  const latestBuild = findLatestBuild();
  const appInfo = parseElectronApp(latestBuild);
  process.env.CI = "e2e";

  electronApp = await electron.launch({
    args: [appInfo.main],
    env: { ...process.env, CI: "e2e" },
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
  await electronApp.close();
});

test("renders the first page", async () => {
  const page: Page = await electronApp.firstWindow();

  const title = await page.waitForSelector("h1");
  const text = await title.textContent();
  // 语言自动检测：CI 环境为英文，本地开发通常为中文
  expect(text).toMatch(FIRST_EMPTY_STATE_TITLE);
});
