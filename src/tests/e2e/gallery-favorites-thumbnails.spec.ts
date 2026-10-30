import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electronPath = createRequire(import.meta.url)("electron") as string;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const EXPAND_SIDEBAR = /^(Expand sidebar|展开侧边栏)$/;
const ALL_PHOTOS = /^(All Photos|全部照片)$/;
const FAVORITES = /^(Favorite|收藏)$/;
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;
const errors: string[] = [];
const thumbnailRequests: Record<string, string | number | null>[] = [];

function thumbnailRequest(url: string) {
  const parsed = new URL(url);
  if (parsed.pathname !== "/photo-thumbnail") {
    return null;
  }
  return {
    id: parsed.searchParams.get("id"),
    edge: parsed.searchParams.get("edge"),
    repair: parsed.searchParams.get("repair"),
    time: Date.now(),
  };
}

async function launch() {
  app = await launchTestApp(root, {
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "-r",
      path.join(root, "isolation.cjs"),
      "--e2e",
      process.env.AIM_E2E_APP_PATH ?? path.resolve("."),
    ],
    env,
  });
  app.process().stderr?.on("data", (data) => {
    fs.appendFileSync(path.join(root, "electron.log"), data);
  });
  page = await waitForHomeWindow(app);
  await page.waitForLoadState("load");
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const thumbnail = thumbnailRequest(request.url());
    if (thumbnail) {
      thumbnailRequests.push({ ...thumbnail, event: "request" });
    }
  });
  page.on("response", (response) => {
    const thumbnail = thumbnailRequest(response.url());
    if (thumbnail) {
      thumbnailRequests.push({ ...thumbnail, status: response.status() });
    }
  });
  page.on("requestfailed", (request) => {
    const thumbnail = thumbnailRequest(request.url());
    if (thumbnail) {
      thumbnailRequests.push({
        ...thumbnail,
        error: request.failure()?.errorText ?? "unknown",
      });
    }
  });
}

async function assertFavoritesLoaded() {
  const cards = page.locator('main [data-photo-id][role="option"]');
  await expect(cards).toHaveCount(2);
  for (const id of [1, 2]) {
    const card = page.locator(`main [data-photo-id="${id}"][role="option"]`);
    await expect(card).toBeVisible();
    await expect(card.locator('img[data-load-state="loaded"]')).toBeVisible();
    await expect
      .poll(() =>
        card.locator("img").evaluate((image: HTMLImageElement) => ({
          complete: image.complete && image.naturalWidth > 0,
          opacity: getComputedStyle(image).opacity,
        }))
      )
      .toEqual({ complete: true, opacity: "1" });
  }
}

async function selectSidebar(name: RegExp) {
  const sidebar = page.locator('[data-surface="sidebar-resources"]');
  if (!(await sidebar.isVisible())) {
    await page.getByRole("button", { name: EXPAND_SIDEBAR }).click();
  }
  await sidebar.getByRole("button", { name, exact: true }).click();
}

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async () => {
  root = createTestRuntime("gallery-favorites-thumbnails");
  profile = path.join(root, "profile");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  fs.writeFileSync(
    path.join(root, "isolation.cjs"),
    `const {app}=require('electron');app.setAppPath(${JSON.stringify(path.resolve("."))});const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
  );
  env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
      TEMP: scratch,
      TMP: scratch,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  await launch();
  await app.close();

  const fixture = path.join(root, "fixture");
  fs.mkdirSync(fixture);
  const sqlEscape = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${sqlEscape(fixture)}','FavoriteFixture',8,1)`,
  ];
  for (let id = 1; id <= 8; id++) {
    const width = id === 2 ? 360 : 440;
    const height = id === 2 ? 440 : 360;
    const filename = `FavoriteFixture-${id}.png`;
    const photoPath = path.join(fixture, filename);
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 40 + id * 20, g: 100, b: 180 },
      },
    })
      .png()
      .toFile(photoPath);
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,dominant_colors,is_favorite,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${sqlEscape(photoPath)}','${filename}',1,${fs.statSync(photoPath).size},${id},${width},${height},'png','${sqlEscape(photoPath)}','["#806040"]',${Number(id <= 2)},1,1,1,1)`
    );
  }
  execFileSync(
    electronPath,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.exec(require('node:fs').readFileSync(0,'utf8'))}finally{d.close()}",
      path.join(profile, "data", "ai-image-manager.db"),
    ],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      input: statements.join(";"),
      encoding: "utf8",
    }
  );
  await launch();
});

test.afterAll(async () => {
  await app?.close();
});

test.afterEach(async () => {
  if (test.info().status !== "passed") {
    const diagnostic = test.info().outputPath("thumbnail-requests.json");
    fs.writeFileSync(diagnostic, JSON.stringify(thumbnailRequests, null, 2));
    await test.info().attach("thumbnail-requests", {
      path: diagnostic,
      contentType: "application/json",
    });
  }
});

for (const size of SIZES) {
  test(`${size.width}x${size.height} reveals Favorites after interrupted loads, cache hits and rapid switches`, async () => {
    await app.evaluate(async ({ BrowserWindow, session }, requested) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(requested.width, requested.height);
      window.webContents.setZoomFactor(1);
      await session.defaultSession.clearCache();
    }, size);
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
      localStorage.setItem("lang", "en");
      localStorage.setItem("sidebar_collapsed", "false");
      localStorage.setItem("grid_column_width", "220");
      localStorage.setItem("grid_sort_field", "name");
      localStorage.setItem("grid_sort_order", "asc");
      localStorage.setItem("ui.reduceMotion", "false");
    });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const heldIds = new Set<string>();
    await page.route("**/photo-thumbnail?**", async (route) => {
      const id = new URL(route.request().url()).searchParams.get("id");
      if (id === "1" || id === "2") {
        heldIds.add(id);
        await gate;
      }
      // Electron can cancel CDP-continued image requests before HTTP dispatch.
      // Fulfill the gated request with the real host response instead.
      await route.fulfill({ response: await route.fetch() });
    });
    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.__e2eNavigate));
      await expect.poll(() => heldIds.size).toBe(2);
      await selectSidebar(FAVORITES);
      await expect(
        page.locator('main [data-photo-id][role="option"]')
      ).toHaveCount(2);
      release();
      // Preload completion creates a second DOM image request. Keep the handler
      // installed through that handoff before restoring native cache behavior.
      await assertFavoritesLoaded();
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
    }

    // With routing removed Chromium's native cache is active for this visit.
    await selectSidebar(ALL_PHOTOS);
    await expect(
      page.locator('main [data-photo-id="1"] img[data-load-state="loaded"]')
    ).toBeVisible();
    await selectSidebar(FAVORITES);
    await assertFavoritesLoaded();
    for (let index = 0; index < 3; index++) {
      await selectSidebar(ALL_PHOTOS);
      await selectSidebar(FAVORITES);
    }
    await assertFavoritesLoaded();

    const overflow = await page.evaluate(() =>
      [
        document.documentElement,
        document.body,
        ...document.querySelectorAll("main"),
      ].some((element) => element.scrollWidth > element.clientWidth + 2)
    );
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
    await page.screenshot({ path: test.info().outputPath("favorites.png") });
  });
}
