import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

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
const PHOTO_MODE = /^Photos$/;
const QUICK_PREVIEW_COUNTER = /^\d+ \/ \d+$/;
const SCOPE_COUNTER = /^\d+ \/ \d+ selected$/;
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

async function selectPlaybackFrame80(lightbox: Locator) {
  const strip = lightbox.locator("[data-lightbox-thumbnail-strip]");
  await expect(strip).toBeVisible();
  await strip.evaluate((element) => {
    element.scrollLeft = 0;
  });
  const target = lightbox.getByRole("button", { name: THUMBNAIL_80 });
  // A normal photo lightbox can include ungrouped photos before the sequence.
  // Scroll the virtual strip as a user would, without assuming a global index.
  for (let step = 0; step < 40; step++) {
    await strip.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    if (await target.count()) {
      await target.click();
      return;
    }
    await strip.evaluate((element) => {
      element.scrollLeft += Math.max(200, element.clientWidth * 0.75);
    });
  }
  await expect(target).toBeVisible();
}

async function launch() {
  app = await launchTestApp(root, {
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "-r",
      path.join(root, "isolation.cjs"),
      "--e2e",
      process.env.AIM_E2E_APP_PATH ?? path.resolve("."),
    ],
    env,
  });
  app
    .process()
    .stderr?.on("data", (data) =>
      fs.appendFileSync(path.join(root, "electron.log"), data)
    );
  // Development also creates a temporary data: loading window. Test the real
  // renderer so its handoff does not close the page being driven by Playwright.
  await expect
    .poll(
      () =>
        app
          .windows()
          .find((candidate) => {
            const url = candidate.url();
            return url.startsWith("http:") || url.startsWith("file:");
          })
          ?.url(),
      { timeout: 45_000 }
    )
    .toBeTruthy();
  page = app.windows().find((candidate) => {
    const url = candidate.url();
    return url.startsWith("http:") || url.startsWith("file:");
  }) as Page;
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("ui.reduceMotion", "false");
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await page.locator("main").first().waitFor({ state: "attached" });
}

async function navigate(route: string) {
  await page.evaluate((next) => window.__e2eNavigate?.(next), route);
  await page.locator("main").first().waitFor();
}

async function saveWindowScreenshot(name: string) {
  await page.evaluate(async () => {
    const transitions = document.getAnimations().filter((animation) => {
      const effect = animation.effect;
      if (
        !(effect instanceof KeyframeEffect && effect.target instanceof Element)
      ) {
        return false;
      }
      const end = Number(effect.getComputedTiming().endTime);
      return (
        Number.isFinite(end) &&
        end <= 500 &&
        Boolean(
          effect.target.closest(
            '[data-surface="overlay"], [data-surface="overlay-backdrop"]'
          )
        )
      );
    });
    await Promise.allSettled(
      transitions.map((animation) => animation.finished)
    );
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
  });
  // Electron owns device scaling and page zoom; capture the complete native surface.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image = await BrowserWindow.getAllWindows()[0].capturePage();
    return image.toPNG().toString("base64");
  });
  fs.writeFileSync(test.info().outputPath(name), Buffer.from(png, "base64"));
}

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);
test.beforeAll(async () => {
  root = createTestRuntime("gallery-return");
  profile = path.join(root, "profile");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  fs.writeFileSync(
    path.join(root, "isolation.cjs"),
    `const {app}=require('electron');app.setAppPath(${JSON.stringify(path.resolve("."))});const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
  );
  env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
      TEMP: scratch,
      TMP: scratch,
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
  const largePreview = await sharp({
    create: {
      width: 1600,
      height: 1000,
      channels: 3,
      background: { r: 75, g: 135, b: 185 },
    },
  })
    .png()
    .toBuffer();
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${sqlEscape(fixture)}','ReturnFixture',180,1)`,
    "INSERT INTO albums(id,name,created_at) VALUES(9001,'ReturnFixture',1)",
    "INSERT INTO albums(id,name,created_at) VALUES(9002,'RecentTargetFixture',1)",
    "INSERT INTO tags(id,name,created_at) VALUES(9101,'BatchFixtureCommon',1),(9102,'BatchFixturePartial',1),(9103,'BatchFixtureNone',1)",
  ];
  for (let id = 1; id <= 180; id++) {
    const filename = `ReturnFixture-${String(id).padStart(3, "0")}.png`;
    const photoPath = path.join(fixture, filename);
    fs.writeFileSync(photoPath, id === 180 ? largePreview : image);
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_favorite,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${sqlEscape(photoPath)}','${filename}',1,1024,${id},${id === 180 ? 1600 : 160},${id === 180 ? 1000 : 100},'png','${sqlEscape(photoPath)}',1,1,1,1,1)`
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
  statements.push(
    "INSERT INTO photo_tags(photo_id,tag_id,origin,is_confirmed,user_confirmed) SELECT id,9101,'manual',1,1 FROM photos",
    "INSERT INTO photo_tags(photo_id,tag_id,confidence,origin,is_confirmed,user_confirmed) VALUES(180,9102,0.8,'auto',1,0)",
    "INSERT INTO face_identities(id,name,representative_photo_id,face_count,is_confirmed,created_at) VALUES(9003,'IdentityFixture',180,180,1,1)",
    "INSERT INTO face_vectors(id,photo_id,bbox_x,bbox_y,bbox_width,bbox_height,confidence,created_at) SELECT id,id,0.1,0.1,0.5,0.5,1,1 FROM photos",
    "INSERT INTO face_identity_members(identity_id,face_vector_id) SELECT 9003,id FROM face_vectors"
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
      ...document.querySelectorAll(
        '[role="dialog"], [role="alertdialog"], [role="menu"], [data-overlay-kind="gallery-view"], [data-overlay-kind="quick-preview"] img, [data-overlay-kind="quick-preview"] button'
      ),
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
    const overlappingTagList = [
      ...document.querySelectorAll<HTMLElement>("[data-batch-tag-list]"),
    ].some((element) => {
      const following = element.nextElementSibling;
      if (
        following &&
        element.getBoundingClientRect().bottom >
          following.getBoundingClientRect().top + 1
      ) {
        return true;
      }
      const last = element.querySelector<HTMLInputElement>(
        "fieldset label:last-child input"
      );
      if (!last) {
        return false;
      }
      const previous = element.scrollTop;
      element.scrollTop = element.scrollHeight;
      const viewport = element.getBoundingClientRect();
      const target = last.getBoundingClientRect();
      element.scrollTop = previous;
      return (
        target.top < viewport.top - 1 || target.bottom > viewport.bottom + 1
      );
    });
    return { overflow, escaped, overlappingTagList };
  });
  expect(issues).toEqual({
    overflow: false,
    escaped: false,
    overlappingTagList: false,
  });
}

test("keeps keywords when relaxing EXIF and parsed time conditions", async () => {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 800)
  );
  await navigate("/albums/9001");
  await navigate("/");
  const input = page.locator(".home-search-form input[role='combobox']");
  const query = '"missing-experience-photo.png"';
  await input.fill(query);
  await page.getByRole("button", { name: "EXIF Filters", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Creator", exact: true })
    .fill("MissingCreator");
  await page
    .getByRole("button", { name: "Apply Filters", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Clear EXIF filters only", exact: true })
    .click();
  await expect(input).toHaveValue(query);
  await expect(
    page.getByRole("button", { name: "Clear EXIF filters only", exact: true })
  ).toHaveCount(0);
  await input.fill(`${query} 2024年3月`);
  await input.press("Enter");
  await page
    .getByRole("button", { name: "Remove time filter only", exact: true })
    .click();
  await expect(input).toHaveValue(query);
  await expect(
    page.getByRole("button", { name: "Remove time filter only", exact: true })
  ).toHaveCount(0);
  await assertBounds();
  await page.getByRole("button", { name: "Clear search", exact: true }).click();
});

for (const size of SIZES) {
  test(`${size.width}x${size.height} keeps view controls, preview navigation and selection scope accessible`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(requested.width, requested.height);
        window.webContents.setZoomFactor(requested.zoom);
      },
      { ...size, zoom: Number(process.env.AIM_E2E_UI_ZOOM ?? "1") }
    );
    await navigate("/albums/9001");
    await navigate("/");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    const viewportWidth = await page.evaluate(() => innerWidth);
    if (viewportWidth <= 980) {
      await expect(page.locator(".home-toolbar-compact-context")).toBeVisible();
      await expect(page.locator(".home-toolbar-compact-context")).toContainText(
        "photos"
      );
    }
    if (viewportWidth <= 1120) {
      await page
        .getByRole("button", { name: "View options", exact: true })
        .click();
      const view = page.locator('[data-overlay-kind="gallery-view"]');
      await expect(view.getByRole("slider")).toBeVisible();
      await assertBounds();
      await page.keyboard.press("Escape");
      await expect(view).toBeHidden();
    } else {
      await expect(page.locator(".home-grid-size-control input")).toBeVisible();
    }
    const first = page.locator('[data-photo-id][role="option"]').first();
    await page.keyboard.press("Escape");
    await first.focus();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Space");
    const preview = page.getByRole("dialog", {
      name: "Quick preview",
      exact: true,
    });
    await expect(preview).toBeVisible();
    await expect(preview).toBeFocused();
    expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
      ""
    );
    await expect(preview.getByText(QUICK_PREVIEW_COUNTER)).toBeVisible();
    await expect(preview.getByRole("img")).toHaveCSS("opacity", "1");
    await assertBounds();
    // Let transient startup notifications finish before capturing the controls.
    await preview
      .getByRole("button", { name: "Close", exact: true })
      .click({ trial: true });
    await saveWindowScreenshot("quick-preview.png");
    await preview
      .getByRole("button", { name: "Next photo (↓)", exact: true })
      .click();
    await expect(preview.getByText(QUICK_PREVIEW_COUNTER)).toContainText("2 /");
    for (const name of ["Next photo (↓)", "Open lightbox (Enter)", "Close"]) {
      await page.mouse.move(0, 0);
      await preview.getByRole("button", { name, exact: true }).hover();
      const tooltip = preview.locator('[data-slot="tooltip-content"]');
      await expect(tooltip).toBeVisible();
      await expect(tooltip.getByRole("tooltip")).toHaveText(name);
      expect(
        await tooltip.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const topmost = document.elementFromPoint(
            rect.x + rect.width / 2,
            rect.y + rect.height / 2
          );
          return Boolean(topmost && element.contains(topmost));
        })
      ).toBe(true);
    }
    await saveWindowScreenshot("quick-preview-tooltip.png");
    await page.mouse.move(0, 0);
    await page.keyboard.press("Tab");
    expect(
      await preview.evaluate((element) =>
        element.contains(document.activeElement)
      )
    ).toBe(true);
    await assertBounds();
    await saveWindowScreenshot("quick-preview-navigated.png");
    await preview.getByRole("button", { name: "Close", exact: true }).click();
    await expect(preview).toHaveCount(0);
    if (viewportWidth <= 1120) {
      await expect
        .poll(() =>
          page.evaluate(() =>
            Boolean(
              document.activeElement?.closest(".home-detail-panel-container")
            )
          )
        )
        .toBe(true);
      await page.keyboard.press("Escape");
    } else {
      await expect(first).toBeFocused();
    }
    if (viewportWidth > 1120) {
      await page.keyboard.press("Escape");
      const options = page.locator('[data-photo-id][role="option"]');
      await options.nth(0).click({ modifiers: ["Control"] });
      await options.nth(1).click({ modifiers: ["Control"] });
      const selectLoaded = page
        .locator(".selection-menu")
        .getByRole("button", { name: SELECT_LOADED });
      await selectLoaded.hover();
      await expect
        .poll(() =>
          selectLoaded.evaluate((button) => {
            const icon = button
              .querySelector(".selection-menu-icon")
              ?.getBoundingClientRect();
            const label = button.querySelector(".selection-menu-title");
            if (!(icon && label)) {
              return false;
            }
            const bounds = button.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect();
            return (
              text.left >= icon.right + 2 && text.right <= bounds.right - 6
            );
          })
        )
        .toBe(true);
      await saveWindowScreenshot("selection-scope-label.png");
      await selectLoaded.click();
    } else {
      await page.keyboard.press("Control+a");
    }
    await expect(page.locator(".selection-menu-count")).toHaveText(
      SCOPE_COUNTER
    );
    await assertBounds();
    await page.keyboard.press("Escape");
  });
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
      await selectPlaybackFrame80(directPlayback);
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
      await selectPlaybackFrame80(lightbox);
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
      await selectPlaybackFrame80(lightbox);
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
      const scrollAfter = await tray.evaluate((element) => [
        element.closest("[data-masonry-scroll]")?.scrollTop,
        element.querySelector("[data-sequence-virtual-scroll]")?.scrollTop,
      ]);
      for (const [index, before] of scrollBefore.entries()) {
        expect(before).toBeDefined();
        expect(scrollAfter[index]).toBeDefined();
        // Chromium can round a fractional virtual-row offset by one CSS pixel.
        expect(
          Math.abs((scrollAfter[index] ?? 0) - (before ?? 0))
        ).toBeLessThanOrEqual(1);
      }
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

const EDIT_TAGS = /^Edit tags for /;
const EXPORT_TITLE = /^Export \d+ photos$/;
const SELECT_LOADED = /^Select the \d+ currently loaded photos$/;

async function selectAllPhotos() {
  const first = page.locator('[data-photo-id][role="option"]').first();
  await page.keyboard.press("Escape");
  await first.focus();
  await page.keyboard.press("Control+a");
  await expect(page.locator(".selection-menu-count")).toHaveText(SCOPE_COUNTER);
}

for (const size of SIZES) {
  test(`${size.width}x${size.height} completes recent albums, export preferences, tag undo and delete undo`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(requested.width, requested.height);
        window.webContents.setZoomFactor(Number(requested.zoom));
      },
      { ...size, zoom: process.env.AIM_E2E_UI_ZOOM ?? "1" }
    );
    await navigate("/albums/9001");
    await navigate("/");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    await selectAllPhotos();
    const menu = page.locator(".selection-menu");
    const changedTags =
      Number(
        (await menu.locator(".selection-menu-count").innerText()).split(
          " / "
        )[0]
      ) - 1;
    await menu.getByRole("button", { name: "Edit tags", exact: true }).click();
    const tagsDialog = page.getByRole("dialog", { name: EDIT_TAGS });
    const partial = tagsDialog.getByRole("checkbox", {
      name: "BatchFixturePartial",
      exact: true,
    });
    await expect(partial).toHaveAttribute("aria-checked", "mixed");
    await assertBounds();
    await saveWindowScreenshot("batch-tags.png");
    await partial.check();
    await tagsDialog
      .getByRole("button", { name: "Apply tag changes", exact: true })
      .click();
    await expect(tagsDialog).toBeHidden();
    const tagToast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: `Applied ${changedTags} tag changes` });
    await tagToast.getByRole("button", { name: "Undo", exact: true }).click();
    await expect(
      page.getByText(`Undid ${changedTags} tag changes`, { exact: true })
    ).toBeVisible();
    await menu.getByRole("button", { name: "Edit tags", exact: true }).click();
    await expect(partial).toHaveAttribute("aria-checked", "mixed");
    await page.keyboard.press("Escape");
    await expect(tagsDialog).toBeHidden();

    const photo = page.locator('[data-photo-id="180"][role="option"]');
    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = document
            .querySelector(".selection-action-layer")
            ?.getBoundingClientRect();
          const toast = document
            .querySelector('[data-sonner-toast][data-front="true"]')
            ?.getBoundingClientRect();
          return !(toast && selection) || toast.bottom <= selection.top - 4;
        })
      )
      .toBe(true);

    await menu
      .getByRole("button", { name: "Add to Album", exact: true })
      .click();
    const albumsDialog = page.getByRole("dialog", {
      name: "Add to Album",
      exact: true,
    });
    await albumsDialog
      .getByRole("button", { name: "RecentTargetFixture", exact: true })
      .click();
    await expect(albumsDialog).toBeHidden();
    await menu
      .getByRole("button", { name: "Add to Album", exact: true })
      .click();
    await expect(
      albumsDialog.getByRole("button", {
        name: "Add again to “RecentTargetFixture”",
        exact: true,
      })
    ).toBeVisible();
    await assertBounds();
    await saveWindowScreenshot("recent-albums.png");
    await page.keyboard.press("Escape");

    await expect
      .poll(() =>
        page.evaluate(() => {
          const selection = document
            .querySelector(".selection-action-layer")
            ?.getBoundingClientRect();
          const toast = document
            .querySelector('[data-sonner-toast][data-front="true"]')
            ?.getBoundingClientRect();
          return !(toast && selection) || toast.bottom <= selection.top - 4;
        })
      )
      .toBe(true);

    const outputPath = path.join(root, `export-${size.width}.zip`);
    await app.evaluate(({ dialog, shell }, target) => {
      dialog.showSaveDialog = () =>
        Promise.resolve({ canceled: false, filePath: target });
      const state = globalThis as typeof globalThis & {
        experienceOpened?: string[];
      };
      state.experienceOpened = [];
      shell.showItemInFolder = (value) => {
        state.experienceOpened?.push(value);
      };
    }, outputPath);
    await menu.getByRole("button", { name: "Export", exact: true }).click();
    const exportDialog = page.getByRole("dialog", { name: EXPORT_TITLE });
    await exportDialog
      .getByRole("button", { name: "Compressed", exact: true })
      .click();
    const ranges = exportDialog.getByRole("slider");
    await ranges.nth(0).focus();
    await page.keyboard.press("Home");
    for (let index = 0; index < 12; index++) {
      await page.keyboard.press("ArrowRight");
    }
    await ranges.nth(1).focus();
    await page.keyboard.press("Home");
    for (let index = 0; index < 4; index++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(exportDialog.getByRole("checkbox")).not.toBeChecked();
    await assertBounds();
    await exportDialog
      .getByRole("button", { name: "Export", exact: true })
      .click();
    await expect(
      exportDialog.getByRole("button", { name: "Open folder", exact: true })
    ).toBeVisible();
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { experienceOpened?: string[] })
            .experienceOpened
      )
    ).toEqual([]);
    await assertBounds();
    await saveWindowScreenshot("export-complete.png");
    await exportDialog
      .getByRole("button", { name: "Open folder", exact: true })
      .click();
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as typeof globalThis & { experienceOpened?: string[] })
              .experienceOpened
        )
      )
      .toEqual([outputPath]);
    await exportDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await menu.getByRole("button", { name: "Export", exact: true }).click();
    await expect(ranges.nth(0)).toHaveValue("70");
    await expect(ranges.nth(1)).toHaveValue("1280");
    await exportDialog
      .getByRole("button", { name: "Close", exact: true })
      .click();

    await menu.getByRole("button", { name: "Delete", exact: true }).click();
    const deleteDialog = page.getByRole("alertdialog", {
      name: "Confirm Delete",
      exact: true,
    });
    await assertBounds();
    await deleteDialog
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    const deleteToast = page
      .locator("[data-sonner-toast]")
      .filter({ hasText: `Deleted ${changedTags + 1} photos` });
    await expect(
      deleteToast.getByRole("button", {
        name: "View recently deleted",
        exact: true,
      })
    ).toBeVisible();
    await deleteToast
      .getByRole("button", { name: "Undo", exact: true })
      .click();
    await expect(photo).toBeVisible();
    await expect(
      page
        .locator('[data-sonner-toast][data-front="true"]')
        .getByText(`Restored ${changedTags + 1} photos`, { exact: true })
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await assertBounds();
  });

  test(`${size.width}x${size.height} saves and reapplies complete search criteria`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    await navigate("/albums/9001");
    await navigate(
      "/?searchQuery=ReturnFixture&creator=PresetCreator&colorHex=4b87b9"
    );
    const input = page.locator(".home-search-form input[role='combobox']");
    await expect(input).toHaveValue("ReturnFixture");
    const viewportWidth = await page.evaluate(() => innerWidth);
    if (viewportWidth <= 1120) {
      await page
        .getByRole("button", { name: "View options", exact: true })
        .click();
    }
    await page.getByRole("combobox", { name: "Sort by", exact: true }).click();
    await page
      .getByRole("option", { name: "Filename A→Z", exact: true })
      .click();
    if (viewportWidth <= 1120) {
      await page.keyboard.press("Escape");
    }
    await expect(page.locator("[data-search-preset-strip]")).toHaveCount(0);
    await input.click();
    await page
      .locator('[data-overlay-kind="search-suggestions"]')
      .getByRole("button", { name: "Save search", exact: true })
      .click();
    const save = page.locator('[data-overlay-kind="filter-presets"]');
    await save.getByPlaceholder("Preset name...").fill(`Search-${size.width}`);
    await save.getByRole("button", { name: "Save", exact: true }).click();
    await expect(save).toBeHidden();
    const preset = await page.evaluate(
      (name) =>
        JSON.parse(localStorage.getItem("exif-filter-presets") ?? "[]").find(
          (item: { name: string }) => item.name === name
        ),
      `Search-${size.width}`
    );
    expect(preset).toMatchObject({
      filters: { creator: "PresetCreator" },
      search: {
        query: "ReturnFixture",
        colorHex: "4b87b9",
        sort: "name",
        order: "asc",
      },
    });
    await page.evaluate((name) => {
      const stored = JSON.parse(
        localStorage.getItem("exif-filter-presets") ?? "[]"
      );
      const saved = stored.find((item: { name: string }) => item.name === name);
      const latest = stored.reduce(
        (time: number, item: { lastUsedAt?: number }) =>
          Math.max(time, (item.lastUsedAt ?? 0) + 1),
        Date.now()
      );
      const fixtures = [
        { ...saved, name: "RecentFixture-Latest", lastUsedAt: latest },
        { ...saved, name: "RecentFixture-Earlier", lastUsedAt: latest - 1 },
        ...Array.from({ length: 12 }, (_, index) => ({
          ...saved,
          name: `OverflowFixture-Long-search-combination-${index}`,
          lastUsedAt: undefined,
        })),
      ];
      localStorage.setItem(
        "exif-filter-presets",
        JSON.stringify([
          ...stored.filter(
            (item: { name: string }) =>
              !(
                item.name.startsWith("RecentFixture-") ||
                item.name.startsWith("OverflowFixture-")
              )
          ),
          ...fixtures,
        ])
      );
      window.dispatchEvent(new Event("search-presets-changed"));
    }, `Search-${size.width}`);
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await expect(input).toHaveValue("");
    await page.getByRole("button", { name: PHOTO_MODE }).focus();
    await input.click();
    const strip = page.locator("[data-search-preset-strip]");
    await expect(strip).toBeVisible();
    await page.mouse.move(0, 0);
    await expect(strip).toHaveCSS("scrollbar-width", "thin");
    await expect(strip).toHaveCSS(
      "scrollbar-color",
      "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)"
    );
    await expect(strip).toHaveAttribute("data-left-fade", "false");
    await expect(strip).toHaveAttribute("data-right-fade", "true");
    await expect(strip.locator("[data-search-preset]").first()).toHaveAttribute(
      "data-search-preset",
      "RecentFixture-Latest"
    );
    expect(
      await strip.evaluate((element) => ({
        overflows: element.scrollWidth > element.clientWidth,
        rows: new Set(
          [...element.querySelectorAll("[data-search-preset]")].map((button) =>
            Math.round(button.getBoundingClientRect().top)
          )
        ).size,
      }))
    ).toEqual({ overflows: true, rows: 1 });
    await expect(
      page.locator('[data-overlay-kind="filter-presets"]')
    ).toHaveCount(0);
    await assertBounds();
    await saveWindowScreenshot("search-presets.png");
    await page.mouse.move(0, 0);
    await strip.locator("[data-search-preset]").first().hover();
    const presetTooltip = page
      .locator('[data-overlay-kind="search-suggestions"]')
      .locator('[data-slot="tooltip-content"]');
    await expect(presetTooltip).toBeVisible();
    await expect(presetTooltip.getByRole("tooltip")).toHaveText(
      "RecentFixture-Latest"
    );
    expect(
      await presetTooltip.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const topmost = document.elementFromPoint(
          rect.x + rect.width / 2,
          rect.y + rect.height / 2
        );
        return Boolean(topmost && element.contains(topmost));
      })
    ).toBe(true);
    await saveWindowScreenshot("search-presets-tooltip.png");
    await page.mouse.move(0, 0);
    await strip.hover();
    await expect(strip).not.toHaveCSS(
      "scrollbar-color",
      "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)"
    );
    await saveWindowScreenshot("search-presets-hover.png");
    await page.mouse.wheel(600, 0);
    await expect
      .poll(() => strip.evaluate((element) => element.scrollLeft))
      .toBeGreaterThan(0);
    await expect(strip).toHaveAttribute("data-left-fade", "true");
    await expect(strip).toHaveAttribute("data-right-fade", "true");
    await saveWindowScreenshot("search-presets-middle.png");
    await strip.evaluate((element) => {
      element.scrollLeft = element.scrollWidth;
    });
    await expect(strip).toHaveAttribute("data-left-fade", "true");
    await expect(strip).toHaveAttribute("data-right-fade", "false");
    await saveWindowScreenshot("search-presets-end.png");
    await page.mouse.move(0, 0);
    await expect(strip).toHaveCSS(
      "scrollbar-color",
      "rgba(0, 0, 0, 0) rgba(0, 0, 0, 0)"
    );
    await strip
      .getByRole("button", { name: `Search-${size.width}`, exact: true })
      .focus();
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("ReturnFixture");
    await expect(
      page.getByText("PresetCreator", { exact: true })
    ).toBeVisible();
    expect(
      await page.evaluate(() => ({
        sort: localStorage.getItem("grid_sort_field"),
        order: localStorage.getItem("grid_sort_order"),
      }))
    ).toEqual({ sort: "name", order: "asc" });
    await input.click();
    await expect(input).toBeFocused();
    await expect(strip).toBeVisible();
    await expect(strip.locator("[data-search-preset]").first()).toHaveAttribute(
      "data-search-preset",
      `Search-${size.width}`
    );
    await saveWindowScreenshot("search-presets-recent.png");
    await assertBounds();
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    if (viewportWidth <= 1120) {
      await page
        .getByRole("button", { name: "View options", exact: true })
        .click();
    }
    await page.getByRole("combobox", { name: "Sort by", exact: true }).click();
    await page
      .getByRole("option", { name: "Date New→Old", exact: true })
      .click();
    if (viewportWidth <= 1120) {
      await page.keyboard.press("Escape");
    }
  });
}

for (const size of SIZES) {
  test(`${size.width}x${size.height} keeps album and people batch tag editing within the viewport`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(requested.width, requested.height);
        window.webContents.setZoomFactor(Number(requested.zoom));
      },
      { ...size, zoom: process.env.AIM_E2E_UI_ZOOM ?? "1" }
    );
    for (const route of ["/albums/9001", "/people/9003"]) {
      await navigate(route);
      await page.getByRole("button", { name: PHOTO_MODE }).click();
      await selectAllPhotos();
      await page
        .locator(".selection-menu")
        .getByRole("button", { name: "Edit tags", exact: true })
        .click();
      const dialog = page.getByRole("dialog", { name: EDIT_TAGS });
      await expect(
        dialog.getByRole("checkbox", {
          name: "BatchFixtureCommon",
          exact: true,
        })
      ).toBeChecked();
      await expect(
        dialog.getByRole("checkbox", {
          name: "BatchFixturePartial",
          exact: true,
        })
      ).toHaveAttribute("aria-checked", "mixed");
      await assertBounds();
      await saveWindowScreenshot(
        route.startsWith("/albums")
          ? "album-batch-tags.png"
          : "people-batch-tags.png"
      );
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator(".selection-menu-count")).toHaveText(
        SCOPE_COUNTER
      );
      const count = Number(
        (await page.locator(".selection-menu-count").innerText()).split(
          " / "
        )[0]
      );
      await page
        .locator(".selection-menu")
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await page
        .getByRole("alertdialog", { name: "Confirm Delete", exact: true })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await page
        .locator("[data-sonner-toast]")
        .filter({ hasText: `Deleted ${count} photos` })
        .getByRole("button", { name: "Undo", exact: true })
        .click();
      await expect(
        page.locator('[data-photo-id="180"][role="option"]')
      ).toBeVisible();
      await assertBounds();
      await page.keyboard.press("Escape");
    }
  });
}

test("keeps the gallery interactive after batch tagging and selecting the tag tree", async () => {
  const errors: string[] = [];
  const captureError = (error: Error) =>
    errors.push(error.stack ?? error.message);
  const captureConsole = (message: { text: () => string }) => {
    if (message.text().includes("Maximum update depth")) {
      errors.push(message.text());
    }
  };
  page.on("pageerror", captureError);
  page.on("console", captureConsole);
  try {
    execFileSync(
      electronPath,
      [
        "-e",
        "const D=require('better-sqlite3');const db=new D(process.argv[1]);try{db.exec(require('node:fs').readFileSync(0,'utf8'))}finally{db.close()}",
        path.join(profile, "data", "ai-image-manager.db"),
      ],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        input:
          "INSERT OR IGNORE INTO tags(id,name,created_at) VALUES(9104,'RenderFixtureRoot',1); UPDATE tags SET parent_id=9104 WHERE id=9103; INSERT OR IGNORE INTO photo_tags(photo_id,tag_id,confidence,origin,is_confirmed,user_confirmed) SELECT id,9103,0.9,'auto',1,0 FROM photos WHERE id BETWEEN 97 AND 113;",
      }
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 800)
    );
    await navigate("/");
    await page.getByRole("button", { name: PHOTO_MODE }).click();
    await page
      .locator('[data-photo-id="180"][role="option"]')
      .click({ modifiers: ["Control"] });
    await page
      .locator('[data-photo-id="179"][role="option"]')
      .click({ modifiers: ["Control"] });
    await page
      .locator(".selection-menu")
      .getByRole("button", { name: "Edit tags", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: EDIT_TAGS });
    await dialog
      .getByRole("checkbox", { name: "BatchFixtureNone", exact: true })
      .check();
    await page.evaluate(() => {
      const state = window as typeof window & { batchTagPageRequests: number };
      state.batchTagPageRequests = 0;
      const send = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function (message, transfer) {
        const request =
          typeof message === "string" ? JSON.parse(message) : message;
        if (request?.p?.u?.includes("listPhotoPage")) {
          state.batchTagPageRequests++;
        }
        if (Array.isArray(transfer)) {
          send.call(this, message, { transfer });
        } else {
          send.call(this, message, transfer ?? {});
        }
      };
    });
    await dialog
      .getByRole("button", { name: "Apply tag changes", exact: true })
      .click();
    await expect(dialog).toBeHidden();
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { batchTagPageRequests: number })
            .batchTagPageRequests
      )
    ).toBe(0);
    await page.keyboard.press("Escape");
    const expand = page.getByRole("button", {
      name: "Expand sidebar",
      exact: true,
    });
    if (await expand.isVisible()) {
      await expand.click();
    }
    await page.getByRole("button", { name: "Tags", exact: true }).click();
    await page
      .getByRole("searchbox", { name: "Search tags...", exact: true })
      .fill("BatchFixtureNone");
    await page.locator('[data-tag-id="9103"] button').last().click();
    await expect(page.locator('[data-photo-id][role="option"]')).toHaveCount(
      19
    );
    const gallery = page.locator("[data-masonry-scroll]");
    await gallery.hover();
    await page.mouse.wheel(0, 500);
    await expect
      .poll(() => gallery.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    await page.locator('[data-photo-id="180"][role="option"]').click();
    await expect(page.locator(".selection-menu-count")).toHaveText(
      "1 / 19 selected"
    );
    await page.keyboard.press("Space");
    await expect(
      page.locator('[data-overlay-kind="quick-preview"]')
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(
      page.locator('[data-overlay-kind="quick-preview"]')
    ).toBeHidden();
    await saveWindowScreenshot("batch-tag-tree-filter.png");
    page.off("pageerror", captureError);
    page.off("console", captureConsole);
    await app.close();
    await launch();
    page.on("pageerror", captureError);
    page.on("console", captureConsole);
    await expect(
      page.locator('[data-photo-id="180"][role="option"]')
    ).toBeVisible();
    const expandAfterRestart = page.getByRole("button", {
      name: "Expand sidebar",
      exact: true,
    });
    if (await expandAfterRestart.isVisible()) {
      await expandAfterRestart.click();
    }
    await page.getByRole("button", { name: "Tags", exact: true }).click();
    await page
      .getByRole("searchbox", { name: "Search tags...", exact: true })
      .fill("BatchFixtureNone");
    await page.locator('[data-tag-id="9103"] button').last().click();
    await expect(page.locator('[data-photo-id][role="option"]')).toHaveCount(
      19
    );
    await page.locator('[data-photo-id="179"][role="option"]').click();
    await expect(page.locator(".selection-menu-count")).toHaveText(
      "1 / 19 selected"
    );
    await saveWindowScreenshot("batch-tag-tree-after-restart.png");
    expect(errors).toEqual([]);
  } finally {
    page.off("pageerror", captureError);
    page.off("console", captureConsole);
    fs.writeFileSync(
      test.info().outputPath("batch-tag-tree-errors.json"),
      JSON.stringify(errors, null, 2)
    );
  }
});
