import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  expect,
  test,
} from "@playwright/test";
import electronPath from "electron";
import sharp from "sharp";

const PROTECTED_EXTENSION = /\.(csv|xlsx)$/i;
test("first move into a new directory updates filesystem, database, folder tree and UI", async () => {
  test.setTimeout(180_000);
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "f04-e2e-"));
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
    const query = (sql: string) =>
      JSON.parse(
        execFileSync(
          electronPath as unknown as string,
          [
            "-e",
            "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});try{console.log(JSON.stringify(d.prepare(process.argv[2]).all()))}finally{d.close()}",
            path.join(profile, "data/ai-image-manager.db"),
            sql,
          ],
          { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
        )
      );
    app = await _electron.launch({
      args: ["-r", preload, "--e2e", path.resolve(".")],
      env,
    });
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
    expect(
      paths.every((value) => path.resolve(value).startsWith(root + path.sep))
    ).toBe(true);
    save("isolation.json", paths);
    const page = await app.firstWindow();
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
    expect(query("pragma foreign_key_check")).toEqual([]);
    save("verified.json", {
      uiPhotos: 1,
      secondScan: false,
      reload: false,
      rows,
    });
  } finally {
    await app?.close();
    assert.equal(path.dirname(root), base);
    assert.equal(
      fs
        .readdirSync(root, { recursive: true, withFileTypes: true })
        .find(
          (entry) =>
            PROTECTED_EXTENSION.test(entry.name) ||
            (entry.isDirectory() && entry.name.toLowerCase() === "temp") ||
            entry.isSymbolicLink()
        ),
      undefined
    );
    fs.rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
    save("cleanup.json", { root, exists: fs.existsSync(root) });
  }
});
