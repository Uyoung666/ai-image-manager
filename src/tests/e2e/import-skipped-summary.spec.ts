import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
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
const PROTECTED_EXTENSION = /\.(csv|xlsx)$/i;

test("mixed media import explains skipped files and survives restart", async () => {
  test.setTimeout(180_000);
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "round46-batch-a-"));
  const fixture = path.join(root, "fixture");
  const profile = path.join(root, "profile");
  fs.mkdirSync(fixture);
  let app: ElectronApplication | undefined;
  const requireApp = () => {
    assert(app);
    return app;
  };
  try {
    for (let group = 0; group < 2; group++) {
      const pixels = Buffer.alloc(96 * 64 * 3);
      let seed = group + 17;
      for (let i = 0; i < pixels.length; i++) {
        seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        pixels[i] = Math.floor(seed / 16_777_216);
      }
      const png = await sharp(pixels, {
        raw: { width: 96, height: 64, channels: 3 },
      })
        .png()
        .toBuffer();
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(fixture, `group-${group}-${i}.png`), png);
      }
    }
    fs.writeFileSync(
      path.join(fixture, "invalid-a.jpg"),
      "Image does not exist\n"
    );
    fs.writeFileSync(path.join(fixture, "invalid-b.jpg"), "not a jpeg");
    fs.writeFileSync(
      path.join(fixture, "corrupt.png"),
      Buffer.from([137, 80, 78, 71])
    );
    const preload = path.join(root, "isolation.cjs");
    fs.writeFileSync(
      preload,
      `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
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
          electronPath,
          [
            "-e",
            "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});try{console.log(JSON.stringify(d.prepare(process.argv[2]).all()));}finally{d.close();}",
            path.join(profile, "data/ai-image-manager.db"),
            sql,
          ],
          { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
        )
      );
    const launch = async () => {
      app = await _electron.launch({
        args: ["-r", preload, "--e2e", path.resolve(".")],
        env,
      });
      const paths = await app.evaluate(({ app: instance }) =>
        ["userData", "sessionData", "appData", "cache", "temp", "logs"].map(
          (key) =>
            instance.getPath(key as Parameters<typeof instance.getPath>[0])
        )
      );
      expect(
        paths.every((value) => path.resolve(value).startsWith(root + path.sep))
      ).toBe(true);
      const page = await app.firstWindow();
      await page
        .getByRole("button", { name: "添加文件夹", exact: true })
        .first()
        .waitFor();
      return page;
    };
    let page = await launch();
    await requireApp().evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, fixture);
    await page
      .getByRole("button", { name: "添加文件夹", exact: true })
      .first()
      .press("Enter");
    await expect(
      page.getByText(
        "扫描完成：10 张照片已在图库中（新增 10 张）；跳过 3 个文件，处理失败 0 个。",
        { exact: true }
      )
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      page.getByText(
        "未加入的文件可能无法解码或读取，或处理写入失败；可读取的照片已保留，原文件未删除。",
        { exact: true }
      )
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("mixed-summary.png"),
    });
    expect(query("select count(*) n from photos")[0].n).toBe(10);
    expect(
      query(
        "select filename from photos where filename like 'invalid%' or filename='corrupt.png'"
      )
    ).toEqual([]);
    for (const row of query("select path,thumbnail_path from photos")) {
      expect(fs.existsSync(row.path) && fs.existsSync(row.thumbnail_path)).toBe(
        true
      );
    }
    await requireApp().close();
    app = undefined;
    page = await launch();
    await expect(page.getByText("10 张照片", { exact: true })).toBeVisible();
    expect(query("select count(*) n from photos")[0].n).toBe(10);
    expect(query("pragma foreign_key_check")).toEqual([]);
  } finally {
    await app?.close();
    assert.equal(path.dirname(root), base);
    const protectedEntry = fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .find(
        (entry) =>
          PROTECTED_EXTENSION.test(entry.name) ||
          (entry.isDirectory() && entry.name.toLowerCase() === "temp") ||
          entry.isSymbolicLink()
      );
    assert.equal(protectedEntry, undefined);
    fs.rmSync(root, { recursive: true, force: true });
    fs.writeFileSync(
      test.info().outputPath("cleanup.json"),
      JSON.stringify({ root, exists: fs.existsSync(root) }, null, 2)
    );
    await test.info().attach("cleanup", {
      body: JSON.stringify({ root, exists: fs.existsSync(root) }),
      contentType: "application/json",
    });
  }
});
