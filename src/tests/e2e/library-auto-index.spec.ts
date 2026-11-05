import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect } from "@playwright/test";
import electronPath from "electron";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const ADD_FOLDER = /^(Add Folder|添加文件夹)$/;
const PARTIAL_STATUS = /AI.*16\/21/;
const STOPPED = /stopped|已停止/;
const START_INDEX = /^(Start AI Indexing|开始 AI 索引)$/;
const COMPLETE_STATUS = /AI.*21\/21/;

test("recovers offline additions, indexes live additions and preserves stopped indexing across restart", async () => {
  test.setTimeout(360_000);
  const root = createTestRuntime("library-auto-index");
  const profile = path.join(root, "profile");
  const source = path.join(root, "photos");
  const preload = path.join(root, "isolate.cjs");
  fs.writeFileSync(
    preload,
    `const {app}=require('electron');app.setAppPath(${JSON.stringify(path.resolve("."))});const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',userData:'profile',sessionData:'profile',cache:'cache',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
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
        "--lang=en-US",
        process.env.AIM_LIBRARY_E2E_ENTRY ?? path.resolve("."),
      ],
      env,
    });
  const sql = (query: string) =>
    JSON.parse(
      execFileSync(
        electronPath as unknown as string,
        [
          "-e",
          "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{console.log(JSON.stringify(d.prepare(process.argv[2]).all()))}finally{d.close()}",
          path.join(profile, "data/ai-image-manager.db"),
          query,
        ],
        { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
      )
    );
  const count = (processed = false) =>
    sql(
      `select count(*) n from photos where deleted_at is null${processed ? " and is_ai_processed=1" : ""}`
    )[0].n;
  async function addPhotos(directory: string, n: number) {
    fs.mkdirSync(directory, { recursive: true });
    for (let i = 0; i < n; i++) {
      await sharp({
        create: {
          width: 64,
          height: 48,
          channels: 3,
          background: { r: i * 40, g: 90, b: 150 },
        },
      })
        .jpeg()
        .toFile(path.join(directory, `photo-${i}.jpg`));
    }
  }
  let app: ElectronApplication | undefined;
  try {
    await addPhotos(source, 1);
    app = await launch();
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, source);
    await page.getByRole("button", { name: ADD_FOLDER }).first().click();
    await expect.poll(() => count(true), { timeout: 120_000 }).toBe(1);
    await addPhotos(path.join(source, "live-before-restart"), 5);
    await expect.poll(() => count(), { timeout: 30_000 }).toBe(6);
    await expect.poll(() => count(true), { timeout: 120_000 }).toBe(6);
    await app.close();
    app = undefined;

    await addPhotos(path.join(source, "offline", "new"), 5);
    app = await launch();
    page = await app.firstWindow();
    await expect.poll(() => count(), { timeout: 30_000 }).toBe(11);
    await expect.poll(() => count(true), { timeout: 120_000 }).toBe(11);
    await addPhotos(path.join(source, "live", "deep"), 5);
    await expect.poll(() => count(), { timeout: 30_000 }).toBe(16);
    await expect.poll(() => count(true), { timeout: 120_000 }).toBe(16);
    expect(sql("pragma foreign_key_check")).toEqual([]);
    await app.close();
    app = undefined;

    // A persisted user stop must survive a new process, while discovery continues.
    sql(
      "insert into app_settings(key,value,updated_at) values('ai.autoIndexStopped','true',1) on conflict(key) do update set value='true' returning key"
    );
    await addPhotos(path.join(source, "while-stopped"), 5);
    app = await launch();
    page = await app.firstWindow();
    await expect.poll(() => count(), { timeout: 30_000 }).toBe(21);
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await page.locator("main").waitFor();
    fs.writeFileSync(
      test.info().outputPath("status-before-matrix.json"),
      JSON.stringify(
        await page.getByRole("status").evaluateAll((elements) =>
          elements.map((element) => ({
            text: element.textContent,
            label: element.getAttribute("aria-label"),
          }))
        )
      )
    );
    for (const size of [
      { width: 720, height: 480 },
      { width: 900, height: 600 },
      { width: 1280, height: 800 },
    ]) {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        const main = BrowserWindow.getAllWindows()[0];
        main.setContentSize(bounds.width, bounds.height);
        main.show();
        main.focus();
      }, size);
      const indicator = page.getByRole("status", { name: PARTIAL_STATUS });
      await expect(indicator).toBeVisible({ timeout: 15_000 });
      await expect
        .poll(
          async () => {
            await app?.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows()[0].focus()
            );
            await page.bringToFront();
            await page.mouse.move(0, 0);
            await indicator.hover();
            try {
              return await page
                .locator('[data-slot="tooltip-content"]')
                .evaluate(
                  (element) => {
                    const rect = element.getBoundingClientRect();
                    return {
                      text: element.textContent,
                      inside:
                        rect.left >= 0 &&
                        rect.right <= innerWidth + 1 &&
                        rect.top >= 0 &&
                        rect.bottom <= innerHeight + 1,
                      noOverflow:
                        document.documentElement.scrollWidth <= innerWidth,
                    };
                  },
                  undefined,
                  { timeout: 2000 }
                );
            } catch {
              return null;
            }
          },
          { timeout: 15_000 }
        )
        .toMatchObject({
          text: expect.stringMatching(STOPPED),
          inside: true,
          noOverflow: true,
        });
      await page.screenshot({
        path: test.info().outputPath(`auto-index-status-${size.width}.png`),
        animations: "disabled",
      });
      await page.keyboard.press("Escape");
    }
    expect(count(true)).toBe(16);
    await page.evaluate(() => window.__e2eNavigate?.("/settings/ai-index"));
    await page.getByRole("button", { name: START_INDEX }).click();
    await expect.poll(() => count(true), { timeout: 120_000 }).toBe(21);
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await expect(
      page.getByRole("status", { name: COMPLETE_STATUS })
    ).toHaveCount(0);
  } finally {
    await app?.close();
  }
});
