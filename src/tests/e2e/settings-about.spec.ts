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
const reviewDir = path.resolve(".cache/about-review");
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
  test(`about page fits ${size.width}x${size.height} at ${size.zoom} zoom`, async () => {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(bounds.width, bounds.height);
      window.webContents.setZoomFactor(bounds.zoom);
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
      await expect(page.locator("html")).toHaveAttribute("lang", language);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((next) => {
          document.documentElement.classList.remove("light", "dark");
          document.documentElement.classList.add(next);
        }, theme);
        await navigate("/settings/about");
        await expect(page.getByTestId("about-crowd")).toHaveAttribute(
          "data-status",
          "ready"
        );
        await expect(page.locator(".about-identity")).toHaveCount(0);
        const author = page.locator(".about-author");
        await expect(author).toHaveAttribute("data-message", "name");
        const originalAuthorHeight = (await author.boundingBox())?.height;
        await author.hover();
        await expect(author).toHaveAttribute("data-message", "greeting");
        await author.click();
        await expect(author).toHaveAttribute("data-message", "message");
        expect((await author.boundingBox())?.height).toBeCloseTo(
          originalAuthorHeight ?? 0,
          2
        );
        await noOverflow();
        if (size.width === 1280 && language === "zh" && theme === "dark") {
          await capture("author-message.png");
        }
        await author.press("Space");
        await expect(author).toHaveAttribute("data-message", "greeting");
        await author.press("Tab");
        await page.mouse.move(0, 0);
        await expect(author).toHaveAttribute("data-message", "name");
        const cards = page.locator(".about-gallery-card");
        await expect(cards).toHaveCount(5);
        const authorTop = await author.evaluate(
          (element) => element.getBoundingClientRect().top
        );
        const galleryTop = await page
          .getByTestId("about-gallery")
          .evaluate((element) => element.getBoundingClientRect().top);
        expect(authorTop).toBeLessThan(galleryTop);
        await expect
          .poll(() =>
            page
              .locator(".about-artwork")
              .evaluateAll((images) =>
                images.every(
                  (image) => (image as HTMLImageElement).naturalWidth > 0
                )
              )
          )
          .toBe(true);
        await cards.nth(2).click();
        await page.locator("main h2").scrollIntoViewIfNeeded();
        await capture(
          `${size.width}-${size.zoom}-${language}-${theme}-top.png`
        );
        await cards.nth(4).focus();
        await cards.nth(4).press("Enter");
        await expect(cards.nth(4)).toHaveAttribute("aria-pressed", "true");
        const cardBounds = await cards.nth(4).boundingBox();
        expect(cardBounds?.x).toBeGreaterThanOrEqual(0);
        expect(
          (cardBounds?.x ?? 0) + (cardBounds?.width ?? 0)
        ).toBeLessThanOrEqual((await page.evaluate(() => innerWidth)) + 2);
        if (
          ((await page.getByTestId("about-gallery").boundingBox())?.width ??
            0) >= 560
        ) {
          await cards.nth(0).hover();
          await expect(cards.nth(0)).toHaveAttribute("data-active", "true");
        }
        await noOverflow();
        const deps = page.locator('button[aria-controls="about-dependencies"]');
        await deps.click();
        await expect(deps).toHaveAttribute("aria-expanded", "true");
        await noOverflow();
        await deps.click();
        const canvas = page.locator(".about-crowd-canvas");
        await canvas.scrollIntoViewIfNeeded();
        await expect(canvas).toHaveAttribute("data-crowd-playing", "true");
        await expect
          .poll(() =>
            canvas.evaluate((element) => (element as HTMLCanvasElement).width)
          )
          .toBeGreaterThan(0);
        await capture(
          `${size.width}-${size.zoom}-${language}-${theme}-crowd.png`
        );
        await page.locator("main h2").scrollIntoViewIfNeeded();
        const stageVisible = await page
          .locator(".about-crowd-stage")
          .evaluate((stage) => {
            const bounds = stage.getBoundingClientRect();
            const scroll = stage.closest(".overflow-y-auto");
            const viewport = scroll?.getBoundingClientRect();
            return (
              bounds.bottom > (viewport?.top ?? 0) &&
              bounds.top < (viewport?.bottom ?? innerHeight)
            );
          });
        await expect(canvas).toHaveAttribute(
          "data-crowd-playing",
          String(stageVisible)
        );
      }
    }
  });
}

test("crowd pauses, resumes and respects application and system reduced motion", async () => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.webContents.setZoomFactor(1);
    window.setContentSize(900, 600);
  });
  await navigate("/settings/about");
  const canvas = page.locator(".about-crowd-canvas");
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas).toHaveAttribute("data-crowd-playing", "true");
  const toggle = page.getByRole("checkbox", { name: "Play crowd animation" });
  await toggle.locator("..").click();
  await expect(canvas).toHaveAttribute("data-crowd-playing", "false");
  const still = await canvas.evaluate((element) =>
    (element as HTMLCanvasElement).toDataURL()
  );
  await page.waitForTimeout(250);
  expect(
    await canvas.evaluate((element) =>
      (element as HTMLCanvasElement).toDataURL()
    )
  ).toBe(still);
  await toggle.locator("..").click();
  await expect(canvas).toHaveAttribute("data-crowd-playing", "true");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(toggle).toBeDisabled();
  await expect(canvas).toHaveAttribute("data-crowd-playing", "false");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect(canvas).toHaveAttribute("data-crowd-playing", "true");
  await navigate("/settings/appearance");
  const preference = page.getByRole("checkbox", { name: "Reduce motion" });
  await preference.locator("..").click();
  await navigate("/settings/about");
  await canvas.scrollIntoViewIfNeeded();
  await expect(toggle).toBeDisabled();
  await expect(canvas).toHaveAttribute("data-crowd-playing", "false");
  await page.locator(".about-author").hover();
  await expect(page.locator(".about-author")).toHaveAttribute(
    "data-message",
    "greeting"
  );
  await expect(page.locator(".about-author-letter").first()).toHaveCSS(
    "transition-duration",
    "0s"
  );
  await navigate("/settings/appearance");
  await preference.locator("..").click();
});

test("bundled artwork and crowd load offline, including after leaving and returning", async () => {
  await page.context().setOffline(true);
  try {
    await navigate("/settings/about");
    await expect(page.getByTestId("about-crowd")).toHaveAttribute(
      "data-status",
      "ready"
    );
    await expect
      .poll(() =>
        page
          .locator(".about-artwork")
          .evaluateAll((images) =>
            images.every(
              (image) => (image as HTMLImageElement).naturalWidth > 0
            )
          )
      )
      .toBe(true);
    await navigate("/settings/update");
    await navigate("/settings/about");
    await expect(page.getByTestId("about-crowd")).toHaveAttribute(
      "data-status",
      "ready"
    );
    await page.locator(".about-crowd-canvas").scrollIntoViewIfNeeded();
    await expect(page.locator(".about-crowd-canvas")).toHaveAttribute(
      "data-crowd-playing",
      "true"
    );
  } finally {
    await page.context().setOffline(false);
  }
});
