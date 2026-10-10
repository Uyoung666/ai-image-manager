import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect } from "@playwright/test";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electron = createRequire(import.meta.url)("electron") as string;
const benchmarkProfile = process.env.AIM_SEARCH_BENCHMARK_PROFILE;
const PARTIAL_RESULTS_RE = /Partial results|当前为部分结果/;
const INCOMPLETE_SEARCH_RE = /Search is incomplete|搜索尚未完成/;
const CLEAR_SEARCH_RE = /Clear search|清除搜索/i;
const RETRY_RE = /Retry|重试/;
const IMAGE_ERROR_RE = /Image search failed|以图搜图失败/;
const sizes = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];

test("partial text results switch to successful image search in every window size", async () => {
  test.skip(
    !benchmarkProfile,
    "Requires an isolated real-image benchmark profile"
  );
  test.setTimeout(240_000);
  const source = fs.realpathSync(benchmarkProfile as string);
  expect(
    source.startsWith(path.resolve("reports/search-optimization") + path.sep)
  ).toBe(true);
  const report = JSON.parse(
    fs.readFileSync(path.join(source, "../report.json"), "utf8")
  );
  expect(report.scope).toBe("production-api-real-images");
  const root = createTestRuntime("search-image-transition");
  const profile = path.join(root, "profile");
  fs.cpSync(source, profile, { recursive: true });
  const manifest = JSON.parse(
    fs.readFileSync("audit/tag-benchmark-v2/manifest.v2.json", "utf8")
  );
  const sample = manifest.samples.find(
    (row: { split: string }) => row.split === report.split
  );
  const photoId = manifest.samples.indexOf(sample) + 1;
  expect(photoId).toBeGreaterThan(0);
  const reference = path.join(root, "reference.jpg");
  fs.copyFileSync(sample.filePath, reference);
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
      AI_ZH_QUERY_STRATEGY: "dictionary",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "local"),
      TEMP: path.join(root, "scratch"),
      TMP: path.join(root, "scratch"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  execFileSync(
    electron,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.prepare('INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(1,?,?,160,1,0)').run(process.argv[3],'Semantic fixture');d.exec('UPDATE photos SET folder_id=1');const changed=d.prepare('UPDATE photos SET filename=? WHERE id=?').run('测试未知词汇.jpg',Number(process.argv[2]));if(changed.changes!==1)throw new Error('Missing reference photo')}finally{d.close()}",
      path.join(profile, "data/ai-image-manager.db"),
      String(photoId),
      root,
    ],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }
  );
  const app = await launchTestApp(root, {
    args: [
      "-r",
      preload,
      "--e2e",
      "--force-device-scale-factor=1",
      path.resolve("."),
    ],
    env,
  });
  try {
    const page = await app.firstWindow();
    await page.addInitScript(() => localStorage.setItem("lang", "en"));
    await page.reload();
    const input = page.locator("input.home-search-input");
    await input.waitFor();
    await page.evaluate(() => {
      Object.assign(window, { completedSearchCount: 0 });
      window.addEventListener("photo-search-diagnostics", (event) => {
        const detail = (event as CustomEvent).detail;
        if (
          detail.completion === "complete" &&
          detail.timings.vectorMs !== null
        ) {
          (window as unknown as { completedSearchCount: number })
            .completedSearchCount++;
        }
      });
    });
    // Warm the real image/text runtime before checking a successful image search.
    await expect
      .poll(
        async () => {
          await input.fill("a flower");
          await input.press("Enter");
          return page.evaluate(
            () =>
              (window as unknown as { completedSearchCount: number })
                .completedSearchCount
          );
        },
        { timeout: 120_000, intervals: [5000] }
      )
      .toBeGreaterThan(0);
    await expect(
      page.locator('main [data-slot="loading-spinner"]')
    ).toHaveCount(0, { timeout: 30_000 });
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
      await input.fill("测试未知词汇");
      await input.press("Enter");
      await expect(page.locator(`[data-photo-id="${photoId}"]`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_RE })
      ).toBeVisible();
      await page
        .locator('input[type="file"][accept="image/*"]')
        .setInputFiles(reference);
      await expect(page.locator(".home-image-search-reference")).toBeVisible();
      await expect(
        page.getByRole("status").filter({ hasText: PARTIAL_RESULTS_RE })
      ).toHaveCount(0);
      await expect(
        page.locator('main [data-slot="loading-spinner"]')
      ).toHaveCount(0, { timeout: 30_000 });
      await expect(page.locator(`[data-photo-id="${photoId}"]`)).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        page.getByRole("heading", { name: INCOMPLETE_SEARCH_RE })
      ).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const referenceButton = document.querySelector(
              ".home-image-search-reference"
            );
            const rect = referenceButton?.getBoundingClientRect();
            return Boolean(
              rect &&
                rect.left >= 0 &&
                rect.right <= innerWidth &&
                rect.top >= 0 &&
                rect.bottom <= innerHeight &&
                document.documentElement.scrollWidth <= innerWidth
            );
          })
        )
        .toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`image-transition-${size.width}x${size.height}.png`),
      });
      await page.getByRole("button", { name: CLEAR_SEARCH_RE }).click();
      await expect(input).toBeVisible();
    }
    // Inject a real RPC hydration failure in this disposable database only.
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
              ? "ALTER TABLE test_photos_unavailable RENAME TO photos"
              : "ALTER TABLE photos RENAME TO test_photos_unavailable"
          );
        } finally {
          database.close();
        }
      }, restore);
    await renamePhotoTable(false);
    try {
      await page
        .locator('input[type="file"][accept="image/*"]')
        .setInputFiles(reference);
      await expect(
        page.getByRole("heading", { name: IMAGE_ERROR_RE })
      ).toBeVisible({ timeout: 30_000 });
      await page.getByRole("button", { name: RETRY_RE, exact: true }).click();
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      );
      await expect(page.locator(".home-image-search-reference")).toBeVisible();
      await expect(
        page.getByRole("heading", { name: IMAGE_ERROR_RE })
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await renamePhotoTable(true);
    }
  } finally {
    await app.close();
  }
});
