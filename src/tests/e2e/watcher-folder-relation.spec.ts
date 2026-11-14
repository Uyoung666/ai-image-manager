import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect } from "@playwright/test";
import electronPath from "electron";
import sharp from "sharp";
import { preparePackagedExecutable } from "./helpers/packaged-inspection";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const AUTO_INDEX_STOPPED = /自动索引已停止/;

test("first move into a new directory updates filesystem, database, folder tree and UI", async () => {
  test.setTimeout(240_000);
  const root = createTestRuntime("f04-e2e");
  const source = path.join(root, "fixture");
  const oldPath = path.join(source, "A/photo.jpg");
  const target = path.join(source, "B/深层/photo.jpg");
  const profile = path.join(root, "profile");
  const evidence = test.info().outputDir;
  fs.mkdirSync(evidence, { recursive: true });
  const save = (name: string, data: unknown) =>
    fs.writeFileSync(path.join(evidence, name), JSON.stringify(data, null, 2));
  let app: ElectronApplication | undefined;
  try {
    const executablePath = await preparePackagedExecutable(root, evidence);
    fs.mkdirSync(path.dirname(oldPath), { recursive: true });
    await sharp({
      create: { width: 96, height: 64, channels: 3, background: "#5070a0" },
    })
      .jpeg()
      .toFile(oldPath);
    const preload = path.join(root, "isolation.cjs");
    fs.writeFileSync(
      preload,
      `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [k,v] of Object.entries({appData:'appdata',userData:'profile',sessionData:'profile',cache:'cache',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,v);fs.mkdirSync(p,{recursive:true});app.setPath(k,p);}const original=fs.watch;fs.watch=function(...args){const w=original.apply(this,args);w.on('change',(event,file)=>{fs.appendFileSync(${JSON.stringify(path.join(evidence, "filesystem-events.jsonl"))},JSON.stringify({at:Date.now(),watchPath:String(args[0]),event,file:String(file)})+'\\n');});return w;};require('node:module').syncBuiltinESMExports();`
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
    const query = (sql: string, write = false) =>
      JSON.parse(
        execFileSync(
          electronPath as unknown as string,
          [
            "-e",
            "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:process.argv[3]!=='write'});try{if(process.argv[3]==='write'){d.exec(process.argv[2]);console.log('[]')}else console.log(JSON.stringify(d.prepare(process.argv[2]).all()))}finally{d.close()}",
            path.join(profile, "data/ai-image-manager.db"),
            sql,
            write ? "write" : "read",
          ],
          { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
        )
      );
    const launch = () =>
      launchTestApp(root, {
        executablePath,
        args: [
          "-r",
          preload,
          "--e2e",
          "--lang=zh-CN",
          ...(executablePath ? [] : [path.resolve(".")]),
        ],
        env,
      });
    app = await launch();
    app
      .process()
      .stdout?.on("data", (data) =>
        fs.appendFileSync(path.join(evidence, "main.log"), data)
      );
    app
      .process()
      .stderr?.on("data", (data) =>
        fs.appendFileSync(path.join(evidence, "stderr.log"), data)
      );
    const paths = await app.evaluate(({ app: instance }) =>
      ["userData", "sessionData", "appData", "cache", "temp", "logs"].map(
        (key) => instance.getPath(key as Parameters<typeof instance.getPath>[0])
      )
    );
    save("isolation.json", paths);
    expect(path.resolve(paths[0])).toBe(profile);
    expect(path.resolve(paths[1])).toBe(profile);
    if (!executablePath) {
      // Packaged Electron ignores the development -r isolation preload;
      // bootstrap still isolates persistent application and Chromium data.
      expect(
        paths.every((value) => path.resolve(value).startsWith(root + path.sep))
      ).toBe(true);
    }
    let page = await app.firstWindow();
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, source);
    await page
      .getByRole("button", { name: "添加文件夹", exact: true })
      .first()
      .click();
    await expect(page.locator("[data-photo-id]")).toHaveCount(1);
    await expect
      .poll(
        () =>
          query("select count(*) n from photos where is_ai_processed=1")[0].n,
        { timeout: 120_000 }
      )
      .toBe(1);
    await expect
      .poll(
        () =>
          query(
            "SELECT count(*) n FROM photos WHERE source_hash IS NOT NULL AND source_hash_file_revision = file_revision"
          )[0].n,
        { timeout: 30_000 }
      )
      .toBe(1);
    const originalId = query("SELECT id FROM photos")[0].id;
    query(
      `
      UPDATE photos SET is_favorite=1,is_face_processed=1 WHERE id=${originalId};
      INSERT INTO tags(id,name,created_at) VALUES(900001,'Watcher preserved tag',1);
      INSERT INTO photo_tags(photo_id,tag_id,origin,user_confirmed) VALUES(${originalId},900001,'manual',1);
      INSERT INTO albums(id,name,created_at) VALUES(900001,'Watcher preserved album',1);
      INSERT INTO album_photos(album_id,photo_id) VALUES(900001,${originalId});
      INSERT INTO cull_sessions(id,name,created_at) VALUES(900001,'Watcher preserved review',1);
      INSERT INTO cull_session_photos(id,session_id,photo_id,rating) VALUES(900001,900001,${originalId},1777);
      INSERT INTO face_vectors(id,photo_id,face_index,bbox_x,bbox_y,bbox_width,bbox_height,created_at,content_revision)
      VALUES(900001,${originalId},0,0,0,1,1,1,0);
      INSERT INTO face_identities(id,name,is_confirmed,created_at) VALUES(900001,'Watcher preserved person',1,1);
      INSERT INTO face_identity_members(identity_id,face_vector_id) VALUES(900001,900001);
      INSERT INTO face_review_decisions(photo_id,face_index,decision,source_identity_id,created_at,updated_at,content_revision)
      VALUES(${originalId},0,'confirmed',900001,1,1,0);
      INSERT INTO app_settings(key,value,updated_at) VALUES('ai.autoIndexStopped','true',1) ON CONFLICT(key) DO UPDATE SET value='true',updated_at=1;
    `,
      true
    );
    const expectRelations = () => {
      expect(
        query(`SELECT id,is_favorite FROM photos WHERE id=${originalId}`)
      ).toEqual([{ id: originalId, is_favorite: 1 }]);
      expect(
        query("SELECT photo_id FROM photo_tags WHERE tag_id=900001")
      ).toEqual([{ photo_id: originalId }]);
      expect(
        query("SELECT photo_id FROM album_photos WHERE album_id=900001")
      ).toEqual([{ photo_id: originalId }]);
      expect(
        query(
          "SELECT photo_id,content_revision FROM face_vectors WHERE id=900001"
        )
      ).toEqual([{ photo_id: originalId, content_revision: 0 }]);
      expect(
        query(
          "SELECT identity_id,face_vector_id FROM face_identity_members WHERE identity_id=900001"
        )
      ).toEqual([{ identity_id: 900_001, face_vector_id: 900_001 }]);
      expect(
        query(
          "SELECT photo_id,content_revision FROM face_review_decisions WHERE source_identity_id=900001"
        )
      ).toEqual([{ photo_id: originalId, content_revision: 0 }]);
      expect(
        query(
          "SELECT photo_id,rating,content_revision FROM cull_session_photos WHERE id=900001"
        )
      ).toEqual([{ photo_id: originalId, rating: 1777, content_revision: 0 }]);
    };
    save("before.json", {
      photos: query("select path,folder_id from photos"),
      folders: query("select id,path,parent_id,photo_count from folders"),
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(oldPath, target);
    save("filesystem.json", {
      oldPath,
      target,
      oldExists: fs.existsSync(oldPath),
      targetExists: fs.existsSync(target),
    });
    await expect
      .poll(
        () =>
          query("select path from photos").map(
            (row: { path: string }) => row.path
          ),
        { timeout: 30_000 }
      )
      .toEqual([target]);
    const rows = query(
      "select p.path,f.path folderPath,f.photo_count count,parent.path parentPath from photos p join folders f on p.folder_id=f.id left join folders parent on f.parent_id=parent.id"
    );
    save("after-first-move.json", {
      rows,
      folders: query("select id,path,parent_id,photo_count from folders"),
      body: await page.locator("body").innerText(),
    });
    expect(rows).toEqual([
      {
        path: target,
        folderPath: path.dirname(target),
        count: 1,
        parentPath: path.join(source, "B"),
      },
    ]);
    expect(query("SELECT id FROM photos")).toEqual([{ id: originalId }]);
    expectRelations();
    for (const folderPath of [source, path.join(source, "B")]) {
      const row = page.getByRole("treeitem", { name: folderPath, exact: true });
      await expect(row).toBeVisible();
      if ((await row.getAttribute("aria-expanded")) === "false") {
        await row.press("ArrowRight");
      }
    }
    await page
      .getByRole("treeitem", { name: path.dirname(target), exact: true })
      .click();
    await expect(page.locator("[data-photo-id]")).toHaveCount(1);
    await expect(page.locator("[data-photo-id]")).toHaveAttribute(
      "data-photo-path",
      target
    );
    await expect
      .poll(() =>
        page
          .locator("[data-photo-id] img")
          .evaluateAll(
            (images) =>
              images.length > 0 &&
              images.every(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0
              )
          )
      )
      .toBe(true);
    await page.mouse.move(1100, 700);
    await page.screenshot({
      path: path.join(evidence, "folder-ui.png"),
      animations: "disabled",
    });
    const movedPreview = query(
      `SELECT thumbnail_path FROM photos WHERE id=${originalId}`
    )[0].thumbnail_path;
    const movedPreviewBytes = fs.readFileSync(movedPreview);
    await sharp({
      create: { width: 112, height: 80, channels: 3, background: "#ee201a" },
    })
      .jpeg()
      .toFile(oldPath);
    const escapedOldPath = oldPath.replaceAll("'", "''");
    const replacementSql = `SELECT id,thumbnail_path FROM photos WHERE path='${escapedOldPath}'`;
    await expect
      .poll(() => query(replacementSql).length, { timeout: 30_000 })
      .toBe(1);
    const replacement = query(replacementSql)[0];
    expect(replacement.id).not.toBe(originalId);
    expect(replacement.thumbnail_path).not.toBe(movedPreview);
    const replacementPixels = await sharp(
      fs.readFileSync(replacement.thumbnail_path)
    )
      .raw()
      .toBuffer();
    expect(replacementPixels[0]).toBeGreaterThan(200);
    expect(replacementPixels[1]).toBeLessThan(75);
    expect(fs.readFileSync(movedPreview)).toEqual(movedPreviewBytes);
    expectRelations();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await expect
      .poll(
        () =>
          query("SELECT count(*) AS count FROM folders WHERE is_watching=1")[0]
            .count,
        { timeout: 30_000 }
      )
      .toBeGreaterThan(0);
    const priorRevision = query(
      `SELECT content_revision FROM photos WHERE id=${originalId}`
    )[0].content_revision;
    const overwriteBytes = await sharp({
      create: { width: 144, height: 88, channels: 3, background: "#12da34" },
    })
      .jpeg()
      .toBuffer();
    const replacementFile = path.join(root, "overwrite.jpg");
    fs.writeFileSync(replacementFile, overwriteBytes);
    // Exercise Explorer-style replacement while the application remains open.
    fs.copyFileSync(replacementFile, target);
    await expect
      .poll(
        () =>
          query(
            `SELECT count(*) AS count FROM photos WHERE id=${originalId} AND content_revision>${priorRevision} AND metadata_revision=content_revision AND width=144 AND height=88 AND source_status='available'`
          )[0].count,
        { timeout: 45_000 }
      )
      .toBe(1);
    expectRelations();
    const refreshed = query(
      `SELECT id,content_revision,metadata_revision,embedding_revision,is_ai_processed,is_face_processed,face_refresh_pending,thumbnail_path FROM photos WHERE id=${originalId}`
    )[0];
    expect(refreshed.id).toBe(originalId);
    expect(refreshed.embedding_revision).toBeLessThan(
      refreshed.content_revision
    );
    expect(refreshed.is_ai_processed).toBe(0);
    expect(refreshed.is_face_processed).toBe(0);
    expect(refreshed.face_refresh_pending).toBe(1);
    save("overwrite-status-diagnostic.json", {
      refreshed,
      body: await page.locator("body").innerText(),
      statuses: await page.getByRole("status").evaluateAll((items) =>
        items.map((item) => ({
          text: item.textContent,
          label: item.getAttribute("aria-label"),
        }))
      ),
      language: await page.evaluate(() => localStorage.getItem("lang")),
    });
    expect(
      query("SELECT value FROM app_settings WHERE key='ai.autoIndexStopped'")
    ).toEqual([{ value: "true" }]);
    const { data: pixels, info } = await sharp(
      fs.readFileSync(refreshed.thumbnail_path)
    )
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(144);
    expect(info.height).toBe(88);
    expect(pixels[0]).toBeLessThan(60);
    expect(pixels[1]).toBeGreaterThan(190);
    expect(pixels[2]).toBeLessThan(100);
    save("overwrite-verified.json", {
      ...refreshed,
      preview: {
        width: info.width,
        height: info.height,
        rgb: [...pixels.subarray(0, 3)],
      },
    });
    await expect(
      page.getByRole("status", { name: AUTO_INDEX_STOPPED })
    ).toBeVisible({ timeout: 30_000 });
    expect(query("pragma foreign_key_check")).toEqual([]);
    save("verified.json", {
      uiPhotos: 1,
      secondScan: false,
      reload: false,
      rows,
    });
  } finally {
    await app?.close();
  }
});
