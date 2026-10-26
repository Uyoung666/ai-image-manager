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

declare global {
  interface Window {
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
    const send = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (message, transfer) {
      const request =
        typeof message === "string" ? JSON.parse(message) : message;
      if (request?.p?.u?.includes("listPhotoPage")) {
        window.paginationRecoveryRequests.push({
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
      // Each jump reaches the current page boundary. The next page must arrive
      // with the pointer still, including after a host cursor revision change.
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
      expect(requestCount).toBeGreaterThanOrEqual(8);
      expect(requestCount).toBeLessThanOrEqual(14);
      const cursors = requests
        .map(({ cursor }) => cursor)
        .filter((cursor): cursor is string => cursor !== null);
      expect(cursors.length).toBeGreaterThanOrEqual(7);
      // A stale cursor is rejected once before resetting from the first page;
      // retrying that same opaque value can never restore a changed revision.
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
