import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect } from "@playwright/test";
import electronPath from "electron";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const ADD_FOLDER = /^(Add Folder|添加文件夹)$/;
const START_INDEX = /^(Start AI Indexing|开始 AI 索引)$/;

test("pauses active AI through the UI and resumes only after an explicit restart", async () => {
  test.setTimeout(360_000);
  const root = createTestRuntime("library-ai-stop-ui");
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
    await addPhotos(source, 200);
    app = await launch();
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
    }, source);
    await page.getByRole("button", { name: ADD_FOLDER }).first().click();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/settings/ai-index"));
    const pause = page.getByRole("button", { name: "Pause", exact: true });
    await expect(pause).toBeVisible({ timeout: 120_000 });
    await pause.click();
    await expect
      .poll(
        () =>
          sql("SELECT value FROM app_settings WHERE key='ai.autoIndexStopped'"),
        { timeout: 30_000 }
      )
      .toEqual([{ value: "true" }]);
    await expect(
      page.getByRole("button", { name: "Resume", exact: true })
    ).toBeVisible({ timeout: 30_000 });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect.poll(() => count(), { timeout: 60_000 }).toBe(200);
    expect(count(true)).toBeLessThan(200);
    expect(
      sql("SELECT value FROM app_settings WHERE key='ai.autoIndexStopped'")
    ).toEqual([{ value: "true" }]);
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/settings/ai-index"));
    await page.getByRole("button", { name: START_INDEX }).click();
    await expect.poll(() => count(true), { timeout: 180_000 }).toBe(200);
  } finally {
    await app?.close();
  }
});
