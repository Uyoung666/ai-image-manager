import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";
import { seedWanderLibrary } from "./helpers/wander";

const SIZES = [
  { width: 720, height: 480, zoom: 1 },
  { width: 900, height: 600, zoom: 1 },
  { width: 1280, height: 800, zoom: 1 },
  { width: 720, height: 480, zoom: 1.5 },
];
const LANGUAGE_LABEL = /^(Language|语言)$/;
const reviewDir = path.resolve(".cache/about-review/creator-avatar-20261030");
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  const root = createTestRuntime("about-page");
  const profile = path.join(root, "profile");
  seedWanderLibrary(profile, { enabled: false, photoCount: 4 });
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  fs.mkdirSync(reviewDir, { recursive: true });
  app = await launchTestApp(root, {
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--e2e",
      path.resolve("."),
    ],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      CI: "e2e",
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "local"),
      TEMP: scratch,
      TMP: scratch,
    },
    recordVideo: {
      dir: path.join(reviewDir, "video"),
      size: { width: 1280, height: 800 },
    },
  });
  page = await app.firstWindow();
  // Startup can briefly expose a separate loading window before the workspace.
  await expect
    .poll(
      async () => {
        for (const candidate of app.windows()) {
          if (
            !candidate.isClosed() &&
            (await candidate.locator("main").count())
          ) {
            page = candidate;
            return true;
          }
        }
        return false;
      },
      { timeout: 30_000 }
    )
    .toBe(true);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setZoomFactor(1);
    window.setContentSize(1280, 800);
  });
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("ui.reduceMotion", "false");
  });
  await page.reload();
  await page.locator("main").waitFor();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus()
  );
});

test.afterAll(async () => {
  await app?.close();
});

async function navigate(route: string) {
  await page.evaluate((next) => window.__e2eNavigate?.(next), route);
  await page.locator("main").waitFor();
}

async function capture(filename: string) {
  await page.waitForTimeout(750);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 20_000,
  });
  const png = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
      .toPNG()
      .toString("base64")
  );
  fs.writeFileSync(path.join(reviewDir, filename), Buffer.from(png, "base64"));
}

async function noOverflow() {
  const overflow = await page.evaluate(() =>
    [
      document.documentElement,
      document.body,
      document.querySelector("main"),
    ].map((element) =>
      element ? element.scrollWidth - element.clientWidth : 0
    )
  );
  expect(overflow.every((value) => value <= 2)).toBe(true);
}

for (const size of SIZES) {
  test(`about composition fits ${size.width}x${size.height} at ${size.zoom}`, async () => {
    await app.evaluate(({ BrowserWindow }, b) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(b.width, b.height);
      w.webContents.setZoomFactor(b.zoom);
    }, size);
    for (const language of ["zh", "en"]) {
      await navigate("/settings/appearance");
      await page.getByRole("combobox", { name: LANGUAGE_LABEL }).click();
      await page
        .getByRole("option", {
          name: language === "zh" ? "中文 (zh)" : "English (en)",
          exact: true,
        })
        .click();
      for (const theme of ["light", "dark"]) {
        await page.evaluate((theme) => {
          document.documentElement.classList.remove("light", "dark");
          document.documentElement.classList.add(theme);
        }, theme);
        await navigate("/settings/about");
        const creator = page.getByTestId("about-creator");
        await creator.scrollIntoViewIfNeeded();
        await creator.hover();
        await expect(creator).toHaveAttribute("data-expanded", "true");
        await page.waitForTimeout(1100);
        for (const selector of [
          ".about-creator-cover",
          ".about-creator-copy",
          ".about-creator-links",
          ".about-small-signature",
        ]) {
          const parent = await creator.boundingBox();
          const child = await page.locator(selector).boundingBox();
          if (!(parent && child)) {
            throw new Error("Missing card bounds");
          }
          expect(child.x).toBeGreaterThanOrEqual(parent.x);
          expect(child.x + child.width).toBeLessThanOrEqual(
            parent.x + parent.width + 1
          );
          expect(child.y + child.height).toBeLessThanOrEqual(
            parent.y + parent.height + 1
          );
        }
        await noOverflow();
        await page.locator("main h2").scrollIntoViewIfNeeded();
        await capture(`${size.width}-${size.zoom}-${language}-${theme}.png`);
        await page.getByTestId("about-website").scrollIntoViewIfNeeded();
        await expect
          .poll(() =>
            page
              .locator(".about-browser-preview img")
              .evaluateAll((imgs) =>
                imgs.every((img) => (img as HTMLImageElement).naturalWidth > 0)
              )
          )
          .toBe(true);
        await noOverflow();
      }
    }
  });
}
test("creator keyboard and reduced motion work offline", async () => {
  await page.context().setOffline(true);
  try {
    await navigate("/settings/about");
    const creator = page.getByTestId("about-creator");
    const cover = page.locator(".about-creator-cover");
    await page.mouse.move(0, 0);
    await cover.focus();
    await expect(creator).toHaveAttribute("data-expanded", "true");
    await cover.press("Enter");
    await expect(creator).toHaveAttribute("data-expanded", "false");
    await cover.press("Space");
    await expect(creator).toHaveAttribute("data-expanded", "true");
    await page.waitForTimeout(1000);
    await capture("creator-expanded.png");
    await cover.press("Escape");
    await expect(creator).toHaveAttribute("data-expanded", "false");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(creator).toHaveAttribute("data-expanded", "true");
    await expect(cover).toBeDisabled();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await navigate("/settings/update");
    await navigate("/settings/about");
    await page.getByTestId("about-website").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("about-website")).toBeVisible();
  } finally {
    await page.context().setOffline(false);
  }
});

test("capture desktop interaction", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.setContentSize(1280, 800);
    w.webContents.setZoomFactor(1);
  });
  await navigate("/settings/appearance");
  await page.getByRole("combobox", { name: LANGUAGE_LABEL }).click();
  await page.getByRole("option", { name: "中文 (zh)", exact: true }).click();
  await page.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  });
  await navigate("/settings/about");
  await page.mouse.move(0, 0);
  await page.locator(".about-product-version").focus();
  await page.locator("main h2").scrollIntoViewIfNeeded();
  await capture("desktop-default.png");
  const creator = page.getByTestId("about-creator");
  await expect(creator).not.toHaveCSS("box-shadow", "none");
  await expect(page.locator(".about-creator-panel")).toHaveCSS(
    "background-color",
    "rgb(251, 185, 182)"
  );
  await expect(page.locator(".about-creator-contact")).toHaveCSS(
    "border-radius",
    "20px"
  );
  await expect(page.locator(".about-creator-contact")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)"
  );
  await expect
    .poll(() =>
      page
        .locator(".about-creator-cover img")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth)
    )
    .toBeGreaterThan(0);
  await creator.evaluate((element) =>
    element.dispatchEvent(
      new PointerEvent("pointerover", { bubbles: true, pointerType: "touch" })
    )
  );
  await expect(creator).toHaveAttribute("data-expanded", "false");
  await creator.hover();
  await page.waitForTimeout(900);
  await capture("desktop-expanded.png");
  await page.mouse.move(0, 0);
  await page.waitForTimeout(900);
  await creator.hover();
  await page.waitForTimeout(900);
});
