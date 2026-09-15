// Run after npm run package. --full reads AIM_ROUND45_SOURCE (never writes it).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import electronPath from "electron";
import { _electron } from "playwright";
import sharp from "sharp";

const PROTECTED_EXTENSION = /\.(csv|xlsx)$/i;
const full = process.argv.includes("--full");
const id = `round45-${Date.now()}`;
const root = path.resolve(".test-runtime", id);
const evidence = path.resolve("docs/audits", id);
fs.mkdirSync(root, { recursive: true });
fs.mkdirSync(evidence, { recursive: true });
const save = (name, value) =>
  fs.writeFileSync(path.join(evidence, name), JSON.stringify(value, null, 2));
const log = (message) => console.log(new Date().toISOString(), message);
const source = full
  ? path.resolve(process.env.AIM_ROUND45_SOURCE)
  : path.join(root, "fixture");
const expected = full ? 1440 : 150;
if (!full) {
  fs.mkdirSync(source);
  const jpeg = await sharp({
    create: { width: 160, height: 120, channels: 3, background: "#789abc" },
  })
    .withExif({
      IFD0: { Model: "Round45Fixture" },
      IFD2: { ISOSpeedRatings: "200" },
    })
    .jpeg()
    .toBuffer();
  for (let i = 0; i < expected; i++) {
    fs.writeFileSync(
      path.join(source, `fixture-${String(i).padStart(3, "0")}.jpg`),
      jpeg
    );
  }
}
function manifest() {
  return fs.readdirSync(source, { withFileTypes: true }).map((entry) => {
    assert(entry.isFile(), "This regression expects the flat audit library");
    const file = path.join(source, entry.name);
    const stat = fs.statSync(file);
    return {
      path: entry.name,
      size: stat.size,
      mtime: stat.mtimeMs,
      sha256: crypto
        .createHash("sha256")
        .update(fs.readFileSync(file))
        .digest("hex"),
    };
  });
}
const before = manifest();
save("source-before.json", before);
if (full) {
  assert.equal(before.length, 1457);
}
let app;
let page;
let profile;
const env = {
  ...process.env,
  CI: "e2e",
  ELECTRON_RUN_AS_NODE: undefined,
  APPDATA: path.join(root, "appdata"),
  LOCALAPPDATA: path.join(root, "local"),
  TEMP: path.join(root, "scratch"),
  TMP: path.join(root, "scratch"),
};
const preload = path.join(root, "isolation.cjs");
fs.writeFileSync(
  preload,
  `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}for(const key of ['userData','sessionData']){fs.mkdirSync(process.env.AI_IMAGE_MANAGER_USER_DATA_DIR,{recursive:true});app.setPath(key,process.env.AI_IMAGE_MANAGER_USER_DATA_DIR);}`
);
const query = (sql) =>
  JSON.parse(
    execFileSync(
      electronPath,
      [
        "-e",
        "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});try{console.log(JSON.stringify(d.prepare(process.argv[2]).all()));}finally{d.close();}",
        path.join(profile, "data/ai-image-manager.db"),
        sql,
      ],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        maxBuffer: 8 * 1024 * 1024,
      }
    )
  );
async function until(check, timeout = 180_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("Timed out waiting for regression condition");
}
async function launch(name) {
  profile = path.join(root, name);
  app = await _electron.launch({
    args: ["-r", preload, path.resolve(".")],
    env: {
      ...env,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
    },
    timeout: 30_000,
  });
  app
    .process()
    .stderr.on("data", (data) =>
      fs.appendFileSync(path.join(evidence, "stderr.log"), data)
    );
  page = await app.firstWindow();
  page.on("pageerror", (error) =>
    fs.appendFileSync(path.join(evidence, "pageerrors.log"), `${error.stack}\n`)
  );
  await page
    .getByRole("button", { name: "添加文件夹", exact: true })
    .first()
    .waitFor();
  const paths = await app.evaluate(({ app: electronApp }) =>
    Object.fromEntries(
      ["userData", "sessionData", "appData", "cache", "temp", "logs"].map(
        (key) => [key, electronApp.getPath(key)]
      )
    )
  );
  for (const value of Object.values(paths)) {
    assert(path.resolve(value).startsWith(root + path.sep));
  }
  save(`preflight-${name}.json`, paths);
}
async function close() {
  if (app) {
    await app.close();
  }
  app = undefined;
}
let scanStamp;
async function add() {
  scanStamp = query(
    "select last_scanned_at from folders where parent_id is null"
  )[0]?.last_scanned_at;
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, source);
  await page
    .getByRole("button", { name: "添加文件夹", exact: true })
    .first()
    .press("Enter");
}
async function complete() {
  await until(() => {
    const stamp = query(
      "select last_scanned_at from folders where parent_id is null"
    )[0]?.last_scanned_at;
    return stamp != null && stamp !== scanStamp;
  });
  await until(() => query("select count(*) n from photos")[0].n === expected);
  await until(
    () =>
      JSON.parse(
        query(
          "select value from app_settings where key='imports.unfinishedRoots'"
        )[0]?.value ?? "[1]"
      ).length === 0
  );
  await page
    .getByText(`${expected.toLocaleString("en-US")} 张照片`, { exact: true })
    .waitFor({ timeout: 20_000 });
}
function snapshot(name) {
  const rows = query("select id,path,thumbnail_path from photos");
  const result = {
    count: rows.length,
    missing: rows.filter(
      (row) => !(fs.existsSync(row.path) && fs.existsSync(row.thumbnail_path))
    ),
    duplicates: query(
      "select lower(path) p,count(*) n from photos group by lower(path) having count(*)>1"
    ),
    fk: query("pragma foreign_key_check"),
    integrity: query("pragma integrity_check"),
    folders: query("select path,last_scanned_at,photo_count from folders"),
    excluded: before
      .filter(
        (file) => !rows.some((row) => path.basename(row.path) === file.path)
      )
      .map((file) => file.path),
  };
  save(name, result);
  assert.equal(result.count, expected);
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.fk, []);
  assert.equal(result.excluded.length, full ? 17 : 0);
  return result;
}
async function verifyExif(label) {
  const expectedRows = query(
    "select p.id,p.filename from photos p where p.deleted_at is null and p.id in (select photo_id from exif_data where iso>=100 and iso<=400) order by p.file_date desc,p.id desc"
  );
  assert(
    expectedRows.length > 100,
    `Fixture EXIF count was ${expectedRows.length}`
  );
  await page
    .getByRole("button", { name: "EXIF 筛选", exact: true })
    .press("Enter");
  await page.getByPlaceholder("最小 ISO", { exact: true }).fill("100");
  await page.getByPlaceholder("最大 ISO", { exact: true }).fill("400");
  await page
    .getByRole("button", { name: "应用筛选", exact: true })
    .press("Enter");
  await page
    .getByText(`${expectedRows.length} 个结果`, { exact: true })
    .waitFor({ timeout: 20_000 });
  const seen = new Set();
  let rewinds = 0;
  for (
    let attempt = 0;
    attempt < 600 && seen.size < expectedRows.length;
    attempt++
  ) {
    for (const value of await page
      .locator("[data-photo-id]")
      .evaluateAll((elements) =>
        elements.map((element) => Number(element.getAttribute("data-photo-id")))
      )) {
      seen.add(value);
    }
    const expand = page.getByRole("button", {
      name: "展开序列照片",
      exact: true,
    });
    if (await expand.count()) {
      await expand.first().press("Enter");
    } else {
      const rewound = await page
        .locator("[data-masonry-scroll]")
        .evaluate((element) => {
          // Virtualized cards can reflow while thumbnails finish. A single fast
          // downward pass is not an exhaustive reachability check. Revisit from
          // the top at the end, retaining the IDs observed on previous passes.
          if (
            element.scrollTop + element.clientHeight >=
            element.scrollHeight - 1
          ) {
            element.scrollTop = 0;
            return true;
          }
          element.scrollTop += Math.max(100, element.clientHeight * 0.4);
          return false;
        });
      if (rewound) {
        rewinds++;
      }
    }
    await page.waitForTimeout(100);
  }
  const missing = expectedRows.filter((row) => !seen.has(row.id));
  save(`${label}.json`, {
    expected: expectedRows.length,
    rewinds,
    visited: [...seen],
    missing,
    item101: expectedRows[100],
    last: expectedRows.at(-1),
    body: await page.locator("body").innerText(),
  });
  await page.screenshot({ path: path.join(evidence, `${label}.png`) });
  assert.deepEqual(
    missing,
    [],
    "All filtered photos, including #101 and the last, must be reachable through scrolling"
  );
}

async function verifyBrowse() {
  const expectedIds = query(
    "select id from photos where deleted_at is null"
  ).map((row) => row.id);
  const seen = new Set();
  for (
    let attempt = 0;
    attempt < 600 && seen.size < expectedIds.length;
    attempt++
  ) {
    for (const value of await page
      .locator("[data-photo-id]")
      .evaluateAll((elements) =>
        elements.map((element) => Number(element.getAttribute("data-photo-id")))
      )) {
      seen.add(value);
    }
    const expand = page.getByRole("button", {
      name: "展开序列照片",
      exact: true,
    });
    if (await expand.count()) {
      await expand.first().press("Enter");
    } else {
      await page.locator("[data-masonry-scroll]").evaluate((element) => {
        element.scrollTop += Math.max(200, element.clientHeight * 0.7);
      });
    }
    await page.waitForTimeout(100);
  }
  const missing = expectedIds.filter((value) => !seen.has(value));
  save("browse-accessibility.json", {
    expected: expectedIds.length,
    visited: [...seen],
    missing,
  });
  assert.deepEqual(missing, []);
}

async function verifyLayout() {
  const results = [];
  for (const size of [
    [720, 480],
    [900, 600],
    [1280, 800],
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, dimensions) =>
        BrowserWindow.getAllWindows()[0].setSize(...dimensions),
      size
    );
    await page.waitForTimeout(300);
    await page
      .getByRole("button", { name: "EXIF 筛选", exact: true })
      .press("Enter");
    const panel = page.locator('[data-overlay-kind="search-filter"]');
    await panel.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const bounds = await panel.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        viewport: [innerWidth, innerHeight],
        scrollWidth: document.documentElement.scrollWidth,
        overlay: {
          x: rect.x,
          y: rect.y,
          right: rect.right,
          bottom: rect.bottom,
        },
      };
    });
    results.push({ requested: size, ...bounds });
    assert(bounds.scrollWidth <= bounds.viewport[0] + 1);
    assert(
      bounds.overlay.x >= -1 && bounds.overlay.right <= bounds.viewport[0] + 1
    );
    assert(
      bounds.overlay.y >= -1 && bounds.overlay.bottom <= bounds.viewport[1] + 1
    );
    await page.screenshot({
      path: path.join(evidence, `layout-${size.join("x")}.png`),
    });
    await page
      .getByRole("button", { name: "EXIF 筛选", exact: true })
      .press("Enter");
  }
  save("layout.json", results);
}
try {
  log(`Evidence: ${evidence}`);
  await launch("interrupted");
  await app.evaluate(({ app: electronApp, BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    let interrupted = false;
    contents.send = (channel, ...args) => {
      send(channel, ...args);
      if (
        !interrupted &&
        channel === "scan-progress" &&
        args[0].phase === "indexing" &&
        args[0].scanned >= 50
      ) {
        interrupted = true;
        electronApp.quit();
      }
    };
  });
  const exited = app.waitForEvent("close");
  await add();
  await exited;
  app = undefined;
  const partial = query("select count(*) n from photos")[0].n;
  save("interrupted.json", { partial, expected });
  assert(partial > 0 && partial < expected);
  log(`Interrupted at ${partial}; restarting`);
  await launch("interrupted");
  await complete();
  snapshot("recovered.json");
  await close();
  await launch("normal");
  await add();
  await complete();
  snapshot("normal.json");
  await verifyBrowse();
  log("Normal scan complete; repeating scan");
  await add();
  await complete();
  snapshot("second-scan.json");
  await verifyExif("exif-before-restart");
  await close();
  await launch("normal");
  snapshot("restart.json");
  await verifyExif("exif-after-restart");
  await verifyLayout();
  save("result.json", { success: true, expected, full });
  log("PASS");
} catch (error) {
  save("failure.json", {
    message: String(error),
    stack: error.stack,
    body:
      page && !page.isClosed()
        ? await page
            .locator("body")
            .innerText()
            .catch(() => "")
        : "",
  });
  throw error;
} finally {
  await close();
  const after = manifest();
  save("source-after.json", after);
  assert.deepEqual(after, before, "Source files changed");
  // Verify ownership and protected entries before removing only this run.
  assert.equal(path.dirname(root), path.resolve(".test-runtime"));
  const protectedEntry = fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .find(
      (entry) =>
        PROTECTED_EXTENSION.test(entry.name) ||
        (entry.isDirectory() && entry.name.toLowerCase() === "temp")
    );
  assert(!protectedEntry, "Protected test entry must be retained");
  fs.rmSync(root, { recursive: true, force: true });
  save("cleanup.json", {
    root,
    absent: !fs.existsSync(root),
    originalCount: before.length,
    sourceUnchanged: true,
  });
}
