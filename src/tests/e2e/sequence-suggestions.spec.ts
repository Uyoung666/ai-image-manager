import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electronPath = createRequire(import.meta.url)("electron") as string;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const START = 1_700_000_000_000;
const MERGE = "Merge into manual sequence";
const SEQUENCES_BUTTON = /^Sequences/;
const SUGGESTIONS_BUTTON = /^Continuation suggestions:/;
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

function query(sql: string, write = false): Record<string, number>[] {
  return JSON.parse(
    execFileSync(
      electronPath,
      [
        "-e",
        "const D=require('better-sqlite3');const d=new D(process.argv[1]);const sql=require('node:fs').readFileSync(0,'utf8');try{d.pragma('foreign_keys=ON');if(process.argv[2]==='write'){d.exec(sql);console.log('[]')}else{console.log(JSON.stringify(d.prepare(sql).all()))}}finally{d.close()}",
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

async function ready(target: Page) {
  await target.addInitScript(() => localStorage.setItem("lang", "en"));
  await target.reload();
  await target.waitForFunction(() => Boolean(window.__e2eNavigate));
  await target.evaluate(() => window.__e2eNavigate?.("/"));
  await target.getByRole("button", { name: SEQUENCES_BUTTON }).click();
  await expect(target.locator("[data-sequence-id]")).toHaveCount(3);
}

async function launch() {
  app = await launchTestApp(root, {
    args: ["-r", path.join(root, "isolation.cjs"), "--e2e", path.resolve(".")],
    env,
  });
  app
    .process()
    .stderr?.on("data", (data) =>
      fs.appendFileSync(path.join(root, "electron.log"), data)
    );
  page = await app.firstWindow();
  await page.addInitScript(() => localStorage.setItem("lang", "en"));
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
}

function resetSequences() {
  const statements = [
    "DELETE FROM photo_sequence_suggestions",
    "DELETE FROM photo_sequences",
  ];
  for (let segment = 0; segment < 3; segment++) {
    const id = segment + 1;
    const first = segment * 6 + 1;
    statements.push(
      `INSERT INTO photo_sequences(id,folder_id,type,source,representative_photo_id,started_at,ended_at,frame_count,user_locked,created_at,updated_at) VALUES(${id},1,'timelapse','auto',${first},${START + segment * 100_000},${START + segment * 100_000 + 25_000},6,0,1,1)`
    );
    for (let position = 0; position < 6; position++) {
      statements.push(
        `INSERT INTO photo_sequence_members(sequence_id,photo_id,position) VALUES(${id},${first + position},${position})`
      );
    }
  }
  query(statements.join(";"), true);
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);
test.beforeAll(async () => {
  root = createTestRuntime("sequence-suggestions");
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
  const image = await sharp({
    create: {
      width: 160,
      height: 100,
      channels: 3,
      background: { r: 75, g: 135, b: 185 },
    },
  })
    .png()
    .toBuffer();
  const escapeSql = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${escapeSql(fixture)}','SequenceFixture',18,1)`,
  ];
  for (let id = 1; id <= 18; id++) {
    const filename = `SequenceFixture-${id}.png`;
    const photoPath = path.join(fixture, filename);
    const capturedAt =
      START + Math.floor((id - 1) / 6) * 100_000 + ((id - 1) % 6) * 5000;
    fs.writeFileSync(photoPath, image);
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,phash,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${escapeSql(photoPath)}','${filename}',1,1024,${capturedAt},160,100,'png','${escapeSql(photoPath)}','0000000000000000',1,1,1,1)`
    );
    statements.push(
      `INSERT INTO exif_data(photo_id,date_taken,camera_model,lens_model) VALUES(${id},${capturedAt},'Camera A','Lens A')`
    );
    statements.push(
      `INSERT INTO advanced_exif_data(photo_id,parser_version,status,normalized_json,enriched_at) VALUES(${id},999,'ready','${JSON.stringify({ capture: { captureTimestampMs: capturedAt } })}',1)`
    );
  }
  query(statements.join(";"), true);
  resetSequences();
  await launch();
});
test.afterAll(async () => {
  await app?.close();
});

async function assertBounds(target: Page) {
  expect(
    await target.evaluate(() => {
      const overflow = [
        document.documentElement,
        document.body,
        ...document.querySelectorAll("main"),
      ].some((element) => element.scrollWidth > element.clientWidth + 2);
      const escaped = [
        ...document.querySelectorAll(
          '[role="dialog"], [role="alertdialog"], [role="menu"]'
        ),
      ]
        .filter((element) => element.getClientRects().length)
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

async function openSuggestions(target: Page) {
  await target.getByRole("button", { name: SUGGESTIONS_BUTTON }).click();
  const dialog = target.getByTestId("sequence-suggestions-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

for (const size of SIZES) {
  test(`${size.width}x${size.height} previews any pair and removes consumed advice across restart`, async () => {
    resetSequences();
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    await ready(page);
    const dialog = await openSuggestions(page);
    await expect(dialog.locator("article")).toHaveCount(2);
    const second = dialog.locator("article").nth(1);
    await expect(second.getByText("Camera A · Lens A").first()).toBeVisible();
    await expect(
      second.getByRole("img", { name: "Last frame of first segment" })
    ).toBeVisible();
    await assertBounds(page);
    await page.screenshot({ path: test.info().outputPath("suggestions.png") });
    await second.getByRole("button", { name: MERGE, exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("12 frames");
    await assertBounds(page);
    await confirmation
      .getByRole("button", { name: MERGE, exact: true })
      .click();
    await expect(dialog.locator("article")).toHaveCount(1);
    await expect(
      dialog.getByRole("button", { name: "View merged sequence" })
    ).toBeVisible();
    await expect(dialog).not.toContainText("Failed to merge sequences");
    expect(query("SELECT COUNT(*) n FROM photo_sequences")[0].n).toBe(2);
    await dialog
      .locator("article")
      .getByRole("button", { name: MERGE, exact: true })
      .click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: MERGE, exact: true })
      .click();
    await expect(dialog).toContainText("No pending continuation suggestions.");
    await dialog.getByRole("button", { name: "View merged sequence" }).click();
    await expect(
      page.getByRole("button", { name: "Close sequence details", exact: true })
    ).toBeVisible();
    await assertBounds(page);
    expect(query("SELECT frame_count n FROM photo_sequences")[0].n).toBe(18);
    await app.close();
    await launch();
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await page.getByRole("button", { name: SEQUENCES_BUTTON }).click();
    const restarted = await openSuggestions(page);
    await expect(restarted).toContainText(
      "No pending continuation suggestions."
    );
    await page.keyboard.press("Escape");
    await expect(restarted).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: SUGGESTIONS_BUTTON })
    ).toBeFocused();
  });
}

test("another window receives committed sequence changes", async () => {
  resetSequences();
  await ready(page);
  const observerEntry = path.join(root, "observer.html");
  fs.writeFileSync(
    observerEntry,
    "<html><body>Sequence event observer</body></html>"
  );
  const windowPromise = app.waitForEvent("window");
  await app.evaluate(
    ({ BrowserWindow }, paths) => {
      // Production only authorizes the main renderer for IPC. This passive window
      // verifies the real broadcast without granting it additional IPC authority.
      const observer = new BrowserWindow({
        width: 900,
        height: 600,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          preload: paths.preload,
        },
      });
      return observer.loadFile(paths.entry);
    },
    { entry: observerEntry, preload: path.resolve(".vite/build/preload.js") }
  );
  const secondPage = await windowPromise;
  await secondPage.evaluate(() => {
    const changes: unknown[] = [];
    window.addEventListener("message", (event) => {
      if (event.data?.channel === "sequences-changed") {
        changes.push(event.data);
      }
    });
    Object.assign(window, { sequenceChanges: changes });
  });
  const dialog = await openSuggestions(page);
  await dialog
    .locator("article")
    .first()
    .getByRole("button", { name: MERGE, exact: true })
    .click();
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: MERGE, exact: true })
    .click();
  await expect(dialog.locator("article")).toHaveCount(1);
  await expect
    .poll(() =>
      secondPage.evaluate(() => Reflect.get(window, "sequenceChanges"))
    )
    .toEqual([
      expect.objectContaining({
        channel: "sequences-changed",
        reason: "manual",
        revision: expect.any(Number),
        deletedSequenceIds: [1, 2],
        replacementSequenceIds: [expect.any(Number)],
      }),
    ]);
  await secondPage.close();
});
