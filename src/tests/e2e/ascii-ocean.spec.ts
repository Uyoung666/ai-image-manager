import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { preparePackagedExecutable } from "./helpers/packaged-inspection";
import {
  closeTestApp,
  createTestRuntime,
  launchTestApp,
  test,
} from "./helpers/test-runtime";
import { seedWanderLibrary } from "./helpers/wander";

const OCEAN = "com.uyoung.theme.ascii-ocean";
const OCEAN_NAME = /ASCII Ocean|字符海洋/;
const NEBULA_NAME = /Nebula Glass|星云玻璃/;
const PREVIEW_OCEAN = /^(Preview: ASCII Ocean|预览: 字符海洋)$/;
const PANEL_BLUR = /^(Navigation blur|导航模糊)$/;
const SHARK_SPECIES = /^(Shark species|鲨鱼种类)$/;
const NAVIGATION_OPACITY = /^(Navigation opacity|导航不透明度)$/;
const EXIT_PREVIEW = /^(Exit preview|退出预览)$/;
const RESET_ALL = /^(Reset all|全部重置)$/;
const appRoot = process.env.AIM_E2E_APP_ROOT ?? path.resolve(".");
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

async function contentSurfaces() {
  await expect(async () => {
    const result = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        throw new Error("Canvas unavailable");
      }
      const rgba = (color: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        return [...ctx.getImageData(0, 0, 1, 1).data];
      };
      const luminance = (color: number[]) =>
        color.slice(0, 3).reduce((sum, c, i) => {
          const channel = c / 255;
          return (
            sum +
            (channel <= 0.040_45
              ? channel / 12.92
              : ((channel + 0.055) / 1.055) ** 2.4) *
              [0.2126, 0.7152, 0.0722][i]
          );
        }, 0);
      const root = getComputedStyle(document.documentElement);
      const panels = [
        ...document.querySelectorAll(
          '[data-surface="panel"], [data-surface="card"], [data-surface="inspector"], [data-surface="overlay"]'
        ),
      ].filter((el) => el.getClientRects().length > 0);
      const contrasts = panels.flatMap((panel) => {
        const background = luminance(
          rgba(getComputedStyle(panel).backgroundColor)
        );
        return [
          "--foreground",
          "--foreground-secondary",
          "--foreground-tertiary",
        ].map((name) => {
          const foreground = luminance(
            rgba(root.getPropertyValue(name).trim())
          );
          return (
            (Math.max(background, foreground) + 0.05) /
            (Math.min(background, foreground) + 0.05)
          );
        });
      });
      return {
        count: panels.length,
        opaque: panels.every(
          (panel) => rgba(getComputedStyle(panel).backgroundColor)[3] === 255
        ),
        unblurred: panels.every(
          (panel) => getComputedStyle(panel).backdropFilter === "none"
        ),
        minContrast: Math.min(...contrasts),
      };
    });
    expect(result.count).toBeGreaterThan(0);
    expect(result.opaque).toBe(true);
    expect(result.unblurred).toBe(true);
    expect(result.minContrast).toBeGreaterThanOrEqual(4.5);
  }).toPass({ timeout: 5000 });
}

test.beforeAll(async ({ browserName: _browserName }, testInfo) => {
  testInfo.setTimeout(120_000);
  const root = createTestRuntime("ascii-ocean");
  fs.mkdirSync(testInfo.outputDir, { recursive: true });
  const executable = await preparePackagedExecutable(root, testInfo.outputDir);
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  seedWanderLibrary(path.join(root, "profile"), { photoCount: 4 });
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
      ...(executable ? [] : [appRoot]),
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
  await page.getByRole("button", { name: EXIT_PREVIEW }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-ascii-ocean");
  await expect(page.locator(".ascii-ocean-canvas")).toHaveCount(0);
  await page.getByRole("button", { name: PREVIEW_OCEAN }).click();
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
      await page.evaluate((value) => {
        document.documentElement.classList.toggle("light", value);
        document.documentElement.classList.toggle("dark", !value);
      }, light);
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
      await expect(page.locator(".ascii-ocean-canvas")).toHaveCSS(
        "opacity",
        light ? "0.27" : "0.45"
      );
      await contentSurfaces();
      // All accent choices must preserve opaque selected cards and readable text.
      for (const accent of [
        "default",
        "pink",
        "blue",
        "green",
        "orange",
        "yellow",
      ]) {
        await page.evaluate(
          (value) => (document.documentElement.dataset.accentColor = value),
          accent
        );
        await contentSurfaces();
      }
      await page.evaluate(
        () => (document.documentElement.dataset.accentColor = "default")
      );
      await bounds();
      if (size.width === 1280) {
        await page.locator("[data-plugin-manager-view]").evaluate((element) => {
          for (
            let parent = element.parentElement;
            parent;
            parent = parent.parentElement
          ) {
            parent.scrollTop = 0;
          }
        });
        await page.screenshot({
          path: test
            .info()
            .outputPath(light ? "ocean-light.png" : "ocean-dark.png"),
        });
      }
      await page.getByRole("combobox", { name: SHARK_SPECIES }).click();
      await contentSurfaces();
      await bounds();
      await page.keyboard.press("Escape");
      await navigate("/settings/appearance");
      await contentSurfaces();
      await bounds();
      await navigate("/");
      const photo = page.locator("[data-photo-id]").first();
      await expect(photo).toBeVisible();
      await photo.click();
      await expect(
        page.locator('[data-surface="inspector"]').first()
      ).toBeVisible();
      await contentSurfaces();
      await bounds();
      await page.keyboard.press("Escape");
      await photo.click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      await contentSurfaces();
      await bounds();
      await page.keyboard.press("Escape");
      await navigate("/cull/999999999");
      await expect(
        page.locator('[data-surface="immersive"]').first()
      ).toHaveCSS("background-color", "rgb(0, 0, 0)");
      await expect(page.locator(".cull-window-chrome")).toHaveCSS(
        "background-color",
        "rgb(0, 0, 0)"
      );
      await bounds();
      await navigate("/settings/plugins");
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
    await expect(page.locator("[data-photo-id]").first()).toBeVisible();
  });
}

test("navigation parameters never reveal animation through content and reset to new defaults", async () => {
  await navigate("/settings/plugins");
  const opacity = page.getByRole("slider", { name: NAVIGATION_OPACITY });
  const blur = page.getByRole("slider", { name: PANEL_BLUR });
  for (const extreme of ["Home", "End"]) {
    await opacity.focus();
    await opacity.press(extreme);
    await opacity.press("Tab");
    await blur.focus();
    await blur.press(extreme);
    await blur.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue(
            "--ocean-panel-opacity"
          )
        )
      )
      .toBe(extreme === "Home" ? "30%" : "100%");
    await expect
      .poll(() =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--ocean-panel-blur")
        )
      )
      .toBe(extreme === "Home" ? "0px" : "20px");
    await contentSurfaces();
  }
  await page.getByRole("button", { name: RESET_ALL }).click();
  await expect(opacity).toHaveValue("92");
  await expect(blur).toHaveValue("10");
  await expect(page.locator('[data-surface="sidebar"]').first()).toHaveCSS(
    "backdrop-filter",
    "blur(10px)"
  );
  const unselected = page.locator(
    `[data-plugin-card-id='com.uyoung.theme.nebula-glass']`
  );
  const selected = page.locator(`[data-plugin-card-id='${OCEAN}']`);
  await page.mouse.move(0, 0);
  const idle = await unselected.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  );
  await unselected.hover();
  await expect
    .poll(() =>
      unselected.evaluate((el) => getComputedStyle(el).backgroundColor)
    )
    .not.toBe(idle);
  await contentSurfaces();
  await page.mouse.move(0, 0);
  const selection = await selected.evaluate(
    (el) => getComputedStyle(el).backgroundColor
  );
  await selected.hover();
  await expect
    .poll(() => selected.evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(selection);
  await contentSurfaces();
  await selected.locator("[data-plugin-selection]").focus();
  await expect(selected.locator("[data-plugin-selection]")).toBeFocused();
});

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
