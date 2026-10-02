import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import sharp from "sharp";

const electronPath = createRequire(import.meta.url)("electron") as string;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const PULSE_CLASS = /photo-card-recently-viewed-pulse/;
const SEQUENCES = /^Sequences/;
const FRAME_80 = /Open frame 80:/;
const THUMBNAIL_80 = /\d+: ReturnFixture-080.png/;
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

async function launch() {
  app = await _electron.launch({
    args: ["-r", path.join(root, "isolation.cjs"), "--e2e", path.resolve(".")],
    env,
  });
  app
    .process()
    .stderr?.on("data", (data) =>
      fs.appendFileSync(path.join(root, "electron.log"), data)
    );
  page = await app.firstWindow();
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("ui.reduceMotion", "false");
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
}

async function navigate(route: string) {
  await page.evaluate((next) => window.__e2eNavigate?.(next), route);
  await page.locator("main").first().waitFor();
}

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);
test.beforeAll(async () => {
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "gallery-return-"));
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
  const sqlEscape = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${sqlEscape(fixture)}','ReturnFixture',180,1)`,
    "INSERT INTO albums(id,name,created_at) VALUES(9001,'ReturnFixture',1)",
  ];
  for (let id = 1; id <= 180; id++) {
    const filename = `ReturnFixture-${String(id).padStart(3, "0")}.png`;
    const photoPath = path.join(fixture, filename);
    fs.writeFileSync(photoPath, image);
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_favorite,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${sqlEscape(photoPath)}','${filename}',1,1024,${id},160,100,'png','${sqlEscape(photoPath)}',1,1,1,1,1)`
    );
  }
  statements.push(
    "INSERT INTO photo_sequences(id,folder_id,type,source,representative_photo_id,started_at,ended_at,frame_count,user_locked,created_at,updated_at) VALUES(1,1,'burst','manual',1,1,96,96,1,1,1)"
  );
  for (let id = 1; id <= 96; id++) {
    statements.push(
      `INSERT INTO photo_sequence_members(sequence_id,photo_id,position) VALUES(1,${id},${id - 1})`
    );
  }
  statements.push(
    "INSERT INTO album_photos(album_id,photo_id) SELECT 9001,id FROM photos"
  );
  execFileSync(
    electronPath,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.exec(require('node:fs').readFileSync(0,'utf8'))}finally{d.close()}",
      path.join(profile, "data", "ai-image-manager.db"),
    ],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      input: statements.join(";"),
      encoding: "utf8",
    }
  );
  await launch();
});
test.afterAll(async () => {
  await app?.close();
});

async function assertBounds() {
  const issues = await page.evaluate(() => {
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
  });
  expect(issues).toEqual({ overflow: false, escaped: false });
}

for (const size of SIZES) {
  for (const route of ["/", "/albums/9001"]) {
    test(`${size.width}x${size.height} ${route} returns to a folded card and a virtual sequence frame`, async () => {
      await app.evaluate(({ BrowserWindow }, requested) => {
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        );
      }, size);
      await navigate(route === "/" ? "/albums/9001" : "/");
      await navigate(route);
      const sequencesButton = page.getByRole("button", { name: SEQUENCES });
      await sequencesButton.click();
      const group = page.locator('[data-sequence-id="1"]');
      await expect(group).toBeVisible();
      await group.click();
      await expect(
        page.getByRole("button", {
          name: "Close sequence details",
          exact: true,
        })
      ).toBeVisible();
      await assertBounds();
      await page
        .getByRole("button", { name: "Close sequence details", exact: true })
        .click();
      await expect(group).toBeFocused();
      await expect(group.getByRole("status")).toHaveText("Just viewed");
      await expect(group).toHaveClass(PULSE_CLASS);
      await expect(group).not.toHaveClass(PULSE_CLASS);
      await expect(group.getByRole("status")).toHaveText("Just viewed");
      await group
        .getByRole("button", { name: "Expand sequence photos", exact: true })
        .click();
      const sequenceOnlyTray = page.locator('[data-sequence-tray-id="1"]');
      await expect(sequenceOnlyTray.getByRole("status")).toHaveText(
        "Just viewed"
      );
      await expect(sequenceOnlyTray).not.toHaveClass(PULSE_CLASS);
      await assertBounds();
      await sequenceOnlyTray
        .getByRole("button", { name: "Collapse sequence", exact: true })
        .click();
      await expect(group.getByRole("status")).toHaveText("Just viewed");

      // Closing a frame detail preserves the folded structure and full-order frame number.
      await group.click();
      await page.getByRole("button", { name: FRAME_80 }).click();
      await expect(
        page.getByRole("button", {
          name: "Back to sequence details",
          exact: true,
        })
      ).toBeVisible();
      await page
        .getByRole("button", { name: "Back to sequence details", exact: true })
        .click();
      await expect(group.getByRole("status")).toHaveCount(0);
      await page
        .getByRole("button", { name: "Close sequence details", exact: true })
        .click();
      await expect(group).toBeFocused();
      await expect(group.getByRole("status")).toHaveText(
        "Just viewed · Frame 80"
      );
      await expect(page.locator('[data-sequence-tray-id="1"]')).toHaveCount(0);

      // Direct playback closes to the card, keeping the sequence folded.
      await group.dblclick();
      const directPlayback = page.locator(".lightbox-interactive");
      await expect(directPlayback).toBeVisible();
      await directPlayback.getByRole("button", { name: THUMBNAIL_80 }).click();
      await directPlayback
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(group).toBeFocused();
      await expect(group.getByRole("status")).toHaveText(
        "Just viewed · Frame 80"
      );
      await expect(page.locator('[data-sequence-tray-id="1"]')).toHaveCount(0);

      // Playback nested over a sequence detail must close one layer at a time.
      await group.click();
      await page
        .getByRole("button", { name: "Play sequence", exact: true })
        .click();
      const lightbox = page.locator(".lightbox-interactive");
      await expect(lightbox).toBeVisible();
      if (route === "/") {
        await page.keyboard.press("Space");
      }
      await lightbox.getByRole("button", { name: THUMBNAIL_80 }).click();
      await lightbox
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(lightbox).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Close sequence details",
          exact: true,
        })
      ).toBeVisible();
      await expect(group.getByRole("status")).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(group).toBeFocused();
      await expect(group.getByRole("status")).toHaveText(
        "Just viewed · Frame 80"
      );

      // Expanding transfers the marker without starting another pulse or selecting a frame.
      await group
        .getByRole("button", { name: "Expand sequence photos", exact: true })
        .click();
      const tray = page.locator('[data-sequence-tray-id="1"]');
      await expect(tray).toBeVisible();
      await expect(
        page.locator('[data-photo-id="80"][role="option"]')
      ).toHaveCount(0);
      const first = tray.locator('[data-photo-id="1"][role="option"]');
      await expect(first).toBeVisible();
      await first.dblclick();
      await expect(lightbox).toBeVisible();
      const thumbnailToggle = lightbox.getByRole("button", {
        name: "Show/hide thumbnails (T)",
        exact: true,
      });
      if ((await thumbnailToggle.getAttribute("aria-pressed")) !== "true") {
        await thumbnailToggle.click();
      }
      await lightbox.getByRole("button", { name: THUMBNAIL_80 }).click();
      await assertBounds();
      await lightbox
        .getByRole("button", { name: "Close", exact: true })
        .click();
      const returned = tray.locator('[data-photo-id="80"][role="option"]');
      await expect(returned).toBeFocused();
      await expect(returned).toHaveAttribute("aria-selected", "false");
      await expect(returned.getByRole("status")).toHaveText("Just viewed");
      await expect(returned).toHaveClass(PULSE_CLASS);
      const fullyVisible = await returned.evaluate((element) => {
        const card = element.getBoundingClientRect();
        const inner = element
          .closest("[data-sequence-virtual-scroll]")
          ?.getBoundingClientRect();
        const outer = element
          .closest("[data-masonry-scroll]")
          ?.getBoundingClientRect();
        return (
          inner &&
          outer &&
          card.top >= Math.max(inner.top, outer.top) - 1 &&
          card.bottom <= Math.min(inner.bottom, outer.bottom) + 1
        );
      });
      expect(fullyVisible).toBe(true);
      await expect(returned).not.toHaveClass(PULSE_CLASS);
      await expect(returned.getByRole("status")).toBeVisible();
      await assertBounds();
      await page.screenshot({
        path: test.info().outputPath("returned-frame.png"),
      });

      // An already visible target must not move either scroll container on a repeat visit.
      const scrollBefore = await tray.evaluate((element) => [
        element.closest("[data-masonry-scroll]")?.scrollTop,
        element.querySelector("[data-sequence-virtual-scroll]")?.scrollTop,
      ]);
      await returned.dblclick();
      await expect(lightbox).toBeVisible();
      await lightbox
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(returned).toBeFocused();
      await expect(returned).toHaveClass(PULSE_CLASS);
      expect(
        await tray.evaluate((element) => [
          element.closest("[data-masonry-scroll]")?.scrollTop,
          element.querySelector("[data-sequence-virtual-scroll]")?.scrollTop,
        ])
      ).toEqual(scrollBefore);
      await tray
        .getByRole("button", { name: "Collapse sequence", exact: true })
        .click();
      await expect(group.getByRole("status")).toHaveText(
        "Just viewed · Frame 80"
      );
      await expect(group).not.toHaveClass(PULSE_CLASS);
    });
  }
}
