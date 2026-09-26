import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
const CLEANUP_BUTTON = /清理全部待处理/;
const CLEANUP_RESTORE_BUTTON = /^撤销清理批次/;
const IGNORED_TAB = /^已忽略/;
const ACTIVE_TAB = /^全部待处理/;

test("mixed media summary, restart, and cleanup session exclusions", async () => {
  test.setTimeout(240_000);
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
      for (let i = 0; i < (group === 0 ? 10 : 4); i++) {
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
        args: ["-r", preload, "--e2e", "--lang=zh-CN", path.resolve(".")],
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
    const originalHashes = new Map(
      fs.readdirSync(fixture).map((name) => [
        name,
        createHash("sha256")
          .update(fs.readFileSync(path.join(fixture, name)))
          .digest("hex"),
      ])
    );
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
        "扫描完成：14 张照片已在图库中（新增 14 张）；跳过 3 个文件，处理失败 0 个。",
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
    expect(query("select count(*) n from photos")[0].n).toBe(14);
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
    await expect(page.getByText("14 张照片", { exact: true })).toBeVisible();
    expect(query("select count(*) n from photos")[0].n).toBe(14);
    await page
      .getByRole("button", { name: "重复照片检测", exact: true })
      .click();
    await expect(page.locator("article")).toHaveCount(2);
    for (const [width, height] of [
      [720, 480],
      [900, 600],
      [1280, 800],
    ]) {
      await requireApp().evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
        { width, height }
      );
      await expect
        .poll(() => page.evaluate(() => innerWidth))
        .toBeGreaterThanOrEqual(width - 2);
      await expect
        .poll(() => page.evaluate(() => innerWidth))
        .toBeLessThanOrEqual(width + 2);
      const main = page.locator("main").last();
      await main.evaluate((el) => {
        el.scrollTop = 100;
      });
      const before = await main.boundingBox();
      const scroll = await main.evaluate((el) => el.scrollTop);
      await page.evaluate(() => {
        const original = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (
          this: MessagePort,
          message: unknown,
          transfer?: Transferable[] | StructuredSerializeOptions
        ) {
          MessagePort.prototype.postMessage = original;
          setTimeout(() => {
            if (Array.isArray(transfer)) {
              original.call(this, message, { transfer });
            } else {
              original.call(this, message, transfer);
            }
          }, 1500);
        };
      });
      await page.getByRole("button", { name: "重新扫描", exact: true }).click();
      const status = page.getByRole("status").filter({
        has: page.getByRole("button", { name: "取消", exact: true }),
      });
      await expect(status).toBeVisible();
      expect(await main.boundingBox()).toEqual(before);
      expect(await main.evaluate((el) => el.scrollTop)).toBe(scroll);
      await expect(status).not.toBeVisible();
      expect(await main.boundingBox()).toEqual(before);
      expect(await main.evaluate((el) => el.scrollTop)).toBe(scroll);
    }
    const firstGroup = page
      .locator("article")
      .filter({ has: page.getByText("group-0-0.png", { exact: true }) });
    const secondGroup = page
      .locator("article")
      .filter({ has: page.getByText("group-1-0.png", { exact: true }) });
    await firstGroup
      .getByRole("button", { name: "忽略整组", exact: true })
      .click();
    await page.getByRole("button", { name: IGNORED_TAB }).click();
    await expect(
      firstGroup.getByRole("button", {
        name: "group-0-0.png 保留",
        exact: true,
      })
    ).toBeDisabled();
    await firstGroup
      .getByRole("button", { name: "取消忽略", exact: true })
      .click();
    await page.getByRole("button", { name: ACTIVE_TAB }).click();
    await expect(
      firstGroup.getByRole("button", {
        name: "group-0-0.png 保留",
        exact: true,
      })
    ).toBeEnabled();
    await firstGroup
      .getByRole("combobox", { name: "按数量选择保留" })
      .fill("3");
    await firstGroup
      .getByRole("button", { name: "应用数量", exact: true })
      .click();
    await expect(
      firstGroup.getByText("保留 3 · 删除 7 · 待决定 0", { exact: true })
    ).toBeVisible();
    const decisionRow = firstGroup.locator("fieldset").first();
    const initialDecisionHeight = (await decisionRow.boundingBox())?.height;
    for (const label of ["删除", "待决定", "保留"]) {
      const button = firstGroup.getByRole("button", {
        name: `group-0-0.png ${label}`,
        exact: true,
      });
      await expect(button).toBeEnabled();
      const opacity = await button.evaluate(
        (el) => getComputedStyle(el).opacity
      );
      await button.click();
      expect(await button.evaluate((el) => getComputedStyle(el).opacity)).toBe(
        opacity
      );
      expect((await decisionRow.boundingBox())?.height).toBe(
        initialDecisionHeight
      );
      await expect(button).toHaveAttribute("aria-pressed", "true");
      await expect(button).toBeEnabled();
      expect((await decisionRow.boundingBox())?.height).toBe(
        initialDecisionHeight
      );
    }
    await firstGroup
      .getByRole("button", { name: "确认清理此组", exact: true })
      .click();
    await expect(
      firstGroup.getByRole("button", { name: "移出待清理", exact: true })
    ).toBeVisible();
    await secondGroup
      .getByRole("combobox", { name: "按数量选择保留" })
      .fill("4");
    await secondGroup
      .getByRole("button", { name: "应用数量", exact: true })
      .click();
    await expect(
      secondGroup.getByText("保留 4 · 删除 0 · 待决定 0", { exact: true })
    ).toBeVisible();
    await secondGroup
      .getByRole("combobox", { name: "按数量选择保留" })
      .fill("2");
    await secondGroup
      .getByRole("button", { name: "应用数量", exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "应用数量", exact: true })
      .click();
    await expect(
      secondGroup.getByText("保留 2 · 删除 2 · 待决定 0", { exact: true })
    ).toBeVisible();
    await secondGroup
      .getByRole("button", { name: "确认清理此组", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "清理全部待处理 9 张", exact: true })
    ).toBeEnabled();
    const sizes: Array<{ width: number; height: number; scroll: number }> = [];
    for (const [width, height] of [
      [720, 480],
      [900, 600],
      [1280, 800],
    ]) {
      await requireApp().evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
        { width, height }
      );
      await expect
        .poll(() => page.evaluate(() => innerWidth))
        .toBeGreaterThanOrEqual(width - 2);
      await expect
        .poll(() => page.evaluate(() => innerWidth))
        .toBeLessThanOrEqual(width + 2);
      await expect
        .poll(() =>
          page.evaluate(() =>
            Math.abs(window.innerWidth - document.documentElement.scrollWidth)
          )
        )
        .toBeLessThanOrEqual(2);
      const bounds = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
        scroll: document.documentElement.scrollWidth,
      }));
      sizes.push(bounds);
      for (const main of await page.locator("main").all()) {
        const box = await main.boundingBox();
        if (box) {
          expect(box.x).toBeGreaterThanOrEqual(-2);
          expect(box.x + box.width).toBeLessThanOrEqual(bounds.width + 2);
        }
      }
      await expect(
        page.getByRole("button", { name: "清理全部待处理 9 张", exact: true })
      ).toBeEnabled();
      await page.getByRole("button", { name: CLEANUP_BUTTON }).click();
      const dialog = page.getByRole("alertdialog");
      await expect(dialog).toBeVisible();
      const dialogBox = await dialog.boundingBox();
      assert(dialogBox);
      expect(dialogBox.x).toBeGreaterThanOrEqual(0);
      expect(dialogBox.y).toBeGreaterThanOrEqual(0);
      expect(dialogBox.x + dialogBox.width).toBeLessThanOrEqual(
        bounds.width + 2
      );
      expect(dialogBox.y + dialogBox.height).toBeLessThanOrEqual(
        bounds.height + 2
      );
      await dialog.getByRole("button", { name: "取消", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(
        page.getByRole("combobox", { name: "检测敏感度" })
      ).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath(`cleanup-${width}.png`),
      });
    }
    await page.getByRole("button", { name: CLEANUP_BUTTON }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "移入最近删除", exact: true })
      .click();
    await expect
      .poll(
        () =>
          query("select count(*) n from photos where deleted_at is not null")[0]
            .n
      )
      .toBe(9);
    const missingPath = query(
      "select path from photos where deleted_at is not null order by id limit 1"
    )[0].path;
    const parkedPath = path.join(root, "parked.png");
    fs.renameSync(missingPath, parkedPath);
    await requireApp().close();
    app = undefined;
    page = await launch();
    await page.getByRole("button", { name: "最近删除", exact: true }).click();
    await page.getByText("清理批次与恢复（1）", { exact: true }).click();
    await page.getByRole("button", { name: CLEANUP_RESTORE_BUTTON }).click();
    await expect
      .poll(
        () =>
          query("select count(*) n from photos where deleted_at is not null")[0]
            .n
      )
      .toBe(1);
    await expect(
      page.getByRole("alert").filter({ hasText: "原文件" })
    ).toBeVisible();
    const recoveryDialog = page.getByRole("dialog");
    await expect(
      recoveryDialog.getByText(path.basename(missingPath), { exact: true })
    ).toBeVisible();
    expect(await recoveryDialog.textContent()).not.toContain("&#x2F;");
    for (const [width, height] of [
      [720, 480],
      [900, 600],
      [1280, 800],
    ]) {
      await requireApp().evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
        { width, height }
      );
      await expect
        .poll(() => page.evaluate(() => innerWidth))
        .toBeLessThanOrEqual(width + 2);
      const box = await recoveryDialog.boundingBox();
      assert(box);
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 2);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 2);
      await page.screenshot({
        path: test.info().outputPath(`recovery-${width}.png`),
      });
    }
    await page.keyboard.press("Escape");
    await expect(recoveryDialog).not.toBeVisible();
    await page
      .getByRole("button", { name: "清理批次与恢复（1）", exact: true })
      .click();
    await expect(
      recoveryDialog.getByText(path.basename(missingPath), { exact: true })
    ).toBeVisible();
    fs.renameSync(parkedPath, missingPath);
    await page.getByRole("button", { name: CLEANUP_RESTORE_BUTTON }).click();
    await expect
      .poll(
        () =>
          query("select count(*) n from photos where deleted_at is not null")[0]
            .n
      )
      .toBe(0);
    for (const [name, hash] of originalHashes) {
      expect(
        createHash("sha256")
          .update(fs.readFileSync(path.join(fixture, name)))
          .digest("hex")
      ).toBe(hash);
    }
    expect(
      query(
        "select count(*) n from duplicate_review_members where decision='DELETE'"
      )[0].n
    ).toBe(0);
    expect(query("pragma foreign_key_check")).toEqual([]);
    fs.writeFileSync(
      test.info().outputPath("accounting.json"),
      JSON.stringify(
        {
          candidates: 17,
          valid: 14,
          skipped: 3,
          failed: 0,
          softDeletedCopies: 9,
          sizes,
        },
        null,
        2
      )
    );
    await test.info().attach("accounting", {
      body: JSON.stringify({
        candidates: 17,
        valid: 14,
        skipped: 3,
        failed: 0,
        softDeletedCopies: 9,
        sizes,
      }),
      contentType: "application/json",
    });
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
