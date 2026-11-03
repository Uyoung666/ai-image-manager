import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import {
  closeTestApp,
  createTestRuntime,
  launchTestApp,
  test,
} from "./helpers/test-runtime";

const OCEAN = "com.uyoung.theme.ascii-ocean";
const OCEAN_NAME = /ASCII Ocean|字符海洋/;
const NEBULA_NAME = /Nebula Glass|星云玻璃/;
const ADD_FOLDER = /Add folder|添加文件夹/i;
const PREVIEW_OCEAN = /^(Preview: ASCII Ocean|预览: 字符海洋)$/;
const PANEL_BLUR = /^(Panel blur|面板模糊)$/;
const SHARK_SPECIES = /^(Shark species|鲨鱼种类)$/;
const executable = process.env.AIM_PACKAGED_E2E_EXECUTABLE;
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

async function navigate(route: string) {
  await page.evaluate((next) => {
    if (!window.__e2eNavigate) {
      throw new Error("E2E navigation unavailable");
    }
    return window.__e2eNavigate(next);
  }, route);
  await expect(page.locator("main").first()).toBeVisible();
}

async function bounds() {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const targets = [
          document.documentElement,
          ...document.querySelectorAll(
            "main, [role='dialog'], [role='menu'], [role='listbox']"
          ),
        ];
        return targets.every((element) => {
          const rect = element.getBoundingClientRect();
          return (
            element.scrollWidth <= element.clientWidth + 2 &&
            rect.left >= -2 &&
            rect.right <= innerWidth + 2 &&
            rect.top >= -2 &&
            rect.bottom <= innerHeight + 2
          );
        });
      })
    )
    .toBe(true);
}

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(120_000);
  const root = createTestRuntime("ascii-ocean");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && typeof entry[1] === "string"
    )
  );
  app = await launchTestApp(root, {
    ...(executable ? { executablePath: executable } : {}),
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--e2e",
      ...(executable ? [] : [path.resolve(".")]),
    ],
    env: {
      ...env,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: path.join(root, "profile"),
      TEMP: scratch,
      TMP: scratch,
    },
  });
  page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await page.evaluate(() => localStorage.setItem("lang", "en"));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await navigate("/settings/plugins");
});

test.afterAll(async () => {
  if (app) {
    await closeTestApp(app);
  }
});

test("starts disabled, previews without enabling, persists settings and restores after reload", async () => {
  const toggle = page.getByRole("checkbox", { name: OCEAN_NAME });
  await expect(toggle).not.toBeChecked();
  await page
    .locator(`[data-plugin-card-id='${OCEAN}'] [data-plugin-selection]`)
    .click();
  await page.getByRole("button", { name: PREVIEW_OCEAN }).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-ascii-ocean",
    "active"
  );
  await expect(toggle).not.toBeChecked();
  await toggle.locator("..").click();
  await expect(toggle).toBeChecked();
  await expect(page.locator("[data-testid='preview-banner']")).toHaveCount(0);
  const blur = page.getByRole("slider", { name: PANEL_BLUR });
  await blur.focus();
  await blur.press("ArrowRight");
  await blur.press("Tab");
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--ocean-panel-blur")
      )
    )
    .toBe("11px");
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await navigate("/settings/plugins");
  await expect(toggle).toBeChecked();
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--ocean-panel-blur")
      )
    )
    .toBe("11px");
});

for (const size of [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
]) {
  test(`${size.width}x${size.height} supports palettes, settings, dropdowns and the gallery`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    await navigate("/settings/plugins");
    await page
      .locator(`[data-plugin-card-id='${OCEAN}'] [data-plugin-selection]`)
      .click();
    for (const light of [false, true]) {
      await page.evaluate(
        (value) => document.documentElement.classList.toggle("light", value),
        light
      );
      await expect(page.locator(".ascii-ocean-canvas")).toBeVisible();
      await expect
        .poll(() =>
          page.locator(".ascii-ocean-canvas").evaluate((element) => {
            const canvas = element as HTMLCanvasElement;
            return (
              (canvas.getContext("2d")?.getImageData(0, 0, 1, 1).data[0] ?? 0) >
              180
            );
          })
        )
        .toBe(light);
      await bounds();
      if (size.width === 1280) {
        await page.screenshot({
          path: test
            .info()
            .outputPath(light ? "ocean-light.png" : "ocean-dark.png"),
        });
      }
    }
    await page.getByRole("combobox", { name: SHARK_SPECIES }).click();
    await bounds();
    await page.keyboard.press("Escape");
    await navigate("/");
    await expect(page.locator(".ascii-ocean-canvas")).toHaveCSS(
      "pointer-events",
      "none"
    );
    await bounds();
    if (size.width === 1280) {
      await page.screenshot({
        path: test.info().outputPath("ocean-gallery.png"),
      });
    }
    await expect(
      page.getByRole("button", { name: ADD_FOLDER }).first()
    ).toBeEnabled();
  });
}

test("handles 125% zoom, reduced motion and switching back to Nebula Glass", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(900, 600);
    window.webContents.setZoomFactor(1.25);
  });
  await navigate("/settings/plugins");
  await bounds();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator(".ascii-ocean-canvas")).toBeVisible();
  await page.getByRole("checkbox", { name: NEBULA_NAME }).locator("..").click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-nebula-glass",
    "active"
  );
  await expect(page.locator("html")).not.toHaveAttribute("data-ascii-ocean");
  await expect(page.locator(".ascii-ocean-canvas")).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: OCEAN_NAME })
  ).not.toBeChecked();
  await page.getByRole("checkbox", { name: NEBULA_NAME }).locator("..").click();
  await expect(page.locator("html")).not.toHaveAttribute("data-nebula-glass");
  await expect(page.locator(".nebula-glass-backdrop")).toHaveCount(0);
  await bounds();
});
