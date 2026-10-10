import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect } from "@playwright/test";
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
const PLACES_TAB = /Places.*colou?r|地点与色彩/i;
const PHOTO_COUNT = /^(8 photos|8\s*张照片)$/;

test("dashboard color drill completes on the first click across window sizes", async () => {
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
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "local"),
      TEMP: path.join(root, "scratch"),
      TMP: path.join(root, "scratch"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const launch = () =>
    launchTestApp(root, {
      args: [
        "-r",
        preload,
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
      width: 96,
      height: 64,
      channels: 3,
      background: { r: 38, g: 83, b: 217 },
    },
  })
    .png()
    .toBuffer();
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(1,'${fixture.replaceAll("'", "''")}','Color fixture',12,1,0)`,
  ];
  for (let id = 1; id <= 13; id++) {
    const name = `ColorFixture-${id}.png`;
    const file = path.join(fixture, name);
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
      `INSERT INTO photos(id,folder_id,path,filename,file_size,file_date,width,height,format,thumbnail_path,dominant_colors,is_indexed,is_ai_processed,is_face_processed,deleted_at,created_at) VALUES(${id},1,'${file.replaceAll("'", "''")}','${name}',1024,${id},96,64,'png','${file.replaceAll("'", "''")}','${palette}',1,1,1,${id === 13 ? Date.now() : "NULL"},1)`
    );
  }
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
    await page.addInitScript(() => {
      localStorage.setItem("lang", "en");
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
      // The narrow gallery hides its heading count to leave room for search.
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
    }
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
