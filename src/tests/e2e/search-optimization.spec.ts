import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect } from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electron = createRequire(import.meta.url)("electron") as string;
const PARTIAL_RESULTS_TEXT = /Partial results|当前为部分结果/;
const INCOMPLETE_SEARCH_TEXT = /Search is incomplete|搜索尚未完成/;
const NO_MATCHING_PHOTOS_TEXT = /No matching photos|未找到匹配的照片/;
const CLEAR_SEARCH_RE = /Clear search|清除搜索/i;
const SEARCH_ERROR_TEXT = /Search failed|搜索失败/;
const AI_NOT_INDEXED_TEXT = /AI index|AI 索引|AI 智能索引/i;
const TIME_EMPTY_TEXT = /No photos.*time|No photos.*year|时间范围|去年/;
const sizes = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];

test("search partial results, request timing, stale queries and responsive windows", async () => {
  test.setTimeout(180_000);
  const root = createTestRuntime("search-optimization");
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
      background: { r: 30, g: 140, b: 100 },
    },
  })
    .png()
    .toBuffer();
  const statements: string[] = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(1,'${fixture.replaceAll("'", "''")}','Search fixture',11,1,0)`,
  ];
  for (let id = 1; id <= 12; id++) {
    const name = `SearchFixture-${String(id).padStart(3, "0")}.png`;
    const file = path.join(fixture, name);
    fs.writeFileSync(file, image);
    statements.push(
      `INSERT INTO photos(id,folder_id,path,filename,file_size,file_date,width,height,format,thumbnail_path,is_indexed,is_ai_processed,is_face_processed,deleted_at,created_at) VALUES(${id},1,'${file.replaceAll("'", "''")}','${name}',1024,${id},96,64,'png','${file.replaceAll("'", "''")}',1,1,1,${id === 12 ? Date.now() : "NULL"},1)`
    );
    statements.push(
      `INSERT INTO exif_data(photo_id,camera_model,iso,date_taken) VALUES(${id},'${id % 2 ? "Nikon" : "Canon"}',${id % 2 ? 800 : 100},150)`
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
      Object.assign(window, { searchMeasurements: events });
      window.addEventListener("photo-search-diagnostics", (event) =>
        events.push((event as CustomEvent).detail)
      );
    });
    await page.reload();
    const input = page.locator("input.home-search-input");
    await input.waitFor();
    const renamePhotoTable = (restore: boolean) =>
      app.evaluate(({ app: instance }, revert) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(`${instance.getAppPath()}/package.json`);
        const Database = require("better-sqlite3");
        const database = new Database(
          require("node:path").join(
            instance.getPath("userData"),
            "data/ai-image-manager.db"
          )
        );
        try {
          database.exec(
            revert
              ? "ALTER TABLE test_search_photos_unavailable RENAME TO photos"
              : "ALTER TABLE photos RENAME TO test_search_photos_unavailable"
          );
        } finally {
          database.close();
        }
      }, restore);
    const measurements: Array<{
      size: { width: number; height: number };
      bounds: { overflow: boolean; escaped: boolean };
    }> = [];
    for (const size of sizes) {
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
      await input.fill("SearchFixture-008");
      await input.press("Enter");
      await expect(page.locator('[data-photo-id="8"]')).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_TEXT })
      ).toBeVisible();
      await page.locator('[data-photo-id="8"]').click({ button: "right" });
      await expect(page.getByRole("menu")).toBeVisible();
      const bounds = await page.evaluate(() => {
        const targets = [
          document.documentElement,
          document.body,
          ...document.querySelectorAll("main"),
        ];
        const escaped = [
          ...document.querySelectorAll(
            '[role="dialog"], [role="menu"], [role="status"]'
          ),
        ]
          .filter((node) => node.getClientRects().length)
          .some((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left < -1 ||
              rect.top < -1 ||
              rect.right > innerWidth + 1 ||
              rect.bottom > innerHeight + 1
            );
          });
        return {
          overflow: targets.some(
            (node) => node.scrollWidth > node.clientWidth + 2
          ),
          escaped,
        };
      });
      expect(bounds).toEqual({ overflow: false, escaped: false });
      await page.keyboard.press("Escape");
      await page.screenshot({
        path: test.info().outputPath(`search-${size.width}x${size.height}.png`),
      });
      await input.fill("DefinitelyMissingSearchFixture");
      await input.press("Enter");
      await expect(
        page.getByRole("heading", { name: INCOMPLETE_SEARCH_TEXT })
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: NO_MATCHING_PHOTOS_TEXT })
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page
            .getByRole("heading", { name: INCOMPLETE_SEARCH_TEXT })
            .evaluate((node) => {
              let opacity = 1;
              for (
                let element: Element | null = node;
                element;
                element = element.parentElement
              ) {
                opacity *= Number.parseFloat(getComputedStyle(element).opacity);
              }
              return opacity;
            })
        )
        .toBeGreaterThan(0.95);
      const emptyBounds = await page
        .getByRole("heading", { name: INCOMPLETE_SEARCH_TEXT })
        .evaluate((node) => {
          const rect = node.closest("section")?.getBoundingClientRect();
          return Boolean(
            rect &&
              rect.left >= 0 &&
              rect.right <= innerWidth &&
              rect.top >= 0 &&
              rect.bottom <= innerHeight &&
              document.documentElement.scrollWidth <= innerWidth
          );
        });
      expect(emptyBounds).toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`search-incomplete-${size.width}x${size.height}.png`),
      });
      // An exact filename search is complete without an AI index; metadata
      // from the preceding partial query must not remain in the toolbar.
      await input.fill('"DefinitelyMissingSearchFixture.png"');
      await input.press("Enter");
      await expect(
        page.getByRole("heading", { name: NO_MATCHING_PHOTOS_TEXT })
      ).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_TEXT })
      ).toHaveCount(0);
      await expect(
        page.getByRole("heading").filter({ hasText: AI_NOT_INDEXED_TEXT })
      ).toHaveCount(0);
      await input.fill("去年");
      await input.press("Enter");
      await expect(
        page.getByRole("heading").filter({ hasText: TIME_EMPTY_TEXT })
      ).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_TEXT })
      ).toHaveCount(0);
      // A new request failing after partial results clears the old completion
      // notice instead of presenting two contradictory states.
      await input.fill("SearchFixture-008");
      await input.press("Enter");
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_TEXT })
      ).toBeVisible();
      await renamePhotoTable(false);
      try {
        await input.fill(`FailedSearchFixture-${size.width}`);
        await input.press("Enter");
        await expect(
          page.getByRole("heading", { name: SEARCH_ERROR_TEXT })
        ).toBeVisible();
        await expect(
          page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_TEXT })
        ).toHaveCount(0);
      } finally {
        await renamePhotoTable(true);
      }
      measurements.push({ size, bounds });
      await page
        .locator('input[type="file"][accept="image/*"]')
        .setInputFiles(path.join(fixture, "SearchFixture-008.png"));
      await expect(
        page.getByRole("heading", { name: INCOMPLETE_SEARCH_TEXT })
      ).toHaveCount(0);
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_TEXT })
      ).toHaveCount(0);
      await expect(page.locator(".home-image-search-reference")).toBeVisible();
      await page.getByRole("button", { name: CLEAR_SEARCH_RE }).click();
      await expect(input).toBeVisible();
    }
    await input.fill("SearchFixture-001");
    await input.press("Enter");
    await input.fill("SearchFixture-003");
    await input.press("Enter");
    await expect(page.locator('[data-photo-id="3"]')).toBeVisible();
    await expect(page.locator('[data-photo-id="1"]')).toHaveCount(0);
    await input.fill("SearchFixture-012");
    await input.press("Enter");
    await expect(page.locator('[data-photo-id="12"]')).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { searchMeasurements: unknown[] })
              .searchMeasurements.length
        )
      )
      .toBeGreaterThan(0);
    const diagnostics = await page.evaluate(
      () =>
        (
          window as unknown as {
            searchMeasurements: Array<{
              timings: {
                firstPaintMs: number | null;
                ipcMs: number | null;
                serviceMs: number | null;
              };
            }>;
          }
        ).searchMeasurements
    );
    expect(
      diagnostics.every(
        (row) =>
          row.timings.firstPaintMs !== null &&
          row.timings.ipcMs !== null &&
          row.timings.serviceMs !== null
      )
    ).toBe(true);
    const memory = await app.evaluate(({ app: instance }) =>
      instance
        .getAppMetrics()
        .map((row) => ({ type: row.type, memory: row.memory }))
    );
    fs.writeFileSync(
      test.info().outputPath("search-chain-report.json"),
      JSON.stringify({ measurements, diagnostics, memory }, null, 2)
    );
  } finally {
    await app.close();
  }
});
