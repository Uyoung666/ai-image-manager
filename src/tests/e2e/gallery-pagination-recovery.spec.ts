import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electronPath = createRequire(import.meta.url)("electron") as string;
const PHOTO_COUNT = 620;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const COLUMN_WIDTHS = [140, 220, 320];
const EDIT_TAGS = /^Edit tags for 2 photos$/;
const RENDERER_URL = /^(?:http|file):/;
const TAG_MATCH = /Tag match/;

declare global {
  interface Window {
    continuityProbe: {
      stop: () => {
        missingFrames: number;
        overlayFrames: number;
        retained: boolean;
        offsetChange: number;
      };
    };
    continuitySearchRequests: Array<{ cursor: string | null }>;
    paginationRecoveryRequests: Array<{ cursor: string | null }>;
  }
}

let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;
let errors: string[] = [];

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
  await expect
    .poll(
      () =>
        app
          .windows()
          .find((candidate) => RENDERER_URL.test(candidate.url()))
          ?.url(),
      { timeout: 45_000 }
    )
    .toBeTruthy();
  page = app
    .windows()
    .find((candidate) => RENDERER_URL.test(candidate.url())) as Page;
  // Let the host's initial loadURL settle before the language reload. Aborting
  // that startup navigation creates a persistent diagnostic notification.
  await page.waitForLoadState("load");
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("ui.reduceMotion", "true");
    window.paginationRecoveryRequests = [];
    window.continuitySearchRequests = [];
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, transfer) {
      const request =
        typeof message === "string" ? JSON.parse(message) : message;
      if (request?.p?.u?.includes("listPhotoPage")) {
        window.paginationRecoveryRequests.push({
          cursor: request?.p?.b?.json?.cursor ?? null,
        });
      }
      if (request?.p?.u?.includes("searchCompound")) {
        window.continuitySearchRequests.push({
          cursor: request?.p?.b?.json?.cursor ?? null,
        });
      }
      if (Array.isArray(transfer)) {
        send.call(this, message, { transfer });
      } else {
        send.call(this, message, transfer ?? {});
      }
    };
  });
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("console", (message) => {
    if (message.text().includes("Maximum update depth")) {
      errors.push(message.text());
    }
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await page.locator("main").first().waitFor();
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  root = createTestRuntime("gallery-pagination-recovery");
  profile = path.join(root, "profile");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
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
  const escapeSql = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${escapeSql(fixture)}','PaginationFixture',${PHOTO_COUNT},1)`,
  ];
  for (let id = 1; id <= PHOTO_COUNT; id++) {
    const filename = `PaginationFixture-${String(id).padStart(3, "0")}.png`;
    const photoPath = path.join(fixture, filename);
    const [width, height] = [
      [256, 168],
      [168, 256],
      [224, 224],
      [288, 144],
      [168, 280],
    ][(id - 1) % 5];
    await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: id % 256, g: Math.floor(id / 256) * 80, b: 150 },
      },
    })
      .png()
      .toFile(photoPath);
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,dominant_colors,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${escapeSql(photoPath)}','${filename}',1,1024,${id},${width},${height},'png','${escapeSql(photoPath)}','[{"hex":"#336699","weight":1}]',1,1,1,1)`
    );
  }
  for (let index = 0; index < SIZES.length * COLUMN_WIDTHS.length; index++) {
    statements.push(
      `INSERT INTO tags(id,name,created_at) VALUES(${9300 + index},'PaginationTag-${index}',1)`
    );
  }
  for (let index = 0; index < SIZES.length * 3; index++) {
    statements.push(
      `INSERT INTO tags(id,name,created_at) VALUES(${9900 + index},'ContinuityTag${index}',1)`
    );
    statements.push(
      `INSERT INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) SELECT id,${9900 + index},1,'manual',1 FROM photos`
    );
  }
  statements.push(
    "INSERT INTO tags(id,name,created_at) VALUES(9991,'ContinuityExtraA',1),(9992,'ContinuityExtraB',1)"
  );
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

function fixtureSql(sql: string) {
  execFileSync(
    electronPath,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.exec(require('node:fs').readFileSync(0,'utf8'))}finally{d.close()}",
      path.join(profile, "data", "ai-image-manager.db"),
    ],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, input: sql, encoding: "utf8" }
  );
}

for (const [sizeIndex, size] of SIZES.entries()) {
  for (const [modeIndex, mode] of ["search", "tag", "browse"].entries()) {
    const index = sizeIndex * 3 + modeIndex;
    const tag = `ContinuityTag${index}`;
    test(`${size.width}x${size.height} ${mode} keeps the gallery and inspector through consecutive tag removals`, async () => {
      // Reset the host's mutable search sessions as well as renderer storage.
      // Fixture writes between cases must not invalidate a previous session.
      await app.close();
      errors = [];
      fixtureSql(
        "INSERT OR IGNORE INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) SELECT id,9991,1,'manual',1 FROM photos; INSERT OR IGNORE INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) SELECT id,9992,1,'manual',1 FROM photos"
      );
      await launch();
      await app.evaluate(({ BrowserWindow }, requested) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(requested.width, requested.height);
        window.webContents.setZoomFactor(1);
      }, size);
      await page.evaluate(() => {
        sessionStorage.clear();
        localStorage.clear();
        localStorage.setItem("lang", "en");
        localStorage.setItem("sidebar_collapsed", "true");
        localStorage.setItem("grid_column_width", "140");
        localStorage.setItem("grid_sort_field", "name");
        localStorage.setItem("grid_sort_order", "asc");
        localStorage.setItem("ui.reduceMotion", "true");
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.__e2eNavigate));
      if (mode === "search") {
        const input = page.locator("input.home-search-input");
        await input.fill(tag);
        await input.press("Enter");
        if (
          await page
            .locator('[data-overlay-kind="search-suggestions"]')
            .isVisible()
        ) {
          await input.press("Escape");
        }
      } else if (mode === "tag") {
        await page
          .getByRole("button", { name: "Expand sidebar", exact: true })
          .click();
        await page.getByRole("button", { name: "Tags", exact: true }).click();
        await page.locator(`[data-tag-id="${9900 + index}"]`).click();
        await page.keyboard.press("Escape");
      }
      const gallery = page.locator("[data-masonry-scroll]");
      await expect(gallery).toBeVisible();
      if (mode !== "browse") {
        await expect(
          gallery.getByRole("option", { name: TAG_MATCH }).first()
        ).toBeVisible();
      }
      const requestCount = () =>
        page.evaluate(
          (search) =>
            search
              ? window.continuitySearchRequests.length
              : window.paginationRecoveryRequests.length,
          mode === "search"
        );
      await expect
        .poll(
          async () => {
            if ((await requestCount()) >= 3) {
              return true;
            }
            await gallery.hover();
            await page.mouse.wheel(0, 10_000);
            await gallery.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            return false;
          },
          { timeout: 30_000, intervals: [100, 200, 300] }
        )
        .toBe(true);
      await gallery.evaluate((element) => {
        element.scrollTop = Math.min(
          4200,
          element.scrollHeight - element.clientHeight - 300
        );
      });
      const selectedId = await gallery.evaluate((element) => {
        const viewport = element.getBoundingClientRect();
        const candidates = [
          ...element.querySelectorAll<HTMLElement>(
            '[data-photo-id][role="option"]'
          ),
        ].filter((card) => {
          const r = card.getBoundingClientRect();
          return r.top > viewport.top + 100 && r.bottom < viewport.bottom - 10;
        });
        return Number(candidates.at(-1)?.dataset.photoId);
      });
      expect(selectedId).toBeGreaterThan(0);
      await page
        .locator(`[data-photo-id="${selectedId}"][role="option"]`)
        .click();
      const inspector = page.locator('aside[data-surface="inspector"]');
      await expect(inspector).toBeVisible();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            let frames = 0;
            const settle = () => {
              if (++frames >= 20) {
                resolve();
              } else {
                requestAnimationFrame(settle);
              }
            };
            requestAnimationFrame(settle);
          })
      );
      await page.evaluate((selected) => {
        const gallery = document.querySelector<HTMLElement>(
          "[data-masonry-scroll]"
        );
        if (!gallery) {
          throw new Error("Missing gallery");
        }
        const viewport = gallery.getBoundingClientRect();
        const anchor = [
          ...gallery.querySelectorAll<HTMLElement>(
            '[data-photo-id][role="option"]'
          ),
        ].find((card) => {
          const r = card.getBoundingClientRect();
          return (
            Number(card.dataset.photoId) !== selected &&
            r.top >= viewport.top + 60 &&
            r.top < viewport.bottom - 30
          );
        });
        if (!anchor) {
          throw new Error("Missing surviving anchor");
        }
        const image = anchor.querySelector("img");
        const offset = anchor.getBoundingClientRect().top;
        let missingFrames = 0;
        let overlayFrames = 0;
        let frame = 0;
        const sample = () => {
          if (!gallery.isConnected) {
            missingFrames++;
          }
          if (
            document.querySelector(
              ".home-gallery-restore-content.is-restoring, .home-gallery-restore-overlay:not(.is-exiting)"
            )
          ) {
            overlayFrames++;
          }
          frame = requestAnimationFrame(sample);
        };
        frame = requestAnimationFrame(sample);
        window.continuityProbe = {
          stop: () => {
            cancelAnimationFrame(frame);
            return {
              missingFrames,
              overlayFrames,
              retained:
                anchor.isConnected && anchor.querySelector("img") === image,
              offsetChange: Math.abs(
                anchor.getBoundingClientRect().top - offset
              ),
            };
          },
        };
      }, selectedId);
      const before = await requestCount();
      for (const name of ["ContinuityExtraA", tag, "ContinuityExtraB"]) {
        const remove = inspector
          .getByRole("button", { name: "Click to remove", exact: true })
          .filter({ hasText: name });
        await remove.click();
        await expect(remove).toHaveCount(0);
        await expect(inspector).toBeVisible();
      }
      if (mode === "tag") {
        await expect(page.locator(".home-gallery-toolbar-layer")).toContainText(
          "619"
        );
      }
      if (mode !== "browse") {
        await expect(
          gallery.locator(`[data-photo-id="${selectedId}"]`)
        ).toHaveCount(0);
        await expect.poll(requestCount).toBeGreaterThan(before);
      }
      await expect(inspector).toContainText(
        `PaginationFixture-${String(selectedId).padStart(3, "0")}.png`
      );
      const continuity = await page.evaluate(() =>
        window.continuityProbe.stop()
      );
      expect(continuity.missingFrames).toBe(0);
      expect(continuity.overlayFrames).toBe(0);
      expect(continuity.retained).toBe(true);
      expect(continuity.offsetChange).toBeLessThanOrEqual(2);
      if (mode === "browse") {
        expect(await requestCount()).toBe(before);
      }
      await assertBounds();
      await page.screenshot({
        path: test.info().outputPath("tag-edit-continuity.png"),
      });
      await page.keyboard.press("Escape");
      await expect(inspector).toHaveCount(0);
      await assertBounds();
      fs.writeFileSync(
        test.info().outputPath("continuity.json"),
        JSON.stringify({ mode, size, selectedId, ...continuity }, null, 2)
      );
      expect(errors).toEqual([]);
    });
  }
}

test.afterAll(async () => {
  await app?.close();
});

test.afterEach(async () => {
  fs.writeFileSync(
    test.info().outputPath("pagination-errors.json"),
    JSON.stringify(errors, null, 2)
  );
  if (!page.isClosed()) {
    const requests = await page.evaluate(
      () => window.paginationRecoveryRequests
    );
    fs.writeFileSync(
      test.info().outputPath("pagination-requests.json"),
      JSON.stringify(requests, null, 2)
    );
    fs.writeFileSync(
      test.info().outputPath("search-requests.json"),
      JSON.stringify(
        await page.evaluate(() => window.continuitySearchRequests),
        null,
        2
      )
    );
  }
});

async function assertBounds() {
  const bounds = await page.evaluate(() => {
    const overflow = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll("main"),
    ].some((element) => element.scrollWidth > element.clientWidth + 2);
    const escaped = [
      ...document.querySelectorAll('[role="dialog"], [role="menu"]'),
    ]
      .filter((element) => element.getClientRects().length > 0)
      .some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > innerWidth + 1 ||
          rect.bottom > innerHeight + 1
        );
      });
    return { overflow, escaped };
  });
  expect(bounds).toEqual({ overflow: false, escaped: false });
}

for (const [sizeIndex, size] of SIZES.entries()) {
  for (const [widthIndex, columnWidth] of COLUMN_WIDTHS.entries()) {
    const tag = `PaginationTag-${sizeIndex * COLUMN_WIDTHS.length + widthIndex}`;
    test(`${size.width}x${size.height} column ${columnWidth} paginates to the last photo after batch tags without a reload`, async () => {
      errors = [];
      await app.evaluate(
        ({ BrowserWindow }, requested) => {
          const window = BrowserWindow.getAllWindows()[0];
          window.setSize(requested.width, requested.height);
          window.webContents.setZoomFactor(requested.zoom);
        },
        { ...size, zoom: Number(process.env.AIM_E2E_UI_ZOOM ?? "1") }
      );
      await page.evaluate((width) => {
        sessionStorage.clear();
        localStorage.clear();
        localStorage.setItem("lang", "en");
        localStorage.setItem("sidebar_collapsed", "true");
        localStorage.setItem("grid_sort_field", "name");
        localStorage.setItem("grid_sort_order", "asc");
        localStorage.setItem("grid_column_width", String(width));
      }, columnWidth);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.__e2eNavigate));
      const first = page.locator('[data-photo-id="1"][role="option"]');
      await expect(first).toBeVisible();
      await expect(page.locator(".home-gallery-toolbar-layer")).toContainText(
        "620"
      );
      await first.click({ modifiers: ["Control"] });
      await page
        .locator('[data-photo-id="2"][role="option"]')
        .click({ modifiers: ["Control"] });
      await expect(page.locator(".selection-menu-count")).toContainText("2 /");
      await expect(page.locator(".home-detail-panel-container")).toHaveCount(0);
      await page
        .locator(".selection-menu")
        .getByRole("button", { name: "Edit tags", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: EDIT_TAGS });
      await dialog
        .getByRole("textbox", { name: "Search existing tags" })
        .fill(tag);
      await dialog.getByRole("checkbox", { name: tag, exact: true }).check();
      await assertBounds();
      const requestsBeforeApply = await page.evaluate(
        () => window.paginationRecoveryRequests.length
      );
      await dialog
        .getByRole("button", { name: "Apply tag changes", exact: true })
        .click();
      await expect(dialog).toBeHidden();
      await expect(
        page.getByText("Applied 2 tag changes", { exact: true })
      ).toBeVisible();
      expect(
        await page.evaluate(() => window.paginationRecoveryRequests.length)
      ).toBe(requestsBeforeApply);
      await page.keyboard.press("Escape");

      const gallery = page.locator("[data-masonry-scroll]");
      const last = page.locator(
        `[data-photo-id="${PHOTO_COUNT}"][role="option"]`
      );
      // Tag edits leave ordinary pagination valid, including with the pointer still.
      await expect
        .poll(
          async () => {
            if (await last.count()) {
              return true;
            }
            const requestCount = await page.evaluate(
              () => window.paginationRecoveryRequests.length
            );
            expect(requestCount).toBeLessThanOrEqual(14);
            await gallery.evaluate((element) => {
              element.scrollTop = element.scrollHeight;
            });
            return false;
          },
          { timeout: 60_000, intervals: [100, 150, 250] }
        )
        .toBe(true);
      await last.scrollIntoViewIfNeeded();
      await expect(last).toBeVisible();
      await expect(gallery.locator(".animate-shimmer")).toHaveCount(0);
      await expect
        .poll(() =>
          last.locator("img").evaluateAll((images) =>
            images.some((image) => {
              const node = image as HTMLImageElement;
              return node.complete && node.naturalWidth > 0;
            })
          )
        )
        .toBe(true);
      const requests = await page.evaluate(
        () => window.paginationRecoveryRequests
      );
      const requestCount = requests.length;
      expect(requests.filter(({ cursor }) => cursor === null)).toHaveLength(1);
      expect(requestCount).toBeGreaterThanOrEqual(7);
      expect(requestCount).toBeLessThanOrEqual(14);
      const cursors = requests
        .map(({ cursor }) => cursor)
        .filter((cursor): cursor is string => cursor !== null);
      expect(cursors.length).toBeGreaterThanOrEqual(6);
      // Tag edits must neither expire nor repeat any loaded cursor.
      expect(new Set(cursors).size).toBe(cursors.length);
      await last.click();
      await expect(page.locator(".selection-menu-count")).toHaveText(
        "1 / 620 selected"
      );
      await page.keyboard.press("Space");
      const preview = page.getByRole("dialog", {
        name: "Quick preview",
        exact: true,
      });
      await expect(preview).toBeVisible();
      await expect(preview).toContainText("PaginationFixture-620.png");
      await expect(preview.getByRole("img")).toHaveCSS("opacity", "1");
      await assertBounds();
      await page.keyboard.press("Escape");
      await expect(preview).toBeHidden();
      await assertBounds();
      const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
        const image = await BrowserWindow.getAllWindows()[0].capturePage();
        return image.toPNG().toString("base64");
      });
      fs.writeFileSync(
        test.info().outputPath("pagination-last-photo.png"),
        Buffer.from(screenshot, "base64")
      );
      expect(errors).toEqual([]);
    });
  }
}

test("keeps the final mismatching photo open for further tag edits", async () => {
  fixtureSql(
    "INSERT INTO tags(id,name,created_at) VALUES(10001,'ContinuityLastMatch',1); INSERT INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) VALUES(21,10001,1,'manual',1); INSERT OR IGNORE INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) VALUES(21,9991,1,'manual',1)"
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
  );
  await page.evaluate(() => sessionStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  const search = page.locator("input.home-search-input");
  await search.fill("ContinuityLastMatch");
  await search.press("Enter");
  if (
    await page.locator('[data-overlay-kind="search-suggestions"]').isVisible()
  ) {
    await search.press("Escape");
  }
  await page.locator('[data-photo-id="21"][role="option"]').click();
  const inspector = page.locator('aside[data-surface="inspector"]');
  await inspector
    .getByRole("button", { name: "Click to remove", exact: true })
    .filter({ hasText: "ContinuityLastMatch" })
    .click();
  await expect(page.locator('[data-photo-id][role="option"]')).toHaveCount(0);
  await expect(inspector).toBeVisible();
  const extra = inspector
    .getByRole("button", { name: "Click to remove", exact: true })
    .filter({ hasText: "ContinuityExtraA" });
  await extra.click();
  await expect(extra).toHaveCount(0);
  await expect(inspector).toBeVisible();
  await assertBounds();
  await page.keyboard.press("Escape");
  await expect(inspector).toHaveCount(0);
});

test("can leave during the tag-refresh debounce and return to an updated scope", async () => {
  await app.close();
  fixtureSql(
    "INSERT INTO tags(id,name,created_at) VALUES(10002,'ContinuityScope',1); INSERT INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) VALUES(21,10002,1,'manual',1),(22,10002,1,'manual',1)"
  );
  await launch();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setContentSize(1280, 800)
  );
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
    localStorage.setItem("lang", "en");
    localStorage.setItem("sidebar_collapsed", "false");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  const scope = page.locator('[data-tag-id="10002"]');
  await scope.click();
  const cards = page.locator('[data-photo-id][role="option"]');
  await expect(cards).toHaveCount(2);
  await page.locator('[data-photo-id="21"][role="option"]').click();
  await page
    .getByRole("button", { name: "All Photos", exact: true })
    .first()
    .evaluate((button) => {
      window.addEventListener(
        "tags-changed",
        () => (button as HTMLButtonElement).click(),
        { once: true }
      );
    });
  await page
    .locator('aside[data-surface="inspector"]')
    .getByRole("button", { name: "Click to remove", exact: true })
    .filter({ hasText: "ContinuityScope" })
    .click();
  await expect(page.locator('aside[data-surface="inspector"]')).toHaveCount(0);
  await expect(page.locator(".home-gallery-toolbar-layer")).toContainText(
    "620"
  );
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  await scope.click();
  await expect(cards).toHaveCount(1);
  await expect(
    page.locator('[data-photo-id="22"][role="option"]')
  ).toBeVisible();
  await expect(page.locator(".home-gallery-restore-overlay")).toHaveCount(0);
  await assertBounds();
});

test("recovers an actually expired cursor after a sort field changes", async () => {
  errors = [];
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.setItem("grid_sort_field", "date");
    localStorage.setItem("grid_sort_order", "asc");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const gallery = page.locator("[data-masonry-scroll]");
  await expect(gallery).toBeVisible();
  fixtureSql("UPDATE photos SET file_date=10000 WHERE id=620");
  try {
    await gallery.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.paginationRecoveryRequests.filter(
              ({ cursor }) => cursor === null
            ).length
        )
      )
      .toBeGreaterThan(1);
    await expect
      .poll(
        async () => {
          if (
            await page.locator('[data-photo-id="620"][role="option"]').count()
          ) {
            return true;
          }
          await gallery.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          return false;
        },
        { timeout: 30_000, intervals: [100, 200, 300] }
      )
      .toBe(true);
    const cursors = await page.evaluate(() =>
      window.paginationRecoveryRequests
        .map(({ cursor }) => cursor)
        .filter(Boolean)
    );
    expect(new Set(cursors).size).toBe(cursors.length);
    expect(errors).toEqual([]);
  } finally {
    fixtureSql("UPDATE photos SET file_date=620 WHERE id=620");
  }
});

test("retains decoded covers through grid changes and live fractional DPI changes", async () => {
  errors = [];
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setSize(1280, 800);
    window.webContents.setZoomFactor(1);
  });
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.setItem("grid_column_width", "320");
    localStorage.setItem("grid_sort_field", "name");
    localStorage.setItem("grid_sort_order", "asc");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  const card = page.locator('[data-photo-id="1"][role="option"]');
  const image = card.locator('img[data-load-state="loaded"]');
  await expect(image).toBeVisible();
  const largeUrl = await image.getAttribute("src");
  const resize = async (value: number) => {
    await page
      .getByRole("slider", { name: "Grid", exact: true })
      .evaluate((element, value) => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value"
        )?.set;
        setter?.call(element, String(value));
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
  };
  await resize(140);
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().width)
    )
    .toBeLessThan(180);
  await expect(image).toHaveAttribute("src", largeUrl ?? "");
  await resize(320);
  await expect
    .poll(() =>
      card.evaluate((element) => element.getBoundingClientRect().width)
    )
    .toBeGreaterThan(300);
  await expect(image).toHaveAttribute("src", largeUrl ?? "");
  const cdp = await page.context().newCDPSession(page);
  try {
    for (const dpr of [2, 1.25, 1.5, 3]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: 1280,
        height: 768,
        deviceScaleFactor: dpr,
        mobile: false,
      });
      await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(dpr);
      await expect
        .poll(() =>
          card.evaluate((element) => {
            const image = element.querySelector("img");
            const rect = element.getBoundingClientRect();
            const required = Math.min(
              2048,
              Math.max(rect.width, rect.height) * devicePixelRatio
            );
            const edge = Number(
              new URL(image?.src ?? location.href).searchParams.get("edge")
            );
            return Boolean(
              image?.complete && image.naturalWidth > 0 && edge >= required
            );
          })
        )
        .toBe(true);
      await assertBounds();
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
    await cdp.detach();
  }
  expect(errors).toEqual([]);
});
