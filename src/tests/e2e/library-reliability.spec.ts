import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import electronPath from "electron";
import sharp from "sharp";
import { preparePackagedExecutable } from "./helpers/packaged-inspection";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
  { width: 900, height: 600, zoomFactor: 1.25 },
  { width: 1280, height: 800, zoomFactor: 1.5 },
];
const PRE_RELIABILITY_MIGRATION = 61;
const MISSING_STATUS = /^Missing(?:\s|$)/;
const WEAK_EVIDENCE = /content unverified/;
const LIBRARY_ATTENTION = /photos have disconnected sources/;
const REMOVE_MISSING = "Remove missing record";
const CACHE_CLEARED = /^Cleared [1-9]\d* cached files and freed /;
const REVIEW_NOT_READY = /photos are not ready/;

function stageHistoricalMigrations(root: string): string {
  const target = path.join(root, "historical-migrations");
  const journal = JSON.parse(
    fs.readFileSync("drizzle/meta/_journal.json", "utf8")
  ) as { entries: Array<{ idx: number; tag: string }> };
  journal.entries = journal.entries.filter(
    ({ idx }) => idx <= PRE_RELIABILITY_MIGRATION
  );
  fs.mkdirSync(path.join(target, "meta"), { recursive: true });
  fs.writeFileSync(
    path.join(target, "meta", "_journal.json"),
    JSON.stringify(journal)
  );
  for (const { tag } of journal.entries) {
    fs.copyFileSync(
      path.join("drizzle", `${tag}.sql`),
      path.join(target, `${tag}.sql`)
    );
  }
  return target;
}

async function expectViewportBounds(page: Page) {
  expect(
    await page.evaluate(() => {
      const visible = [
        ...document.querySelectorAll<HTMLElement>(
          "main, [role=dialog], [role=alertdialog], [data-slot=popover-content], [role=menu], [data-surface=settings-panel]"
        ),
      ].filter((element) => {
        const bounds = element.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0;
      });
      return {
        overflow: document.documentElement.scrollWidth > innerWidth + 1,
        dialogOverflow: visible
          .filter((element) =>
            element.matches(
              '[data-slot="dialog-content"], [role="alertdialog"], [data-surface="settings-panel"]'
            )
          )
          .some((element) => element.scrollWidth > element.clientWidth + 1),
        controlsInside: visible
          .filter((element) =>
            element.matches(
              '[data-slot="dialog-content"], [role="alertdialog"], [data-surface="settings-panel"]'
            )
          )
          .every((dialog) => {
            const bounds = dialog.getBoundingClientRect();
            return [
              ...dialog.querySelectorAll<HTMLElement>(
                'button, input[role="combobox"]'
              ),
            ]
              .filter((element) => element.getClientRects().length > 0)
              .every((element) => {
                const control = element.getBoundingClientRect();
                return (
                  control.left >= bounds.left - 1 &&
                  control.right <= bounds.right + 1
                );
              });
          }),
        inside: visible
          .filter(
            (element) => !element.matches('[data-surface="settings-panel"]')
          )
          .every((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.left >= -1 &&
              bounds.top >= -1 &&
              bounds.right <= innerWidth + 1 &&
              bounds.bottom <= innerHeight + 1
            );
          }),
      };
    })
  ).toEqual({
    overflow: false,
    dialogOverflow: false,
    controlsInside: true,
    inside: true,
  });
}

async function captureWindow(app: ElectronApplication, filename: string) {
  const window = await app.firstWindow();
  await window.evaluate(async () => {
    const animations = document
      .getAnimations()
      .filter(
        (animation) =>
          animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY
      );
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
  // Electron zoom changes CSS pixels. Capture the full native client area.
  const screenshot = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage();
    return image.toPNG().toString("base64");
  });
  fs.writeFileSync(
    test.info().outputPath(filename),
    Buffer.from(screenshot, "base64")
  );
}

test("retains an offline catalogue, relinks its folder and explicitly removes a missing record", async () => {
  test.setTimeout(240_000);
  const root = createTestRuntime("library-reliability");
  const evidence = test.info().outputDir;
  fs.mkdirSync(evidence, { recursive: true });
  const executablePath = await preparePackagedExecutable(root, evidence);
  const profile = path.join(root, "profile");
  const oldRoot = path.join(root, "disconnected-photos");
  const newRoot = path.join(root, "reconnected-photos");
  const oldPhoto = path.join(oldRoot, "photo.jpg");
  const newPhoto = path.join(newRoot, "photo.jpg");
  fs.mkdirSync(newRoot);
  const bytes = await sharp({
    create: { width: 160, height: 100, channels: 3, background: "#387f99" },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(newPhoto, bytes);
  const preload = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    preload,
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',userData:'profile',sessionData:'profile',cache:'cache',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
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
      executablePath,
      args: [
        "-r",
        preload,
        "--e2e",
        "--lang=en-US",
        ...(executablePath
          ? []
          : [process.env.AIM_LIBRARY_E2E_ENTRY ?? path.resolve(".")]),
      ],
      env,
    });
  const dbPath = path.join(profile, "data", "ai-image-manager.db");
  const query = (sql: string, migrations?: string | true, database = dbPath) =>
    JSON.parse(
      execFileSync(
        electronPath as unknown as string,
        [
          "-e",
          "const D=require('better-sqlite3');const db=new D(process.argv[1]);const sql=require('node:fs').readFileSync(0,'utf8');try{if(process.argv[2]){if(process.argv[2]!=='--write'){const {drizzle}=require('drizzle-orm/better-sqlite3');const {migrate}=require('drizzle-orm/better-sqlite3/migrator');migrate(drizzle(db),{migrationsFolder:process.argv[2]})}db.exec(sql);console.log('[]')}else console.log(JSON.stringify(db.prepare(sql).all()))}finally{db.close()}",
          database,
          ...(migrations ? [migrations === true ? "--write" : migrations] : []),
        ],
        {
          env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
          encoding: "utf8",
          input: sql,
        }
      )
    );
  const escapeSql = (text: string) => text.replaceAll("'", "''");
  const expectPreservedRelations = () => {
    expect(query("SELECT id,is_favorite FROM photos WHERE id=1")).toEqual([
      { id: 1, is_favorite: 1 },
    ]);
    expect(query("SELECT photo_id FROM photo_tags WHERE photo_id=1")).toEqual([
      { photo_id: 1 },
    ]);
    expect(query("SELECT photo_id FROM album_photos WHERE photo_id=1")).toEqual(
      [{ photo_id: 1 }]
    );
    expect(
      query("SELECT id,photo_id,content_revision FROM face_vectors WHERE id=3")
    ).toEqual([{ id: 3, photo_id: 1, content_revision: 0 }]);
    expect(
      query(
        "SELECT identity_id,face_vector_id FROM face_identity_members WHERE face_vector_id=3"
      )
    ).toEqual([{ identity_id: 2, face_vector_id: 3 }]);
    expect(
      query(
        "SELECT photo_id,decision,source_identity_id,content_revision FROM face_review_decisions WHERE photo_id=1 AND content_revision=0"
      )
    ).toEqual([
      {
        photo_id: 1,
        decision: "confirmed",
        source_identity_id: 2,
        content_revision: 0,
      },
    ]);
    expect(
      query(
        "SELECT id,session_id,photo_id,rating,content_revision FROM cull_session_photos WHERE id=11"
      )
    ).toEqual([
      { id: 11, session_id: 1, photo_id: 1, rating: 1777, content_revision: 0 },
    ]);
    expect(query("PRAGMA foreign_key_check")).toEqual([]);
  };
  let app: ElectronApplication | undefined;
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const preview = path.join(
      profile,
      "thumbnails",
      `${createHash("md5").update(`${oldPhoto}_md_v3_1`).digest("hex")}.webp`
    );
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    await sharp(bytes).webp().toFile(preview);
    query(
      `
      INSERT INTO folders(id,path,display_name,photo_count,created_at,explicit_only)
      VALUES(1,'${escapeSql(oldRoot)}','Offline fixture',1,1,1);
      INSERT INTO photos(id,path,filename,folder_id,created_at,width,height,file_size,is_favorite,thumbnail_path,is_face_processed)
      VALUES(1,'${escapeSql(oldPhoto)}','photo.jpg',1,1,160,100,${bytes.length},1,'${escapeSql(preview)}',1);
      INSERT INTO tags(id,name,created_at) VALUES(1,'Preserved tag',1);
      INSERT INTO photo_tags(photo_id,tag_id,origin,user_confirmed) VALUES(1,1,'manual',1);
      INSERT INTO albums(id,name,created_at) VALUES(1,'Preserved album',1);
      INSERT INTO album_photos(album_id,photo_id,sort_order) VALUES(1,1,0);
      INSERT INTO cull_sessions(id,name,created_at,status,total_photos)
      VALUES(1,'Preserved review',1,'completed',1);
      INSERT INTO cull_session_photos(id,session_id,photo_id,rating) VALUES(11,1,1,1777);
      INSERT INTO face_vectors(id,photo_id,face_index,bbox_x,bbox_y,bbox_width,bbox_height,created_at)
      VALUES(3,1,0,0,0,1,1,1);
      INSERT INTO face_identities(id,name,is_confirmed,created_at) VALUES(2,'Preserved person',1,1);
      INSERT INTO face_identity_members(identity_id,face_vector_id) VALUES(2,3);
      INSERT INTO face_review_decisions(photo_id,face_index,decision,source_identity_id,created_at,updated_at)
      VALUES(1,0,'confirmed',2,1,1);
      INSERT INTO app_settings(key,value,updated_at) VALUES('ai.autoIndexStopped','true',1);
    `,
      stageHistoricalMigrations(root)
    );
    app = await launch();
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    const backupDirectory = path.join(path.dirname(dbPath), "backups");
    const backups = fs
      .readdirSync(backupDirectory)
      .filter((name) => name.startsWith("pre-library-reliability-"));
    expect(backups).toHaveLength(1);
    const backup = path.join(backupDirectory, backups[0]);
    expect(
      query("SELECT id,is_favorite FROM photos", undefined, backup)
    ).toEqual([{ id: 1, is_favorite: 1 }]);
    expect(
      query("PRAGMA table_info(photos)", undefined, backup).map(
        ({ name }: { name: string }) => name
      )
    ).not.toContain("content_revision");
    const retainedBackup = test.info().outputPath("pre-library-reliability.db");
    fs.copyFileSync(backup, retainedBackup);
    await test.info().attach("pre-library-reliability-database", {
      path: retainedBackup,
      contentType: "application/vnd.sqlite3",
    });
    fs.writeFileSync(
      test.info().outputPath("pre-library-reliability-backup.json"),
      JSON.stringify(
        {
          sha256: createHash("sha256")
            .update(fs.readFileSync(retainedBackup))
            .digest("hex"),
          photos: query(
            "SELECT id,is_favorite FROM photos",
            undefined,
            retainedBackup
          ),
          tags: query(
            "SELECT photo_id,tag_id FROM photo_tags",
            undefined,
            retainedBackup
          ),
          albums: query(
            "SELECT album_id,photo_id FROM album_photos",
            undefined,
            retainedBackup
          ),
          faces: query(
            "SELECT id,photo_id FROM face_vectors",
            undefined,
            retainedBackup
          ),
          culling: query(
            "SELECT id,photo_id,rating FROM cull_session_photos",
            undefined,
            retainedBackup
          ),
        },
        null,
        2
      )
    );
    await expect
      .poll(() => query("SELECT source_status FROM photos WHERE id=1"), {
        timeout: 30_000,
      })
      .toEqual([{ source_status: "offline" }]);
    expectPreservedRelations();
    await page.evaluate(() => localStorage.setItem("lang", "en"));
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await expect(page.locator('[data-photo-id="1"]').first()).toBeVisible();
    const offlineState = test.info().outputPath("offline-catalogue-state.json");
    fs.writeFileSync(
      offlineState,
      JSON.stringify({
        records: query(
          "SELECT id,source_status,refresh_status,content_revision,metadata_revision,thumbnail_path FROM photos"
        ),
        previewExists: fs.existsSync(preview),
        card: await page.locator('[data-photo-id="1"]').first().innerText(),
        language: await page.evaluate(() => localStorage.getItem("lang")),
        media: await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .filter((entry) => entry.name.includes("photo-thumbnail"))
            .map((entry) => ({
              status: (entry as PerformanceResourceTiming).responseStatus,
              bytes: (entry as PerformanceResourceTiming).decodedBodySize,
            }))
        ),
      })
    );
    await test.info().attach("offline-catalogue-state", {
      path: offlineState,
      contentType: "application/json",
    });
    await expect(
      page.getByText("Offline", { exact: true }).first()
    ).toBeVisible();
    await expect
      .poll(() =>
        page
          .locator('[data-photo-id="1"] img')
          .first()
          .evaluate((image) => (image as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0);
    // Let the legacy palette pass read the cached preview before clearing it.
    // Its decoder must release the file even with libvips caching enabled.
    await expect
      .poll(
        () =>
          query(
            "SELECT dominant_colors IS NOT NULL AS present FROM photos WHERE id=1"
          ),
        { timeout: 30_000 }
      )
      .toEqual([{ present: 1 }]);
    const cachedPreview = fs.readFileSync(preview);
    await page.evaluate(() => window.__e2eNavigate?.("/settings/storage"));
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page
      .getByRole("alertdialog", { name: "Clear Thumbnail Cache" })
      .getByRole("button", { name: "Confirm", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: CACHE_CLEARED })
    ).toBeVisible();
    await expect.poll(() => fs.existsSync(preview)).toBe(false);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    const unavailableCard = page.locator('[data-photo-id="1"]').first();
    await expect(
      unavailableCard.getByText("Offline", { exact: true })
    ).toBeVisible();
    await expect(unavailableCard.locator("img")).toHaveCount(0);
    await expect(unavailableCard.locator("svg")).toBeVisible();
    await expect(
      unavailableCard.getByRole("button", { name: "Retry", exact: true })
    ).toHaveCount(0);
    fs.writeFileSync(
      query("SELECT thumbnail_path FROM photos WHERE id=1")[0].thumbnail_path,
      cachedPreview
    );
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await expect
      .poll(() =>
        page
          .locator('[data-photo-id="1"] img')
          .first()
          .evaluate((image) => (image as HTMLImageElement).naturalWidth)
      )
      .toBeGreaterThan(0);
    await app.evaluate(({ dialog }, selectedPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selectedPath],
      });
    }, newRoot);
    for (const size of SIZES) {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0].setContentSize(
          bounds.width,
          bounds.height
        );
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(
          bounds.zoomFactor ?? 1
        );
      }, size);
      const attentionTrigger = page.getByRole("link", {
        name: LIBRARY_ATTENTION,
      });
      await expect(attentionTrigger).toHaveText("");
      await attentionTrigger.hover();
      await expect(
        page
          .locator('[data-slot="tooltip-content"]')
          .filter({ hasText: LIBRARY_ATTENTION })
      ).toBeVisible();
      await attentionTrigger.click();
      await expect(
        page.getByRole("heading", { name: "Library sources", exact: true })
      ).toBeVisible();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const sizeLabel = `${size.width}-${size.zoomFactor ?? 1}`;
      await expect(page.getByRole("combobox")).toHaveCount(0);
      await expectViewportBounds(page);
      await captureWindow(app, `library-sources-${sizeLabel}.png`);
      const sourceList = page.getByRole("region", {
        name: "Source folders",
        exact: true,
      });
      await expect(
        sourceList.getByText("Offline fixture", { exact: true })
      ).toBeVisible();
      await sourceList
        .getByRole("button", { name: "View affected photos", exact: true })
        .click();
      const offlinePhotos = page.getByRole("region", { name: "Photo status" });
      await expect(
        offlinePhotos.getByRole("button", { name: "Check again", exact: true })
      ).toBeVisible();
      await expect(
        offlinePhotos.getByRole("button", {
          name: "Choose new location",
          exact: true,
        })
      ).toBeVisible();
      await expect(
        offlinePhotos.getByRole("button", { name: REMOVE_MISSING })
      ).toHaveCount(0);
      await expectViewportBounds(page);
      await offlinePhotos
        .getByRole("button", { name: "Back to sources", exact: true })
        .click();
      await sourceList
        .getByRole("button", { name: "Choose new location", exact: true })
        .click();
      const relink = page.getByRole("region", {
        name: "Choose new location",
        exact: true,
      });
      await expect(relink).toBeVisible();
      await expect(relink.getByText(newPhoto, { exact: true })).toBeVisible();
      await expect(
        relink.getByText("Previous location", { exact: true })
      ).toBeVisible();
      // Leave after inspection completes: the preview must survive route remounts.
      await page.getByTestId("settings-back").click();
      await page.getByRole("link", { name: LIBRARY_ATTENTION }).click();
      await expect(relink).toBeVisible();
      if (size.width === 720) {
        await page.evaluate(() =>
          window.__e2eNavigate?.("/settings/appearance")
        );
        await page
          .getByRole("combobox", { name: "Language", exact: true })
          .click();
        await page
          .getByRole("option", { name: "\u4e2d\u6587 (zh)", exact: true })
          .click();
        await expect(page.locator("html")).toHaveAttribute("lang", "zh");
        await page.evaluate(() => localStorage.setItem("theme", "dark"));
        await page.reload();
        await page.waitForFunction(() => Boolean(window.__e2eNavigate));
        await page.evaluate(() => window.__e2eNavigate?.("/settings/library"));
        await expect(page.getByRole("checkbox")).toBeVisible();
        await expectViewportBounds(page);
        await captureWindow(app, "library-relink-zh-dark-720.png");
        await page.evaluate(() =>
          window.__e2eNavigate?.("/settings/appearance")
        );
        await page
          .getByRole("combobox", { name: "\u8bed\u8a00", exact: true })
          .click();
        await page
          .getByRole("option", { name: "English (en)", exact: true })
          .click();
        await expect(page.locator("html")).toHaveAttribute("lang", "en");
        await page.evaluate(() => localStorage.setItem("theme", "light"));
        await page.reload();
        await page.waitForFunction(() => Boolean(window.__e2eNavigate));
        await page.evaluate(() => window.__e2eNavigate?.("/settings/library"));
        await expect(relink).toBeVisible();
      }
      const confirm = relink.getByRole("button", {
        name: "Update library locations",
        exact: true,
      });
      await expect(confirm).toBeDisabled();
      await relink.getByRole("checkbox", { name: WEAK_EVIDENCE }).check();
      await expect(confirm).toBeEnabled();
      await confirm.scrollIntoViewIfNeeded();
      await confirm.click({ trial: true });
      await expect(confirm).toBeInViewport({ ratio: 1 });
      await expectViewportBounds(page);
      await captureWindow(app, `library-relink-${sizeLabel}.png`);
      await relink.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(relink).toHaveCount(0);
      await page.getByTestId("settings-back").click();
      await expect(page.locator('[data-photo-id="1"]').first()).toBeVisible();
      await expect(
        page
          .locator('[data-slot="tooltip-content"]')
          .filter({ hasText: LIBRARY_ATTENTION })
      ).not.toBeVisible();
      await page.mouse.move(0, 0);
    }
    await page.getByRole("link", { name: LIBRARY_ATTENTION }).click();
    await page
      .getByRole("region", { name: "Source folders", exact: true })
      .getByRole("button", { name: "Choose new location", exact: true })
      .click();
    const relink = page.getByRole("region", {
      name: "Choose new location",
      exact: true,
    });
    await relink.getByRole("checkbox", { name: WEAK_EVIDENCE }).check();
    await relink
      .getByRole("button", { name: "Update library locations", exact: true })
      .click();
    await expect
      .poll(() => query("SELECT path,is_favorite FROM photos WHERE id=1")[0])
      .toEqual({ path: newPhoto, is_favorite: 1 });
    expectPreservedRelations();
    expect(
      query("SELECT content_revision FROM photos WHERE id=1")[0]
        .content_revision
    ).toBeGreaterThan(0);
    expect(query("SELECT path FROM folders WHERE id=1")).toEqual([
      { path: newRoot },
    ]);
    await expect
      .poll(
        () =>
          query(
            "SELECT metadata_revision=content_revision AS ready FROM photos WHERE id=1"
          )[0].ready,
        { timeout: 30_000 }
      )
      .toBe(1);
    await expect(
      page.getByRole("region", { name: "Choose new location", exact: true })
    ).toHaveCount(0);
    await page.getByTestId("settings-back").click();
    await expect(
      page.getByRole("link", { name: LIBRARY_ATTENTION })
    ).toHaveCount(0);
    await expect(
      page.getByLabel("Filter by source status", { exact: true })
    ).toHaveCount(0);
    for (const size of SIZES) {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0].setContentSize(
          bounds.width,
          bounds.height
        );
        BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(
          bounds.zoomFactor ?? 1
        );
      }, size);
      const healthyDetail = page.locator(
        '.photo-detail-panel-shell [data-surface="inspector"]'
      );
      if ((await healthyDetail.count()) === 0) {
        await page.locator('[data-photo-id="1"][role="option"]').click();
      }
      await expect
        .poll(async () => (await healthyDetail.boundingBox())?.width ?? 0)
        .toBeGreaterThan(200);
      await expect(
        healthyDetail.getByText("photo.jpg", { exact: true })
      ).toBeVisible();
      await expect(
        healthyDetail.getByRole("button", {
          name: "Resolve in settings",
          exact: true,
        })
      ).toHaveCount(0);
      await expect(
        healthyDetail.getByRole("button", { name: "File actions", exact: true })
      ).toHaveCount(0);
      await expect(
        healthyDetail.getByRole("button", {
          name: "Check original file",
          exact: true,
        })
      ).toHaveCount(0);
      await expectViewportBounds(page);
      await captureWindow(
        app,
        `simplified-detail-${size.width}-${size.zoomFactor ?? 1}.png`
      );
    }
    await expect
      .poll(() =>
        query("SELECT source_status,refresh_status FROM photos WHERE id=1")
      )
      .toEqual([{ source_status: "available", refresh_status: "ready" }]);
    await page.evaluate(() => window.__e2eNavigate?.("/cull/1"));
    const reviewAgain = page.getByRole("button", {
      name: "Review again",
      exact: true,
    });
    await reviewAgain.click();
    await expect(page.getByText(REVIEW_NOT_READY)).toBeVisible();
    expect(query("SELECT id FROM cull_sessions")).toEqual([{ id: 1 }]);

    // The fixture keeps AI paused. Record a completed analysis for this photo
    // so the UI can exercise both the waiting and ready review paths.
    query(
      `UPDATE photos SET embedding_revision=content_revision,
        color_revision=content_revision,face_refresh_pending=0 WHERE id=1`,
      true
    );
    await reviewAgain.click();
    await expect(
      page.getByRole("heading", { name: "Preserved review (review again)" })
    ).toBeVisible();
    await expect(page.getByTestId("cull-curate-keep")).toBeVisible();
    expect(
      query(
        "SELECT session_id,photo_id FROM cull_session_photos WHERE session_id<>1"
      )
    ).toEqual([{ session_id: 2, photo_id: 1 }]);
    expectPreservedRelations();
    await app.close();
    const keptOriginal = path.join(root, "original-outside-library.jpg");
    fs.renameSync(newPhoto, keptOriginal);
    const otherPhoto = path.join(newRoot, "other.jpg");
    fs.writeFileSync(otherPhoto, bytes);
    // An unused managed tier lets us verify disk cleanup without racing the
    // browser's open handle to the displayed offline preview on Windows.
    const scale = Math.min(
      Math.ceil(Number(process.env.AIM_E2E_DEVICE_SCALE_FACTOR ?? "1")),
      3
    );
    const managedPreview = path.join(
      profile,
      "thumbnails",
      `${createHash("md5").update(`${newPhoto}_lg_v4_${scale}`).digest("hex")}.webp`
    );
    fs.writeFileSync(managedPreview, cachedPreview);
    query(
      `
      INSERT INTO photos(id,path,filename,folder_id,width,height,is_favorite,created_at)
      VALUES(2,'${escapeSql(otherPhoto)}','other.jpg',1,160,100,1,1);
      INSERT INTO photo_tags(photo_id,tag_id,origin,user_confirmed) VALUES(2,1,'manual',1);
      INSERT INTO album_photos(album_id,photo_id,sort_order) VALUES(1,2,1);
      INSERT INTO exif_data(photo_id,camera_make) VALUES(1,'Removed fixture'),(2,'Retained fixture')
      ON CONFLICT(photo_id) DO UPDATE SET camera_make=excluded.camera_make;
      UPDATE folders SET photo_count=2 WHERE id=1;
    `,
      true
    );
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    expectPreservedRelations();
    expect(
      fs
        .readdirSync(backupDirectory)
        .filter((name) => name.startsWith("pre-library-reliability-"))
    ).toEqual(backups);
    expect(
      query("SELECT path,content_revision FROM photos WHERE id=1")[0]
    ).toMatchObject({ path: newPhoto });
    expect(
      query("SELECT content_revision FROM photos WHERE id=1")[0]
        .content_revision
    ).toBeGreaterThan(0);
    const photoCard = page.locator('[data-photo-id="1"][role="option"]');
    await photoCard.click();
    const detail = page.locator(
      '.photo-detail-panel-shell [data-surface="inspector"]'
    );
    await expect
      .poll(() => query("SELECT source_status FROM photos WHERE id=1"))
      .toEqual([{ source_status: "missing" }]);
    await expect(
      detail.getByRole("button", { name: "File actions", exact: true })
    ).toHaveCount(0);
    await detail
      .getByRole("button", { name: "Resolve in settings", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Library sources", exact: true })
    ).toBeVisible();
    const statusList = page.getByRole("region", {
      name: "Photo status",
      exact: true,
    });
    await expect(
      statusList.getByText("photo.jpg", { exact: true })
    ).toBeVisible();
    await expect(statusList.getByText(MISSING_STATUS)).toBeVisible();
    const remove = statusList.getByRole("button", {
      name: REMOVE_MISSING,
      exact: true,
    });
    for (const size of SIZES) {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setContentSize(bounds.width, bounds.height);
        window.webContents.setZoomFactor(bounds.zoomFactor ?? 1);
      }, size);
      await expect(
        statusList.getByRole("button", {
          name: "Check original file",
          exact: true,
        })
      ).toBeVisible();
      await expect(
        statusList.getByRole("button", {
          name: "Choose new location",
          exact: true,
        })
      ).toBeVisible();
      await remove.click({ trial: true });
      await expectViewportBounds(page);
    }
    await statusList
      .getByRole("button", { name: "Check original file", exact: true })
      .click();
    await expect(
      statusList.getByText("Check complete: Missing.", { exact: true })
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Library maintenance task" })
    ).toHaveCount(0);
    await remove.click();
    const previewRemoval = page.getByRole("alertdialog", {
      name: REMOVE_MISSING,
    });
    await expect(
      previewRemoval.getByText(
        "Remove 1 missing photos and their links from the library. Original files are kept."
      )
    ).toBeVisible();
    await expect(
      previewRemoval.getByText(
        "1 tags · 1 albums · 1 faces · 2 culling entries"
      )
    ).toBeVisible();
    await expectViewportBounds(page);
    await previewRemoval
      .getByRole("button", { name: "Cancel", exact: true })
      .click();
    await expect(previewRemoval).toHaveCount(0);
    expectPreservedRelations();
    expect(fs.existsSync(managedPreview)).toBe(true);
    await remove.click();
    await previewRemoval
      .getByRole("button", { name: REMOVE_MISSING, exact: true })
      .click();
    await expect(
      statusList.getByText(
        "This photo was removed from the catalogue. Return to the list."
      )
    ).toBeVisible();
    await page.getByTestId("settings-back").click();
    await expect(photoCard).toHaveCount(0);
    expect(query("SELECT id,path,is_favorite FROM photos")).toEqual([
      { id: 2, path: otherPhoto, is_favorite: 1 },
    ]);
    expect(
      query("SELECT photo_id FROM photo_tags WHERE photo_id=1 OR tag_id=1")
    ).toEqual([{ photo_id: 2 }]);
    expect(query("SELECT photo_id FROM album_photos")).toEqual([
      { photo_id: 2 },
    ]);
    expect(query("SELECT photo_id FROM face_vectors")).toEqual([]);
    expect(query("SELECT face_vector_id FROM face_identity_members")).toEqual(
      []
    );
    expect(query("SELECT photo_id FROM face_review_decisions")).toEqual([]);
    expect(query("SELECT photo_id FROM cull_session_photos")).toEqual([]);
    expect(query("SELECT photo_id,camera_make FROM exif_data")).toEqual([
      { photo_id: 2, camera_make: "Retained fixture" },
    ]);
    await expect.poll(() => fs.existsSync(managedPreview)).toBe(false);
    expect(query("SELECT photo_count FROM folders WHERE id=1")).toEqual([
      { photo_count: 1 },
    ]);
    expect(query("PRAGMA foreign_key_check")).toEqual([]);
    expect(fs.readFileSync(keptOriginal)).toEqual(bytes);
    expect(fs.readFileSync(otherPhoto)).toEqual(bytes);
  } finally {
    await app?.close();
  }
});
