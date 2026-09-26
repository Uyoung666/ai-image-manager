import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("an interrupted committed batch resumes across two launches", async () => {
  const testInfo = test.info();
  test.setTimeout(180_000);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aim-import-recovery-"));
  const profile = path.join(root, "profile");
  const fixture = path.join(root, "fixture");
  fs.mkdirSync(fixture);
  // 60 crosses the production scanner's 50-record commit boundary.
  const png = await sharp({
    create: { width: 64, height: 48, channels: 3, background: "#345678" },
  })
    .png()
    .toBuffer();
  for (let i = 0; i < 60; i++) {
    fs.writeFileSync(path.join(fixture, `fixture-${i}.png`), png);
  }
  const preload = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    preload,
    `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "e2e",
    AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
    AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
    APPDATA: path.join(root, "appdata"),
    LOCALAPPDATA: path.join(root, "local"),
    TEMP: path.join(root, "scratch"),
    TMP: path.join(root, "scratch"),
  };
  env.ELECTRON_RUN_AS_NODE = undefined;
  const query = (sql: string) =>
    JSON.parse(
      execFileSync(
        electronPath,
        [
          "-e",
          "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:true});try{console.log(JSON.stringify(db.prepare(process.argv[2]).all()));}finally{db.close();}",
          path.join(profile, "data", "ai-image-manager.db"),
          sql,
        ],
        { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
      )
    );
  let app: ElectronApplication | undefined;
  const requireApp = () => {
    if (!app) {
      throw new Error("Electron app is not running");
    }
    return app;
  };
  const launch = async () => {
    app = await _electron.launch({
      args: ["-r", preload, "--e2e", path.resolve(".")],
      env: Object.fromEntries(
        Object.entries(env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined
        )
      ),
    });
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "添加文件夹", exact: true })
      .first()
      .waitFor();
    return page;
  };
  try {
    let page = await launch();
    await requireApp().evaluate(
      ({ app: electronApp, BrowserWindow, dialog }, folder) => {
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [folder],
        });
        const contents = BrowserWindow.getAllWindows()[0].webContents;
        const send = contents.send.bind(contents);
        let interrupted = false;
        contents.send = (channel, ...args) => {
          send(channel, ...args);
          const progress = args[0];
          if (
            !interrupted &&
            channel === "scan-progress" &&
            progress.phase === "indexing" &&
            progress.scanned >= 50
          ) {
            interrupted = true;
            // Ordinary Electron quit, synchronized to a real committed batch.
            electronApp.quit();
          }
        };
      },
      fixture
    );
    const exited = requireApp().waitForEvent("close");
    await page
      .getByRole("button", { name: "添加文件夹", exact: true })
      .first()
      .press("Enter");
    await exited;
    app = undefined;
    const partial = query("select count(*) n from photos")[0].n;
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(60);
    page = await launch();
    await expect
      .poll(() => query("select count(*) n from photos")[0].n, {
        timeout: 60_000,
      })
      .toBe(60);
    await expect(page.getByText("60 张照片", { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        JSON.parse(
          query(
            "select value from app_settings where key='imports.unfinishedRoots'"
          )[0].value
        )
      )
      .toEqual([]);
    const completed = query(
      "select last_scanned_at from folders where parent_id is null"
    );
    await requireApp().close();
    app = undefined;
    page = await launch();
    await expect(page.getByText("60 张照片", { exact: true })).toBeVisible();
    expect(query("select count(*) n from photos")[0].n).toBe(60);
    expect(
      query("select path from photos group by lower(path) having count(*) > 1")
    ).toEqual([]);
    expect(query("pragma foreign_key_check")).toEqual([]);
    expect(
      query("select last_scanned_at from folders where parent_id is null")
    ).toEqual(completed);
    await testInfo.attach("recovery-accounting", {
      body: JSON.stringify({ filesystem: 60, partial, final: 60, completed }),
      contentType: "application/json",
    });
  } finally {
    await app?.close();
    // This mkdtemp root contains only this test's generated PNGs and profile.
    expect(path.dirname(root)).toBe(os.tmpdir());
    const protectedEntry = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .find(
        (entry) =>
          [".csv", ".xlsx"].includes(path.extname(entry.name).toLowerCase()) ||
          (entry.isDirectory() && entry.name.toLowerCase() === "temp")
      );
    expect(protectedEntry).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
