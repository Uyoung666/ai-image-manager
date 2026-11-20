import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
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

async function expectInsideViewport(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const { bottom, left, right, top } = element.getBoundingClientRect();
        return (
          left >= -1 &&
          top >= -1 &&
          right <= innerWidth + 1 &&
          bottom <= innerHeight + 1
        );
      })
    )
    .toBe(true);
}

const THUMBNAIL_TOGGLE = /^(Show\/hide thumbnails|显示\/隐藏缩略图) \(T\)$/;
const LIGHTBOX = /^(Photo review lightbox|照片审阅灯箱)$/;
const ZOOM = /^(Zoom|缩放) · /;
const ZOOM_IN = /^(Zoom in|放大)$/;
const ZOOM_OUT = /^(Zoom out|缩小)$/;
const LOCK_ZOOM = /lock zoom|锁定倍率/i;
const PREVIOUS_PHOTO = /^(Previous photo|上一张)/;
const NEXT_PHOTO = /^(Next photo|下一张)/;
const PERCENTAGE = /%$/;
const MORE = /^(More|更多)$/;
const ROTATE_LEFT = /^(Rotate Left|向左旋转)$/;
const ROTATE_RIGHT = /^(Rotate Right|向右旋转)$/;
const CLOSE = /^(Close|关闭)$/;
const FULLSCREEN = /^(Fullscreen|全屏)$/;
const PLAY = /^(Play slideshow|播放幻灯片)$/;
const PAUSE = /^(Pause slideshow|暂停幻灯片)$/;
const EXIT_SLIDESHOW = /^(Exit slideshow|退出幻灯片)$/;
const LIGHTBOX_SIZES: { width: number; height: number; zoomFactor?: number }[] =
  [
    ...SIZES,
    { width: 720, height: 480, zoomFactor: 1.25 },
    { width: 720, height: 480, zoomFactor: 1.5 },
  ];

async function openLightbox(size: (typeof LIGHTBOX_SIZES)[number]) {
  await app.evaluate(({ BrowserWindow }, requested) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setContentSize(requested.width, requested.height);
    window.webContents.setZoomFactor(requested.zoomFactor ?? 1);
  }, size);
  await page.evaluate(() => localStorage.removeItem("lightbox.panel-mode"));
  await page.locator('main [data-photo-id="2"][role="option"]').dblclick();
  const lightbox = page.getByRole("dialog", {
    name: LIGHTBOX,
  });
  await expectInsideViewport(lightbox);
  return lightbox;
}

for (const size of LIGHTBOX_SIZES) {
  const scale = size.zoomFactor ? ` at ${size.zoomFactor * 100}%` : "";
  const dimensions = `${size.width}x${size.height}${scale}`;
  test(`${dimensions} keeps lightbox controls in the draggable header and the filmstrip separate`, async () => {
    const lightbox = await openLightbox(size);
    const header = lightbox.locator("[data-lightbox-window-drag]");
    const canvas = lightbox.locator("[data-lightbox-canvas]");
    const image = canvas.locator('img[data-browse-visible="true"]');
    const strip = lightbox.locator("[data-lightbox-thumbnail-strip]");
    const more = header.getByRole("button", { name: MORE });
    const popovers = lightbox.locator('[data-slot="popover-content"]');
    const tooltips = lightbox.locator('[data-slot="tooltip-content"]');
    const zoom = header.getByRole("button", { name: ZOOM });

    await expectInsideViewport(header);
    await expect(header).toHaveCSS("-webkit-app-region", "drag");
    await expect(more).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(zoom).toHaveCSS("-webkit-app-region", "no-drag");
    await expect(header.getByText("FavoriteFixture-2.png")).toHaveCSS(
      "-webkit-app-region",
      "no-drag"
    );
    await expect(canvas).toHaveCSS("-webkit-app-region", "no-drag");

    await expect(
      lightbox.locator("[data-lightbox-playback-toolbar]")
    ).toHaveCount(0);
    await zoom.click();
    await expectInsideViewport(popovers);
    await expect(popovers).toBeFocused();
    const zoomOutHint = tooltips.filter({
      has: page.getByRole("tooltip", { name: ZOOM_OUT }),
    });
    await expect(tooltips).toHaveCount(0);
    await page.keyboard.press("Tab");
    await expect(
      popovers.getByRole("button", { name: ZOOM_OUT })
    ).toBeFocused();
    await expectInsideViewport(zoomOutHint);

    const lock = popovers.getByRole("checkbox", { name: LOCK_ZOOM });
    expect(
      await lock.evaluate(
        (element) => element.closest('[data-slot="tooltip-trigger"]') !== null
      )
    ).toBe(false);
    await popovers.locator(".custom-switch").click();
    await expect(lock).toBeChecked();
    await popovers.getByRole("button", { name: ZOOM_IN }).click();
    await expect(zoom).toHaveText(PERCENTAGE);
    await page.keyboard.press("Escape");
    await expect(popovers).toBeHidden();
    await page.keyboard.press("0");

    for (const [name, side] of [
      [PREVIOUS_PHOTO, "right"],
      [NEXT_PHOTO, "left"],
    ] as const) {
      const arrow = lightbox.getByRole("button", { name });
      await arrow.hover();
      const hint = tooltips.filter({
        has: page.getByRole("tooltip", { name }),
      });
      await expectInsideViewport(hint);
      await expect(hint).toHaveAttribute("data-side", side);
    }

    const toggle = header.getByRole("button", { name: THUMBNAIL_TOGGLE });
    await toggle.click();
    await expectInsideViewport(strip);
    await expectInsideViewport(image);
    const [canvasBounds, stripBounds] = await Promise.all([
      canvas.boundingBox(),
      strip.boundingBox(),
    ]);
    expect(
      canvasBounds &&
        stripBounds &&
        canvasBounds.y + canvasBounds.height <= stripBounds.y
    ).toBe(true);

    const expectPhotoInsideCanvas = async () => {
      await expect(image).toBeVisible();
      await expect
        .poll(async () => {
          const [frame, area] = await Promise.all([
            image.boundingBox(),
            canvas.boundingBox(),
          ]);
          return Boolean(
            frame &&
              area &&
              frame.x >= area.x - 1 &&
              frame.x + frame.width <= area.x + area.width + 1 &&
              frame.y >= area.y - 1 &&
              frame.y + frame.height <= area.y + area.height + 1
          );
        })
        .toBe(true);
    };
    await expectPhotoInsideCanvas();
    await more.click();
    await expectInsideViewport(popovers);
    await expect(
      popovers.getByRole("button", { name: ROTATE_LEFT })
    ).toHaveCount(0);
    await expect(
      popovers.getByRole("button", { name: ROTATE_RIGHT })
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(popovers).toBeHidden();
    const rotateLeft = header.getByRole("button", { name: ROTATE_LEFT });
    await expectInsideViewport(rotateLeft);
    await expectInsideViewport(
      header.getByRole("button", { name: ROTATE_RIGHT })
    );
    await rotateLeft.click();
    await expect
      .poll(() =>
        image.evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).b
        )
      )
      .toBeCloseTo(-1, 5);
    await expectPhotoInsideCanvas();

    await page.keyboard.press("t");
    await expect(strip).toBeHidden();
    await expectPhotoInsideCanvas();

    expect(
      await page.evaluate(() =>
        [
          document.documentElement,
          document.body,
          ...document.querySelectorAll("main"),
        ].some((element) => element.scrollWidth > element.clientWidth + 2)
      )
    ).toBe(false);
    await header.getByRole("button", { name: CLOSE }).click();
    await expect(lightbox).toBeHidden();
  });
}

test("fullscreen lightbox reveals controls at the edge or on focus and keeps paused playback usable", async () => {
  const lightbox = await openLightbox({ width: 900, height: 600 });
  const header = lightbox.locator("header");
  const canvas = lightbox.locator("[data-lightbox-canvas]");
  const strip = lightbox.locator("[data-lightbox-thumbnail-strip]");
  await header.getByRole("button", { name: THUMBNAIL_TOGGLE }).click();
  await header.getByRole("button", { name: FULLSCREEN }).click();
  await expect(header).not.toHaveAttribute("data-lightbox-window-drag");
  await expect(header).toHaveCSS("opacity", "0");
  const imageArea = await canvas.boundingBox();
  await page.mouse.move(300, 160);
  await expect(header).toHaveCSS("opacity", "0");
  await expect(strip).toBeVisible();

  await page.mouse.move(300, 10);
  await expect(header).toHaveCSS("opacity", "1");
  await page.waitForTimeout(3200);
  await expect(header).toHaveCSS("opacity", "1");
  expect(await canvas.boundingBox()).toEqual(imageArea);
  await page.mouse.move(300, 160);
  await expect(header).toHaveCSS("opacity", "0");
  await page.keyboard.press("Tab");
  await expect(header).toHaveCSS("opacity", "1");

  const zoom = header.getByRole("button", { name: ZOOM });
  await zoom.focus();
  await page.keyboard.press("Space");
  const popovers = lightbox.locator('[data-slot="popover-content"]');
  await expectInsideViewport(popovers);
  await expect(popovers).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(popovers).toBeHidden();
  await expect(zoom).toBeFocused();

  await header.getByRole("button", { name: MORE }).click();
  await popovers.getByRole("button", { name: PLAY }).click();
  const playback = lightbox.locator("[data-lightbox-playback-toolbar]");
  await expectInsideViewport(playback);
  await expect(playback.getByRole("button", { name: PAUSE })).toBeVisible();
  await playback.getByRole("button", { name: "5s" }).click();
  await page.keyboard.press("Space");
  await expect(playback.getByRole("button", { name: PLAY })).toBeVisible();
  await page.mouse.move(300, 160);
  await expect(header).toHaveCSS("opacity", "0");
  await expect(playback).toHaveCSS("opacity", "1");
  await expect(playback.getByRole("button", { name: "5s" })).toBeVisible();
  await playback.getByRole("button", { name: EXIT_SLIDESHOW }).click();
  await expect(playback).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(header).toHaveAttribute("data-lightbox-window-drag", "true");
  await header.getByRole("button", { name: CLOSE }).click();
  await expect(lightbox).toBeHidden();
});
