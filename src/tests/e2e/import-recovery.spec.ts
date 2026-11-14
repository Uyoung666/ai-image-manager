import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect } from "@playwright/test";
import sharp from "sharp";
import {
  closeTestApp,
  createTestRuntime,
  launchTestApp,
  test,
} from "./helpers/test-runtime";

const require = createRequire(import.meta.url);
const electronPath = require("electron") as string;

test("an interrupted committed batch resumes across two launches", async () => {
  const testInfo = test.info();
  test.setTimeout(180_000);
  const root = createTestRuntime("import-recovery");
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
  const query = (sql: string, write = false) =>
    JSON.parse(
      execFileSync(
        electronPath,
        [
          "-e",
          "const D=require('better-sqlite3');const db=new D(process.argv[1],{readonly:process.argv[3]!=='write'});try{if(process.argv[3]==='write'){db.exec(process.argv[2]);console.log('[]')}else console.log(JSON.stringify(db.prepare(process.argv[2]).all()));}finally{db.close();}",
          path.join(profile, "data", "ai-image-manager.db"),
          sql,
          write ? "write" : "read",
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
    app = await launchTestApp(root, {
      args: ["-r", preload, "--e2e", "--lang=zh-CN", path.resolve(".")],
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
    await expect(
      page.getByText("60 张照片", { exact: true }).filter({ visible: true })
    ).toBeVisible();
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
      "select id,last_scanned_at from folders where parent_id is null order by id"
    );
    const completedPhotos = query(
      "SELECT id,path,folder_id,file_revision,content_revision FROM photos ORDER BY id"
    );
    const reviewedId = completedPhotos[0].id;
    query(
      `
      UPDATE photos SET is_favorite=1 WHERE id=${reviewedId};
      INSERT INTO tags(id,name,created_at) VALUES(900001,'Recovery preserved tag',1);
      INSERT INTO photo_tags(photo_id,tag_id,origin,user_confirmed) VALUES(${reviewedId},900001,'manual',1);
      INSERT INTO albums(id,name,created_at) VALUES(900001,'Recovery preserved album',1);
      INSERT INTO album_photos(album_id,photo_id) VALUES(900001,${reviewedId});
    `,
      true
    );
    const foldersBeforeRestart = query(
      "SELECT id,path,parent_id,photo_count FROM folders ORDER BY id"
    );
    await closeTestApp(requireApp());
    app = undefined;
    page = await launch();
    await expect(
      page.getByText("60 张照片", { exact: true }).filter({ visible: true })
    ).toBeVisible();
    expect(query("select count(*) n from photos")[0].n).toBe(60);
    await expect
      .poll(
        () =>
          query(
            "SELECT id,last_scanned_at FROM folders WHERE parent_id IS NULL ORDER BY id"
          ).every(
            (row: { id: number; last_scanned_at: number }, index: number) =>
              row.id === completed[index].id &&
              row.last_scanned_at > completed[index].last_scanned_at
          ),
        { timeout: 30_000 }
      )
      .toBe(true);
    expect(
      query("select path from photos group by lower(path) having count(*) > 1")
    ).toEqual([]);
    expect(query("pragma foreign_key_check")).toEqual([]);
    // Startup reconciliation can advance the completed scan timestamp. Its
    // catalogue identities, accepted file versions and review links stay stable.
    expect(
      query(
        "SELECT id,path,folder_id,file_revision,content_revision FROM photos ORDER BY id"
      )
    ).toEqual(completedPhotos);
    expect(
      query("SELECT id,path,parent_id,photo_count FROM folders ORDER BY id")
    ).toEqual(foldersBeforeRestart);
    expect(
      query(`SELECT id,is_favorite FROM photos WHERE id=${reviewedId}`)
    ).toEqual([{ id: reviewedId, is_favorite: 1 }]);
    expect(
      query("SELECT photo_id,tag_id FROM photo_tags WHERE tag_id=900001")
    ).toEqual([{ photo_id: reviewedId, tag_id: 900_001 }]);
    expect(
      query("SELECT album_id,photo_id FROM album_photos WHERE album_id=900001")
    ).toEqual([{ album_id: 900_001, photo_id: reviewedId }]);
    const afterRestart = query(
      "SELECT id,last_scanned_at FROM folders WHERE parent_id IS NULL ORDER BY id"
    );
    expect(afterRestart.map((row: { id: number }) => row.id)).toEqual(
      completed.map((row: { id: number }) => row.id)
    );
    for (let index = 0; index < completed.length; index++) {
      expect(afterRestart[index].last_scanned_at).toBeGreaterThanOrEqual(
        completed[index].last_scanned_at
      );
    }
    expect(
      JSON.parse(
        query(
          "SELECT value FROM app_settings WHERE key='imports.unfinishedRoots'"
        )[0].value
      )
    ).toEqual([]);
    await testInfo.attach("recovery-accounting", {
      body: JSON.stringify({
        filesystem: 60,
        partial,
        final: 60,
        completed,
        afterRestart,
        completedPhotos,
        foldersBeforeRestart,
      }),
      contentType: "application/json",
    });
  } finally {
    if (app) {
      await closeTestApp(app);
    }
  }
});
