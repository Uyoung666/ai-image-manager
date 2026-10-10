import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electronPath = createRequire(import.meta.url)("electron") as string;
const PHOTO_MODE = /^Photos$/;
const SEQUENCE_MODE = /^Sequences/;
const SMART_LINK = /^AlbumSmartFixture/;
const LAST_LINK = /^AlbumLastFixture/;
const TAG = "AlbumRefreshTag";
const LAST_TAG = "AlbumLastTag";
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];

let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

function query(sql: string, write = false) {
  return JSON.parse(
    execFileSync(
      electronPath,
      [
        "-e",
        "const D=require('better-sqlite3');const d=new D(process.argv[1]);const sql=require('node:fs').readFileSync(0,'utf8');try{if(process.argv[2]==='write'){d.exec(sql);console.log('[]')}else{console.log(JSON.stringify(d.prepare(sql).all()))}}finally{d.close()}",
        path.join(profile, "data", "ai-image-manager.db"),
        write ? "write" : "read",
      ],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        input: sql,
      }
    )
  );
}

async function launch(size = SIZES[0]) {
  app = await launchTestApp(root, {
    args: ["-r", path.join(root, "isolation.cjs"), "--e2e", path.resolve(".")],
    env,
  });
  page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, requested) => {
    BrowserWindow.getAllWindows()[0].setContentSize(
      requested.width,
      requested.height
    );
  }, size);
  await page.addInitScript(() => localStorage.setItem("lang", "en"));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
}

async function navigate(route: string) {
  await page.evaluate((next) => window.__e2eNavigate?.(next), route);
  await page.locator("main").first().waitFor();
}

async function assertBounds() {
  expect(
    await page.evaluate(() => {
      const overflow = [
        document.documentElement,
        document.body,
        ...document.querySelectorAll("main"),
      ].some((element) => element.scrollWidth > element.clientWidth + 2);
      const escaped = [
        ...document.querySelectorAll('[role="dialog"], [role="menu"]'),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .some((element) => {
          const rect = element.getBoundingClientRect();
          return (
            rect.left < -1 ||
            rect.top < -1 ||
            rect.right > innerWidth + 1 ||
            rect.bottom > innerHeight + 1
          );
        });
      return { overflow, escaped };
    })
  ).toEqual({ overflow: false, escaped: false });
}

async function removeTag(photoId: number, tag: string, count: number) {
  await page.locator(`[data-photo-id="${photoId}"][role="option"]`).click();
  const remove = page
    .getByRole("button", { name: "Click to remove", exact: true })
    .filter({ hasText: tag });
  await expect(remove).toBeVisible();
  await assertBounds();
  await remove.click();
  await expect(
    page.getByText(`Smart matched ${count} photos`, { exact: true })
  ).toBeVisible();
  await expect(
    page.locator(`[data-photo-id="${photoId}"][role="option"]`)
  ).toHaveCount(0);
  // The closing inspector retains cached DOM for its transition.
  await expect
    .poll(() =>
      page
        .locator(".photo-detail-panel-shell")
        .evaluate((element) => element.getBoundingClientRect().width)
    )
    .toBe(0);
  await expect(
    page.locator('[data-photo-id][aria-selected="true"]')
  ).toHaveCount(0);
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  root = createTestRuntime("album-tag-refresh");
  profile = path.join(root, "profile");
  fs.writeFileSync(
    path.join(root, "isolation.cjs"),
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
  );
  env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  await launch();
  await app.close();

  const fixture = path.join(root, "fixture");
  fs.mkdirSync(fixture);
  const sqlEscape = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${sqlEscape(fixture)}','AlbumFixture',4,1)`,
  ];
  for (let id = 1; id <= 4; id++) {
    const photoPath = path.join(fixture, `AlbumFixture-${id}.png`);
    await sharp({
      create: {
        width: 160,
        height: 100,
        channels: 3,
        background: { r: id * 40, g: 100, b: 180 },
      },
    })
      .png()
      .toFile(photoPath);
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${sqlEscape(photoPath)}','AlbumFixture-${id}.png',1,1024,${id},160,100,'png','${sqlEscape(photoPath)}',1,1,1,1)`
    );
  }
  statements.push(
    "INSERT INTO photo_sequences(id,folder_id,type,source,representative_photo_id,started_at,ended_at,frame_count,user_locked,created_at,updated_at) VALUES(1,1,'burst','manual',1,1,2,2,1,1,1)",
    "INSERT INTO photo_sequence_members(sequence_id,photo_id,position) VALUES(1,1,0),(1,2,1)",
    `INSERT INTO tags(id,name,created_at) VALUES(1,'${TAG}',1),(2,'${LAST_TAG}',1)`,
    "INSERT INTO albums(id,name,cover_photo_id,created_at) VALUES(9001,'AlbumManualFixture',4,1)",
    "INSERT INTO album_photos(album_id,photo_id) SELECT 9001,id FROM photos"
  );
  for (const [id, name, tag] of [
    [9002, "AlbumSmartFixture", TAG],
    [9003, "AlbumLastFixture", LAST_TAG],
  ] as const) {
    const rules = JSON.stringify({
      rules: [{ type: "tags", operator: "包含任一", value: [tag] }],
    });
    statements.push(
      `INSERT INTO albums(id,name,is_smart,smart_rules,created_at) VALUES(${id},'${name}',1,'${rules}',1)`
    );
  }
  query(statements.join(";"), true);
});

test.afterEach(async () => {
  await app?.close();
});

for (const size of SIZES) {
  test(`${size.width}x${size.height} cold albums and immediate tag/cover refresh`, async () => {
    query(
      "DELETE FROM photo_tags; INSERT INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) SELECT id,1,1,'manual',1 FROM photos; INSERT INTO photo_tags(photo_id,tag_id,is_confirmed,origin,user_confirmed) VALUES(4,2,1,'manual',1)",
      true
    );

    // Each cold launch opens an existing album before visiting the album list.
    await launch(size);
    await navigate("/albums/9001");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    await expect(page.locator('[data-photo-id][role="option"]')).toHaveCount(2);
    await page.getByRole("button", { name: SEQUENCE_MODE }).click();
    await expect(page.locator('[data-sequence-id="1"]')).toBeVisible();
    await assertBounds();
    await app.close();

    await launch(size);
    await navigate("/albums/9002");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    await expect(page.locator('[data-photo-id][role="option"]')).toHaveCount(2);
    await page.getByRole("button", { name: SEQUENCE_MODE }).click();
    await expect(page.locator('[data-sequence-id="1"]')).toBeVisible();
    await page.getByRole("button", { name: PHOTO_MODE }).click();

    await navigate("/albums");
    const cover = page.getByRole("img", {
      name: "AlbumSmartFixture",
      exact: true,
    });
    await expect(cover).toBeVisible();
    const originalCover = await cover.getAttribute("src");

    // Removing a non-cover member keeps the most recent matching cover.
    await page.getByRole("link", { name: SMART_LINK }).click();
    await removeTag(3, TAG, 3);
    await navigate("/albums");
    await expect(cover).toHaveAttribute("src", originalCover ?? "");

    // Removing the cover immediately promotes the newest remaining sequence frame.
    await page.getByRole("link", { name: SMART_LINK }).click();
    await removeTag(4, TAG, 2);
    await page.getByRole("button", { name: SEQUENCE_MODE }).click();
    await expect(page.locator('[data-sequence-id="1"]')).toBeVisible();
    await navigate("/albums");
    await expect(cover).toBeVisible();
    await expect(cover).not.toHaveAttribute("src", originalCover ?? "");

    // The same tag edits never remove members from a normal album.
    await navigate("/albums/9001");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    await expect(page.locator('[data-photo-id][role="option"]')).toHaveCount(2);

    // Exercise the Sidebar's batched drag/drop writer and its one completion event.
    await navigate("/");
    const expand = page.getByRole("button", {
      name: "Expand sidebar",
      exact: true,
    });
    if (await expand.isVisible()) {
      await expand.click();
    }
    const sidebar = page.locator('[data-surface="sidebar-shell"]');
    await sidebar.getByRole("button", { name: "Tags", exact: true }).click();
    const target = sidebar.locator('[data-tag-id="1"] button').last();
    await expect(target).toBeVisible();
    await page.evaluate(() => {
      window.addEventListener(
        "tags-changed",
        () => {
          document.body.dataset.albumTagNotifications = String(
            Number(document.body.dataset.albumTagNotifications ?? 0) + 1
          );
        },
        { once: true }
      );
    });
    await target.evaluate((element) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.setData("application/x-photo-ids", JSON.stringify([3, 4]));
      element.dispatchEvent(
        new DragEvent("drop", { bubbles: true, dataTransfer })
      );
    });
    await expect(page.locator("body")).toHaveAttribute(
      "data-album-tag-notifications",
      "1"
    );
    await navigate("/albums/9002");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    await expect(
      page.getByText("Smart matched 4 photos", { exact: true })
    ).toBeVisible();
    await expect(
      page.locator('[data-photo-id="4"][role="option"]')
    ).toBeVisible();

    // Verify main-process completion events actually cross the preload bridge.
    await page.evaluate(() => {
      window.addEventListener("message", (event) => {
        if (event.source === window && event.data?.channel === "ai-tags-done") {
          document.body.dataset.albumAiTagsDone = "received";
        }
      });
    });
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("ai-tags-done");
    });
    await expect(page.locator("body")).toHaveAttribute(
      "data-album-ai-tags-done",
      "received"
    );
    await expect(
      page.getByText("Smart matched 4 photos", { exact: true })
    ).toBeVisible();

    await navigate("/albums/9003");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    await removeTag(4, LAST_TAG, 0);
    await navigate("/albums");
    await expect(page.getByRole("link", { name: LAST_LINK })).toBeVisible();
    await expect(
      page.getByRole("img", { name: "AlbumLastFixture", exact: true })
    ).toHaveCount(0);
    await assertBounds();
    await page.screenshot({
      path: test.info().outputPath("album-covers-refreshed.png"),
    });
  });
}
