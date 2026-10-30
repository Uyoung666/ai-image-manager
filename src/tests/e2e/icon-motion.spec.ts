import fs from "node:fs";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

let app: ElectronApplication;
let page: Page;
let runtimeRoot: string;
const IDENTITY_TRANSFORM_PATTERN = /^(none|matrix\(1, 0, 0, 1, 0, 0\))$/;
const ACTIVE_NAVIGATION_PATTERN = /bg-primary\/15/;
const DARK_THEME_PATTERN = /\bdark\b/;
const LIGHT_THEME_PATTERN = /\blight\b/;
test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async () => {
  const root = createTestRuntime("icon-motion");
  runtimeRoot = root;
  const profile = path.join(root, "profile");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  const isolation = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    isolation,
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
  );
  app = await launchTestApp(root, {
    args: ["-r", isolation, "--e2e", path.resolve(".")],
    env: Object.fromEntries(
      Object.entries({
        ...process.env,
        ELECTRON_RUN_AS_NODE: undefined,
        CI: "e2e",
        AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
        AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
        APPDATA: path.join(root, "appdata"),
        LOCALAPPDATA: path.join(root, "local"),
        TEMP: scratch,
        TMP: scratch,
      }).filter((entry): entry is [string, string] => entry[1] !== undefined)
    ),
  });
  page = await waitForHomeWindow(app);
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("sidebar_collapsed", "true");
    localStorage.setItem("ui.reduceMotion", "false");
  });
  await page.reload();
  await expect(page.locator(".home-search-input")).toBeVisible();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => !window.isDestroyed() && window.getTitle() !== "")
      ?.focus()
  );
});

test.afterAll(async () => {
  await app?.close();
});

async function expectNoOverflow() {
  expect(
    await page.evaluate(() =>
      [
        document.documentElement,
        document.body,
        ...document.querySelectorAll("main"),
      ]
        .filter((element) => element.getClientRects().length)
        .map((element) => element.scrollWidth - element.clientWidth)
        .filter((overflow) => overflow > 2)
    )
  ).toEqual([]);
}

async function expectOneShot(control: Locator) {
  const window = await app.browserWindow(page);
  await window.evaluate((main) => main.focus());
  await expect(page.locator("html")).toHaveAttribute(
    "data-icon-motion-paused",
    "false"
  );
  await page.mouse.move(1, 1);
  await control.scrollIntoViewIfNeeded();
  const before = await control.boundingBox();
  await control.hover();
  const group = control
    .locator(
      "[data-animated-icon] g, [data-animated-icon='chart-line'] > path:last-child"
    )
    .first();
  await expect
    .poll(
      () =>
        group.evaluate((element) => {
          const style = getComputedStyle(element);
          return (
            (style.transform !== "none" &&
              style.transform !== "matrix(1, 0, 0, 1, 0, 0)") ||
            Number(style.opacity) < 1
          );
        }),
      {
        intervals: [10, 20, 30],
        message: (await control.getAttribute("aria-label")) ?? "icon",
      }
    )
    .toBe(true);
  await page.waitForTimeout(550);
  expect(await control.boundingBox()).toEqual(before);
  expect(
    await group.evaluate((element) => getComputedStyle(element).transform)
  ).toMatch(IDENTITY_TRANSFORM_PATTERN);
  expect(
    await group.evaluate((element) => getComputedStyle(element).opacity)
  ).toBe("1");
}

for (const size of [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
]) {
  test(`${size.width}x${size.height} preserves icon, toolbar, navigation and overlay bounds`, async () => {
    await app.evaluate(({ BrowserWindow }, requested) => {
      const main = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes("index.html")
      );
      if (!main) {
        throw new Error("Main window unavailable");
      }
      main.setSize(requested.width, requested.height);
      main.focus();
    }, size);
    for (const theme of ["light", "dark"]) {
      await page.evaluate((next) => {
        localStorage.setItem("theme", next);
        document.documentElement.classList.toggle("dark", next === "dark");
        document.documentElement.classList.toggle("light", next === "light");
      }, theme);
      await expect(page.locator("html")).toHaveClass(
        theme === "dark" ? DARK_THEME_PATTERN : LIGHT_THEME_PATTERN
      );
      await page.evaluate(() => window.__e2eNavigate?.("/"));
      await expect(page.locator("[data-animated-icon='funnel']")).toBeVisible();
      await expectOneShot(
        page
          .locator("button")
          .filter({ has: page.locator("[data-animated-icon='funnel']") })
          .first()
      );
      await page.keyboard.press("Escape");
      const folderShortcut = page
        .locator(".sidebar-rail button")
        .filter({ has: page.locator("[data-animated-icon='folders']") });
      await expectOneShot(folderShortcut);
      await folderShortcut.click();
      await expect(folderShortcut).toHaveAttribute("aria-pressed", "true");
      const folderPopover = page
        .locator('[data-slot="popover-content"]')
        .last();
      await expect(folderPopover).toBeVisible();
      const inBounds = await folderPopover.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.left >= -2 &&
          bounds.top >= -2 &&
          bounds.right <= innerWidth + 2 &&
          bounds.bottom <= innerHeight + 2
        );
      });
      expect(inBounds).toBe(true);
      await page.keyboard.press("Escape");
      await expect(folderShortcut).toHaveAttribute("aria-pressed", "false");
      const dashboard = page
        .locator(".sidebar-rail button")
        .filter({ has: page.locator("[data-animated-icon='chart-line']") });
      await expectOneShot(dashboard);
      const settings = page
        .locator(".sidebar-rail button")
        .filter({ has: page.locator("[data-animated-icon='settings']") });
      await expectOneShot(settings);
      await page.screenshot({
        animations: "disabled",
        path: test.info().outputPath(`home-icons-${size.width}-${theme}.png`),
      });
      await settings.click();
      const plugins = page
        .locator("button")
        .filter({ has: page.locator("[data-animated-icon='connect']") })
        .first();
      await expectOneShot(plugins);
      await expect(plugins.locator("svg > path").first()).toHaveAttribute(
        "d",
        "M19 5l3 -3"
      );
      await plugins.click();
      await expect(plugins).toHaveClass(ACTIVE_NAVIGATION_PATTERN);
      await expectNoOverflow();
      const brain = page
        .locator("button")
        .filter({ has: page.locator("[data-animated-icon='brain']") })
        .first();
      await expect(brain).toBeVisible();
      await expectOneShot(brain);
      await brain.focus();
      await page.keyboard.press("Enter");
      await expect(brain).toHaveClass(ACTIVE_NAVIGATION_PATTERN);
      await expectNoOverflow();
      await page.screenshot({
        animations: "disabled",
        path: test.info().outputPath(`icons-${size.width}-${theme}.png`),
      });
    }
  });
}

test("system reduced motion freezes SVG transforms and focus remains usable", async () => {
  await page.evaluate(() => window.__e2eNavigate?.("/"));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-icon-motion-paused",
    "true"
  );
  const dashboard = page
    .locator(".sidebar-rail button")
    .filter({ has: page.locator("[data-animated-icon='chart-line']") });
  await dashboard.hover();
  await expect(dashboard.locator("svg > path").last()).toHaveAttribute(
    "opacity",
    "1"
  );
  const settings = page
    .locator(".sidebar-rail button")
    .filter({ has: page.locator("[data-animated-icon='settings']") });
  await settings.hover();
  await settings.focus();
  await page.waitForTimeout(100);
  expect(
    await settings
      .locator("g")
      .first()
      .evaluate((element) => getComputedStyle(element).transform)
  ).toMatch(IDENTITY_TRANSFORM_PATTERN);
  await page.keyboard.press("Enter");
  const plugins = page
    .locator("button")
    .filter({ has: page.locator("[data-animated-icon='connect']") })
    .first();
  await plugins.hover();
  await plugins.focus();
  await expect(plugins.locator("svg > path").first()).toHaveAttribute(
    "d",
    "M19 5l3 -3"
  );
  expect(
    await plugins
      .locator("g")
      .first()
      .evaluate((element) => getComputedStyle(element).transform)
  ).toMatch(IDENTITY_TRANSFORM_PATTERN);
  await expectNoOverflow();
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("a scrolling gallery keeps card icons lightweight during batch favorites", async () => {
  await app.evaluate(async ({ app: instance }, root) => {
    const require = process
      .getBuiltinModule("module")
      .createRequire(`${instance.getAppPath()}/package.json`);
    const filesystem = require("node:fs");
    const paths = require("node:path");
    const sharp = require("sharp");
    const photos = paths.join(root, "photos");
    filesystem.mkdirSync(photos, { recursive: true });
    const thumbnails = paths.join(instance.getPath("userData"), "thumbnails");
    filesystem.mkdirSync(thumbnails, { recursive: true });
    const image = await sharp({
      create: {
        width: 96,
        height: 64,
        channels: 3,
        background: { r: 110, g: 90, b: 180 },
      },
    })
      .png()
      .toBuffer();
    const thumbnail = paths.join(thumbnails, "icon-gallery.webp");
    await sharp(image).webp().toFile(thumbnail);
    const Database = require("better-sqlite3");
    const database = new Database(
      paths.join(instance.getPath("userData"), "data/ai-image-manager.db")
    );
    try {
      database
        .prepare(
          "INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(900001,?,'Icon gallery',240,1,0)"
        )
        .run(photos);
      const insert = database.prepare(
        "INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_favorite,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(?,?,?,900001,?,1,96,64,'png',?,0,1,1,1,1)"
      );
      database.transaction(() => {
        for (let index = 0; index < 240; index++) {
          const filename = `icon-${index}.png`;
          const file = paths.join(photos, filename);
          filesystem.writeFileSync(file, image);
          insert.run(900_001 + index, file, filename, image.length, thumbnail);
        }
      })();
    } finally {
      database.close();
    }
  }, runtimeRoot);
  await page.reload();
  await page.evaluate(() => window.__e2eNavigate?.("/"));
  const cards = page.locator("[role='option'][data-photo-id]");
  await expect(cards.first()).toBeVisible();
  const main = page.locator("main").first();
  await main.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.mouse.wheel(0, 1200);
  await page.mouse.wheel(0, -1200);
  const first = cards.first();
  await first.click({ modifiers: ["Control"] });
  await page.keyboard.press("Control+a");
  const favorite = page
    .locator(".selection-action-layer button")
    .filter({ has: page.locator("[data-favorite-icon]") });
  await expect(favorite).toBeVisible();
  await favorite.click();
  await expect
    .poll(async () =>
      page
        .locator("[role='option'] [data-favorite-icon].fill-yellow-400")
        .count()
    )
    .toBeGreaterThan(0);
  expect(
    await page.locator("[role='option'] [data-animated-icon]").count()
  ).toBe(0);
  expect(
    await page.locator("[role='option'] [data-favorite-feedback]").count()
  ).toBe(0);
  await page.keyboard.press("Escape");
  const cardFavorite = cards
    .first()
    .locator("button")
    .filter({ has: page.locator("[data-favorite-icon]") });
  await cards.first().hover();
  await cardFavorite.click();
  await expect(cardFavorite.locator("svg")).toHaveAttribute(
    "data-favorite-feedback",
    ""
  );
  await expectNoOverflow();
});
