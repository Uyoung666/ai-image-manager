import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electron = createRequire(import.meta.url)("electron") as string;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const PARTIAL_RESULTS = /Partial results|当前为部分结果/;
const RETURN_TO_COLORS = /Back to places.*color|返回地点与色彩/i;
const RETRY = /^(Retry|重试)$/i;
const RESET = /^(Reset|重置)$/i;
const PLACES_TAB = /Places.*colou?r|地点与色彩/i;
const PHOTO_COUNT = /^(8 photos|8\s*张照片)$/;
const SCROLLED = /\bis-scrolled\b/;
const LIGHT_GLASS_ALPHA = /0\.86\)$/;
const DARK_GLASS_ALPHA = /0\.82\)$/;
const LONG_FOLDER_NAMES = [
  "01-modern-literary-girl",
  "非常长的图库文件夹名称".repeat(12),
  "Very-long-gallery-folder-name-".repeat(8),
];

function installPartialResponseFixture() {
  let requestId: unknown;
  const send = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, transfer) {
    const request = typeof message === "string" ? JSON.parse(message) : message;
    if (
      document.body.dataset.partialColorSearch === "armed" &&
      request?.p?.u?.includes("searchCompound")
    ) {
      requestId = request.i;
      delete document.body.dataset.partialColorSearch;
    }
    send.call(
      this,
      message,
      Array.isArray(transfer) ? { transfer } : (transfer ?? {})
    );
  };

  const listen = MessagePort.prototype.addEventListener;
  MessagePort.prototype.addEventListener = function (
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions
  ) {
    if (!listener) {
      return;
    }
    if (type !== "message" || typeof listener !== "function") {
      return listen.call(this, type, listener, options);
    }
    return listen.call(
      this,
      type,
      (event) => {
        const raw = (event as MessageEvent).data;
        const response = typeof raw === "string" ? JSON.parse(raw) : raw;
        if (
          requestId === undefined ||
          response?.i !== requestId ||
          !response?.p?.b?.json
        ) {
          listener.call(this, event);
          return;
        }
        requestId = undefined;
        Object.assign(response.p.b.json, {
          completion: "partial",
          incompleteReason: "semantic-unavailable",
          totalExact: false,
        });
        listener.call(
          this,
          new MessageEvent("message", {
            data: typeof raw === "string" ? JSON.stringify(response) : response,
          })
        );
      },
      options
    );
  };
}

async function expectInlineRetry(page: Page) {
  const notice = page.getByRole("status").filter({ hasText: PARTIAL_RESULTS });
  const retry = notice.getByRole("button", { name: RETRY });
  const back = page.getByRole("button", { name: RETURN_TO_COLORS });
  const reset = page.getByRole("button", { name: RESET });
  await expect(notice).toHaveCount(1);
  await expect(retry).toBeVisible();
  const bounds = await Promise.all([
    back.boundingBox(),
    retry.boundingBox(),
    reset.boundingBox(),
  ]);
  const [backBox, retryBox, resetBox] = bounds;
  if (!(backBox && retryBox && resetBox)) {
    throw new Error("The drill controls must all have visible bounds");
  }
  expect(
    Math.abs(backBox.y + backBox.height / 2 - retryBox.y - retryBox.height / 2)
  ).toBeLessThan(2);
  expect(retryBox.x).toBeGreaterThanOrEqual(backBox.x + backBox.width);
  expect(resetBox.x).toBeGreaterThanOrEqual(retryBox.x + retryBox.width);
  await retry.click();
  await expect(notice).toHaveCount(0);
  await expect(page.locator('[data-photo-id="1"]')).toBeVisible();
}

async function expectAlbumGlass(page: Page, route: string, light: boolean) {
  await page.evaluate((theme) => {
    document.documentElement.classList.toggle("light", theme);
    document.documentElement.classList.toggle("dark", !theme);
  }, light);
  await page.evaluate((target) => window.__e2eNavigate?.(target), route);
  const toolbar = page.locator(".gallery-glass-toolbar");
  const grid = page.locator("[data-masonry-scroll]");
  await expect(toolbar).toBeVisible();
  await expect(toolbar).toHaveCSS("backdrop-filter", "none");
  await grid.evaluate((element) => {
    element.scrollTop = 80;
  });
  await expect(toolbar).toHaveClass(SCROLLED);
  await expect(toolbar).toHaveCSS(
    "backdrop-filter",
    "blur(12px) saturate(1.2)"
  );
  await expect(toolbar).toHaveCSS(
    "background-color",
    light ? LIGHT_GLASS_ALPHA : DARK_GLASS_ALPHA
  );
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  await expect(toolbar).toHaveCSS("backdrop-filter", "none");
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "false";
  });
  await grid.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(toolbar).not.toHaveClass(SCROLLED);
  await expect(toolbar).toHaveCSS("backdrop-filter", "none");
}

async function expectLongFolderToolbar(page: Page) {
  await page.evaluate(() => window.__e2eNavigate?.("/?reset=true"));
  await page.locator('[data-photo-id][role="option"]').first().click();
  await expect(page.locator(".home-detail-panel-container")).toBeVisible();
  const toolbar = page.locator(".home-gallery-toolbar-layer");
  const row = toolbar.locator(".home-toolbar-primary-row");
  const measure = () =>
    row.evaluate((element) => {
      const form = element.querySelector<HTMLElement>(".home-search-form");
      const actions = element.querySelector<HTMLElement>(
        ".home-toolbar-actions"
      );
      if (!(form && actions)) {
        throw new Error("Search form or toolbar actions are missing");
      }
      const formBox = form.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      return {
        formWidth: formBox.width,
        verticalDistance: Math.abs(
          formBox.y + formBox.height / 2 - actionsBox.y - actionsBox.height / 2
        ),
        overflow: element.scrollWidth - element.clientWidth,
      };
    });
  const allPhotos = await measure();
  for (const [index, name] of LONG_FOLDER_NAMES.entries()) {
    await page.locator(`[data-folder-id="${index + 1}"]`).click();
    const heading = toolbar.locator(".home-toolbar-context").getByText(name, {
      exact: true,
    });
    await expect(heading).toBeVisible();
    const card = page.locator(`[data-photo-id="${index + 1}"][role="option"]`);
    await card.click();
    await expect(card).toHaveAttribute("aria-selected", "true");
    await expect(page.locator(".home-detail-panel-container")).toBeVisible();
    const folder = await measure();
    expect(folder.formWidth).toBeLessThan(allPhotos.formWidth);
    expect(folder.formWidth).toBeGreaterThanOrEqual(178);
    expect(folder.verticalDistance).toBeLessThan(2);
    expect(folder.overflow).toBeLessThanOrEqual(2);
  }
}

test("gallery toolbars stay usable across window sizes", async () => {
  test.setTimeout(180_000);
  const root = createTestRuntime("dashboard-color-drill");
  const profile = path.join(root, "profile");
  const preload = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    preload,
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
  );
  const env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
      TEMP: path.join(root, "scratch"),
      TMP: path.join(root, "scratch"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const launch = () =>
    launchTestApp(root, {
      args: [
        "-r",
        preload,
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--e2e",
        "--force-device-scale-factor=1",
        path.resolve("."),
      ],
      env,
    });
  let app = await launch();
  await (await app.firstWindow()).locator("input.home-search-input").waitFor();
  await app.close();

  const fixture = path.join(root, "fixture");
  fs.mkdirSync(fixture);
  const image = await sharp({
    create: {
      width: 64,
      height: 192,
      channels: 3,
      background: { r: 38, g: 83, b: 217 },
    },
  })
    .png()
    .toBuffer();
  const statements = [
    "INSERT INTO albums(id,name,created_at) VALUES(1,'Toolbar album',1)",
    `INSERT INTO albums(id,name,is_smart,smart_rules,created_at) VALUES(2,'Toolbar smart album',1,'${JSON.stringify({ rules: [{ type: "tags", operator: "包含任一", value: ["Glass fixture"] }] })}',1)`,
    "INSERT INTO tags(id,name,created_at) VALUES(1,'Glass fixture',1)",
  ];
  for (const [index, name] of LONG_FOLDER_NAMES.entries()) {
    const folder = path.join(fixture, String(index));
    fs.mkdirSync(folder);
    statements.push(
      `INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(${index + 1},'${folder.replaceAll("'", "''")}','${name}',4,1,0)`
    );
  }
  for (let id = 1; id <= 13; id++) {
    const name = `ColorFixture-${id}.png`;
    const folderIndex = (id - 1) % LONG_FOLDER_NAMES.length;
    const file = path.join(fixture, String(folderIndex), name);
    fs.writeFileSync(file, image);
    const palette = JSON.stringify([
      id <= 8 || id === 13
        ? {
            r: 38,
            g: 83,
            b: 217,
            hex: "#2653d9",
            hue: 225,
            saturation: 0.7,
            lightness: 0.5,
            weight: 1,
          }
        : {
            r: 217,
            g: 38,
            b: 38,
            hex: "#d92626",
            hue: 0,
            saturation: 0.7,
            lightness: 0.5,
            weight: 1,
          },
    ]);
    statements.push(
      `INSERT INTO photos(id,folder_id,path,filename,file_size,file_date,width,height,format,thumbnail_path,dominant_colors,is_indexed,is_ai_processed,is_face_processed,deleted_at,created_at) VALUES(${id},${folderIndex + 1},'${file.replaceAll("'", "''")}','${name}',1024,${id},64,192,'png','${file.replaceAll("'", "''")}','${palette}',1,1,1,${id === 13 ? Date.now() : "NULL"},1)`
    );
  }
  statements.push(
    "INSERT INTO album_photos(album_id,photo_id) SELECT 1,id FROM photos WHERE deleted_at IS NULL",
    "INSERT INTO photo_tags(photo_id,tag_id) SELECT id,1 FROM photos WHERE deleted_at IS NULL"
  );
  execFileSync(
    electron,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.exec(require('node:fs').readFileSync(0,'utf8'))}finally{d.close()}",
      path.join(profile, "data/ai-image-manager.db"),
    ],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      input: statements.join(";"),
      encoding: "utf8",
    }
  );

  app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator("input.home-search-input").waitFor();
    await page.addInitScript(installPartialResponseFixture);
    await page.addInitScript(() => {
      localStorage.setItem("lang", "en");
      localStorage.setItem("ui.reduceMotion", "false");
      const events: unknown[] = [];
      Object.assign(window, { colorDrillMeasurements: events });
      window.addEventListener("photo-search-diagnostics", (event) =>
        events.push((event as CustomEvent).detail)
      );
    });
    await page.reload();
    await page.locator("input.home-search-input").waitFor();
    // The same flow runs against a packaged renderer in CI and the live
    // development renderer locally; unit coverage always replays StrictMode.
    if (new URL(page.url()).protocol !== "file:") {
      expect(
        await page.evaluate(async (url) => {
          const react = await import(url);
          return typeof (react.act ?? react.default?.act);
        }, new URL("/node_modules/.vite/deps/react.js", page.url()).href)
      ).toBe("function");
    }

    for (const size of SIZES) {
      await app.evaluate(
        ({ BrowserWindow }, bounds) =>
          BrowserWindow.getAllWindows()[0].setContentSize(
            bounds.width,
            bounds.height
          ),
        size
      );
      await expect
        .poll(() =>
          page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        )
        .toEqual(size);
      expect(
        await page.evaluate(() => window.__e2eNavigate?.("/dashboard"))
      ).toBe("/dashboard");
      await page
        .getByRole("button", {
          name: PLACES_TAB,
          exact: true,
        })
        .click();
      const color = page.getByRole("button", {
        name: "#2653d9 67%",
        exact: true,
      });
      await expect(color).toBeVisible();
      const start = await page.evaluate(
        () => Reflect.get(window, "colorDrillMeasurements").length
      );
      await color.click();
      await expect(page.locator('[data-photo-id="1"]')).toBeVisible();
      await expect(
        page.getByRole("button", { name: RETURN_TO_COLORS })
      ).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS })
      ).toHaveCount(0);
      await expect(
        page.locator('[data-photo-id="9"], [data-photo-id="13"]')
      ).toHaveCount(0);
      // The photo count is present in both toolbar layouts.
      await expect(page.getByText(PHOTO_COUNT).first()).toBeAttached();
      await expect
        .poll(() =>
          page.evaluate(
            (offset) =>
              Reflect.get(window, "colorDrillMeasurements")
                .slice(offset)
                .map((event: { completion: string }) => event.completion),
            start
          )
        )
        .toEqual(["complete"]);
      expect(
        await page.evaluate(() =>
          [
            document.documentElement,
            document.body,
            ...document.querySelectorAll("main"),
          ].some((node) => node.scrollWidth > node.clientWidth + 2)
        )
      ).toBe(false);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`first-color-drill-${size.width}x${size.height}.png`),
      });
      await page.getByRole("button", { name: RETURN_TO_COLORS }).click();
      await expect(color).toBeVisible();
      await page.evaluate(() => {
        document.body.dataset.partialColorSearch = "armed";
      });
      await color.click();
      await expectInlineRetry(page);
      await expectAlbumGlass(page, "/albums/1", false);
      await expectAlbumGlass(page, "/albums/2", true);
    }
    const wide = { width: 1600, height: 900 };
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0].setContentSize(
        bounds.width,
        bounds.height
      );
    }, wide);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(wide.width);
    await expectLongFolderToolbar(page);
  } catch (error) {
    const page = app.windows()[0];
    if (page && !page.isClosed()) {
      await test.info().attach("failure-page", {
        body: await page.locator("body").ariaSnapshot(),
        contentType: "text/plain",
      });
      await page.screenshot({
        path: test.info().outputPath("failure-page.png"),
      });
    }
    throw error;
  } finally {
    await app.close();
  }
});
