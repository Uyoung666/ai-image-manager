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
const sizes = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const routes = ["/", "/albums/9002", "/people/9002"];
const targetSequence = 70;
const targetPhoto = targetSequence * 1000 + 1;
const sequenceButtonName = /^Sequences/;
const frame80ButtonName = /Open frame 80:/;
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

interface SequenceFocusSample {
  center: number | null;
  imageLoaded: boolean;
  imageOpacity: number;
  innerTop: number;
  mounted: boolean;
  outerTop: number;
  sameCard: boolean;
  sameTray: boolean;
  selected: boolean;
  time: number;
}

declare global {
  interface Window {
    sequenceFocusProbe?: { stop: () => SequenceFocusSample[] };
    sequenceGetGate?: {
      held: boolean;
      release: () => void;
      restore: () => void;
    };
  }
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
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("ui.reduceMotion", "true");
    localStorage.setItem("sidebar_collapsed", "true");
    localStorage.setItem("grid_column_width", "180");
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
}

test.describe.configure({ mode: "default" });
test.setTimeout(120_000);
test.beforeAll(async () => {
  root = createTestRuntime("sequence-click-focus");
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
  const heights = [70, 140, 100, 220];
  const images = await Promise.all(
    heights.map((height) =>
      sharp({
        create: {
          width: 120,
          height,
          channels: 3,
          background: { r: 70, g: 130, b: 180 },
        },
      })
        .png()
        .toBuffer()
    )
  );
  const escapeSql = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${escapeSql(fixture)}','SequenceFocusFixture',652,1)`,
    "INSERT INTO albums(id,name,created_at) VALUES(9002,'SequenceFocusFixture',1)",
    "INSERT INTO face_identities(id,name,representative_photo_id,face_count,is_confirmed,created_at) VALUES(9002,'SequenceFocusFixture',NULL,652,1,1)",
  ];
  for (let sequenceId = 1; sequenceId <= 140; sequenceId++) {
    const count = sequenceId === targetSequence ? 96 : 4;
    const representativeId = sequenceId * 1000 + 1;
    for (let frame = 1; frame <= count; frame++) {
      const id = sequenceId * 1000 + frame;
      const filename = `SequenceFocus-${sequenceId}-${String(frame).padStart(3, "0")}.png`;
      const photoPath = path.join(fixture, filename);
      const shape = frame === 1 ? 0 : (frame - 1) % heights.length;
      fs.writeFileSync(photoPath, images[shape]);
      statements.push(
        `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${escapeSql(photoPath)}','${filename}',1,1024,${id},120,${heights[shape]},'png','${escapeSql(photoPath)}',1,1,1,1)`,
        `INSERT INTO face_vectors(id,photo_id,bbox_x,bbox_y,bbox_width,bbox_height,confidence,created_at) VALUES(${id},${id},0.2,0.2,0.4,0.4,1,1)`,
        `INSERT INTO face_identity_members(identity_id,face_vector_id) VALUES(9002,${id})`
      );
    }
    statements.push(
      `INSERT INTO photo_sequences(id,folder_id,type,source,representative_photo_id,started_at,ended_at,frame_count,user_locked,created_at,updated_at) VALUES(${sequenceId},1,'burst','manual',${representativeId},${representativeId},${sequenceId * 1000 + count},${count},1,1,1)`
    );
    for (let frame = 1; frame <= count; frame++) {
      statements.push(
        `INSERT INTO photo_sequence_members(sequence_id,photo_id,position) VALUES(${sequenceId},${sequenceId * 1000 + frame},${frame - 1})`
      );
    }
  }
  statements.push(
    "INSERT INTO album_photos(album_id,photo_id) SELECT 9002,id FROM photos",
    `UPDATE face_identities SET representative_photo_id=${targetPhoto} WHERE id=9002`
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

test.beforeEach(async () => {
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
});

async function openGallery(route: string, size = { width: 1280, height: 800 }) {
  await app.evaluate(({ BrowserWindow }, requested) => {
    BrowserWindow.getAllWindows()[0].setSize(requested.width, requested.height);
  }, size);
  await page.evaluate((next) => window.__e2eNavigate?.(next), route);
  await page.getByRole("button", { name: sequenceButtonName }).click();
  await expect(page.locator("[data-masonry-scroll]")).toBeVisible();
  await expect
    .poll(() => page.locator("[data-sequence-id]").count())
    .toBeGreaterThan(3);
}

async function findSequence() {
  const card = page.locator(`[data-sequence-id="${targetSequence}"]`);
  const gallery = page.locator("[data-masonry-scroll]");
  await gallery.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect
    .poll(
      async () => {
        if (await card.count()) {
          return true;
        }
        await gallery.evaluate((element) => {
          element.scrollTop += element.clientHeight * 0.65;
        });
        return false;
      },
      { timeout: 30_000, intervals: [100, 150] }
    )
    .toBe(true);
  await expect
    .poll(() =>
      gallery.evaluate((scroll, id) => {
        const element = scroll.querySelector<HTMLElement>(
          `[data-sequence-id="${id}"]`
        );
        if (!element) {
          return false;
        }
        const inset =
          document
            .querySelector(
              ".home-gallery-toolbar-layer, .page-toolbar.absolute"
            )
            ?.getBoundingClientRect().height ?? 0;
        scroll.scrollTop +=
          element.getBoundingClientRect().top -
          scroll.getBoundingClientRect().top -
          inset -
          40;
        return true;
      }, targetSequence)
    )
    .toBe(true);
  await expect
    .poll(() =>
      card
        .locator("img")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth > 0)
    )
    .toBe(true);
  return card;
}

async function clickVisible(card: Locator, count = 1) {
  const point = { x: 0, y: 0 };
  await expect
    .poll(async () => {
      const result = await card.evaluate((element) => {
        const scroll = element.closest<HTMLElement>("[data-masonry-scroll]");
        if (!scroll) {
          throw new Error("Missing masonry scroll surface");
        }
        const bounds = scroll.getBoundingClientRect();
        const inner = element
          .closest("[data-sequence-virtual-scroll]")
          ?.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const inset =
          document
            .querySelector(
              ".home-gallery-toolbar-layer, .page-toolbar.absolute"
            )
            ?.getBoundingClientRect().height ?? 0;
        const bottomPadding =
          Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0;
        const status = document
          .querySelector(".home-gallery-status-bar")
          ?.getBoundingClientRect();
        const top = Math.max(
          rect.top + 2,
          bounds.top + inset + 2,
          inner?.top ?? 0
        );
        const bottom = Math.min(
          rect.bottom - 2,
          bounds.top + scroll.clientHeight - bottomPadding - 2,
          inner?.bottom ?? innerHeight,
          status && status.height > 0 ? status.top : innerHeight
        );
        const left = Math.max(rect.left + 2, bounds.left);
        const right = Math.min(rect.right - 2, bounds.right);
        for (const yRatio of [0.5, 0.25, 0.75]) {
          for (const xRatio of [0.5, 0.25, 0.75]) {
            const candidate = {
              x: left + (right - left) * xRatio,
              y: top + (bottom - top) * yRatio,
            };
            const hit = document.elementFromPoint(candidate.x, candidate.y);
            if (
              bottom > top &&
              right > left &&
              element.contains(hit) &&
              !hit?.closest("button, input, a")
            ) {
              return candidate;
            }
          }
        }
        return null;
      });
      if (result) {
        Object.assign(point, result);
      }
      return Boolean(result);
    })
    .toBe(true);
  await page.mouse.click(point.x, point.y, { clickCount: count });
  await page.mouse.move(1, 1);
}

async function clickVisibleButton(button: Locator) {
  const point = { x: 0, y: 0 };
  await expect
    .poll(async () => {
      const result = await button.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const candidate = {
          x: (bounds.left + bounds.right) / 2,
          y: (bounds.top + bounds.bottom) / 2,
        };
        return element.contains(
          document.elementFromPoint(candidate.x, candidate.y)
        )
          ? candidate
          : null;
      });
      if (result) {
        Object.assign(point, result);
      }
      return Boolean(result);
    })
    .toBe(true);
  // Leave closing/reopening geometry intact: locator.click would scroll the
  // parent card before dispatching the new request and hide a return race.
  await page.mouse.click(point.x, point.y);
  await page.mouse.move(1, 1);
}

async function backToTop() {
  const gallery = page.locator("[data-masonry-scroll]");
  // The button is intentionally revealed only beyond two gallery viewports.
  // Keep the detail open, including while its real IPC response is held.
  await gallery.evaluate((element) => {
    element.scrollTop = Math.max(
      element.scrollTop,
      element.clientHeight * 2 + 200
    );
  });
  const button = page.getByRole("button", { name: "Back to top", exact: true });
  await expect(button).toBeVisible();
  await button.click();
  await expect
    .poll(() => gallery.evaluate((element) => element.scrollTop))
    .toBe(0);
}

async function focusGeometry(card: Locator) {
  return await card.evaluate((element) => {
    const scroll = element.closest<HTMLElement>("[data-masonry-scroll]");
    if (!scroll) {
      throw new Error("Missing masonry scroll surface");
    }
    const bounds = scroll.getBoundingClientRect();
    const inner = element.closest<HTMLElement>(
      "[data-sequence-virtual-scroll]"
    );
    const innerBounds = inner?.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const inset =
      document
        .querySelector(".home-gallery-toolbar-layer, .page-toolbar.absolute")
        ?.getBoundingClientRect().height ?? 0;
    const bottomPadding =
      Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0;
    const top = bounds.top + inset;
    const bottom = bounds.top + scroll.clientHeight - bottomPadding;
    const visibleTop = Math.max(top, innerBounds?.top ?? top);
    const visibleBottom = Math.min(bottom, innerBounds?.bottom ?? bottom);
    const error = (rect.top + rect.bottom - top - bottom) / 2;
    const desiredOuter = Math.max(
      0,
      Math.min(
        scroll.scrollTop + error,
        scroll.scrollHeight - scroll.clientHeight
      )
    );
    return {
      error,
      outerError: scroll.scrollTop - desiredOuter,
      fullyVisible:
        rect.top >= visibleTop - 2 && rect.bottom <= visibleBottom + 2,
      fits:
        rect.height <=
        Math.min(bottom - top, inner?.clientHeight ?? bottom - top) + 2,
      innerTop: inner?.scrollTop,
      outerTop: scroll.scrollTop,
      cardTop: rect.top,
      cardBottom: rect.bottom,
      visibleTop,
      visibleBottom,
      viewportTop: top,
      viewportBottom: bottom,
      outerHeight: scroll.clientHeight,
      outerScrollHeight: scroll.scrollHeight,
      bottomPadding,
      inset,
    };
  });
}

async function expectCentered(card: Locator, member = false) {
  try {
    await expect
      .poll(async () => {
        const geometry = await focusGeometry(card);
        return (
          Math.abs(member ? geometry.error : geometry.outerError) <= 2 &&
          (!geometry.fits || geometry.fullyVisible)
        );
      })
      .toBe(true);
    if (member) {
      await expect
        .poll(() =>
          card
            .locator("img")
            .evaluate(
              (element) =>
                (element as HTMLImageElement).naturalWidth > 0 &&
                Number.parseFloat(getComputedStyle(element).opacity) === 1
            )
        )
        .toBe(true);
    }
  } catch (error) {
    await page.screenshot({
      path: test.info().outputPath("focus-failure.png"),
    });
    throw error;
  } finally {
    const geometryPath = test
      .info()
      .outputPath(`focus-geometry-${Date.now()}.json`);
    fs.writeFileSync(
      geometryPath,
      JSON.stringify(await focusGeometry(card), null, 2)
    );
    await test.info().attach("focus-geometry", {
      path: geometryPath,
      contentType: "application/json",
    });
  }
}

async function assertBounds() {
  const issues = await page.evaluate(() => ({
    overflow: [
      document.documentElement,
      document.body,
      ...document.querySelectorAll("main"),
    ].some((element) => element.scrollWidth > element.clientWidth + 2),
    escaped: Array.from(
      document.querySelectorAll('[role="dialog"], [role="menu"]')
    )
      .filter((element) => element.getClientRects().length > 0)
      .some((element) => {
        const rect = element.getBoundingClientRect();
        return (
          rect.left < -1 ||
          rect.top < -1 ||
          rect.right > innerWidth + 1 ||
          rect.bottom > innerHeight + 1
        );
      }),
  }));
  expect(issues).toEqual({ overflow: false, escaped: false });
}

async function findMember(frame: number, fromEnd = false) {
  const inner = page.locator("[data-sequence-virtual-scroll]");
  const member = page.locator(
    `[data-sequence-tray-id="${targetSequence}"] [data-photo-id="${targetSequence * 1000 + frame}"][role="option"]`
  );
  await inner.evaluate((element, startAtEnd) => {
    element.scrollTop = startAtEnd ? element.scrollHeight : 0;
  }, fromEnd);
  await expect
    .poll(async () => {
      if (await member.count()) {
        return true;
      }
      await inner.evaluate((element) => {
        element.scrollTop += element.clientHeight * 0.7;
      });
      return false;
    })
    .toBe(true);
  await member.evaluate((element) => {
    const scroll = element.closest<HTMLElement>(
      "[data-sequence-virtual-scroll]"
    );
    if (!scroll) {
      throw new Error("Missing sequence scroll surface");
    }
    scroll.scrollTop +=
      element.getBoundingClientRect().top -
      scroll.getBoundingClientRect().top -
      16;
  });
  await expect
    .poll(() =>
      member
        .locator("img")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth > 0)
    )
    .toBe(true);
  return member;
}

async function startFocusProbe(card: Locator) {
  await expect(card.locator("img")).toHaveAttribute(
    "data-load-state",
    "loaded"
  );
  await expect
    .poll(() =>
      card.locator("img").evaluate((image) => getComputedStyle(image).opacity)
    )
    .toBe("1");
  await card.evaluate((element) => {
    window.sequenceFocusProbe?.stop();
    const id = element.getAttribute("data-photo-id");
    const tray = element.closest<HTMLElement>("[data-sequence-tray-id]");
    const inner = element.closest<HTMLElement>(
      "[data-sequence-virtual-scroll]"
    );
    const outer = element.closest<HTMLElement>("[data-masonry-scroll]");
    if (!(tray && inner && outer)) {
      throw new Error("Missing sequence focus surfaces");
    }
    const samples: SequenceFocusSample[] = [];
    let frame = 0;
    const sample = () => {
      const currentTray = document.querySelector(
        `[data-sequence-tray-id="${tray.dataset.sequenceTrayId}"]`
      );
      const card = currentTray?.querySelector<HTMLElement>(
        `[data-photo-id="${id}"][role="option"]`
      );
      const rect = card?.getBoundingClientRect();
      const image = card?.querySelector("img");
      samples.push({
        center: rect ? (rect.top + rect.bottom) / 2 : null,
        imageLoaded:
          Boolean(image?.complete && image.naturalWidth > 0) &&
          image?.dataset.loadState === "loaded",
        imageOpacity: image
          ? Number.parseFloat(getComputedStyle(image).opacity)
          : 0,
        innerTop: inner.scrollTop,
        mounted: Boolean(card),
        outerTop: outer.scrollTop,
        sameCard: card === element,
        sameTray: currentTray === tray,
        selected: card?.getAttribute("aria-selected") === "true",
        time: performance.now(),
      });
      frame = requestAnimationFrame(sample);
    };
    sample();
    window.sequenceFocusProbe = {
      stop: () => {
        cancelAnimationFrame(frame);
        window.sequenceFocusProbe = undefined;
        return samples;
      },
    };
  });
}

async function finishFocusProbe(name: string) {
  // A repeated single click keeps selection unchanged. Observe beyond the
  // card's 250ms double-click delay before checking that neither scroll moved.
  await page.waitForTimeout(350);
  // Capture a few settled paints as well as the positioning frames.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
  const samples = await page.evaluate(
    () => window.sequenceFocusProbe?.stop() ?? []
  );
  const probePath = test.info().outputPath(`${name}.json`);
  fs.writeFileSync(probePath, JSON.stringify(samples, null, 2));
  await test
    .info()
    .attach(name, { path: probePath, contentType: "application/json" });
  expect(samples.length).toBeGreaterThan(3);
  expect(samples.every((sample) => sample.sameTray)).toBe(true);
  expect(
    samples.every(
      (sample) =>
        sample.mounted && sample.imageLoaded && sample.imageOpacity === 1
    )
  ).toBe(true);
  return samples;
}

function expectNoScrollReversal(
  samples: SequenceFocusSample[],
  key: "innerTop" | "outerTop"
) {
  let forward = 0;
  let backward = 0;
  for (let index = 1; index < samples.length; index++) {
    const delta = samples[index][key] - samples[index - 1][key];
    if (delta > 2) {
      forward += delta;
    } else if (delta < -2) {
      backward -= delta;
    }
  }
  // Width updates can adjust fractional positions, but must not introduce a
  // visible trip to the row/tray center followed by a jump back to the photo.
  expect(Math.min(forward, backward)).toBeLessThanOrEqual(4);
}

async function trayColumns(tray: Locator) {
  return await tray
    .locator("[data-sequence-virtual-row]")
    .first()
    .evaluate(
      (row) =>
        getComputedStyle(row)
          .gridTemplateColumns.trim()
          .split(" ")
          .filter(Boolean).length
    );
}

async function expectKeyboardMember(tray: Locator, frame: number) {
  const member = tray.locator(
    `[data-photo-id="${targetSequence * 1000 + frame}"][role="option"]`
  );
  await expect(member).toHaveAttribute("aria-selected", "true");
  await expect(
    tray.locator('[role="option"][aria-selected="true"]')
  ).toHaveCount(1);
  await expectMemberVisible(member);
  await expect(member).toBeFocused();
  return member;
}

async function expectMemberVisible(member: Locator) {
  const samples: Awaited<ReturnType<typeof focusGeometry>>[] = [];
  try {
    await expect
      .poll(async () => {
        const geometry = await focusGeometry(member);
        samples.push(geometry);
        return geometry.fits
          ? geometry.fullyVisible
          : geometry.cardTop < geometry.visibleBottom &&
              geometry.cardBottom > geometry.visibleTop;
      })
      .toBe(true);
  } catch (error) {
    await test.info().attach("member-focus-geometry", {
      body: JSON.stringify(samples, null, 2),
      contentType: "application/json",
    });
    await page.screenshot({
      path: test.info().outputPath("member-focus-failure.png"),
    });
    throw error;
  }
  await expect(member.locator("img")).toHaveAttribute(
    "data-load-state",
    "loaded"
  );
}

for (const size of sizes) {
  for (const route of routes) {
    test(`${size.width}x${size.height} ${route} focuses a folded sequence and keeps sidebar frame clicks folded`, async () => {
      await openGallery(route, size);
      const card = await findSequence();
      const gallery = page.locator("[data-masonry-scroll]");
      const before = await gallery.evaluate((element) => ({
        top: element.scrollTop,
        width: element.clientWidth,
      }));
      const retainedImage = await card.locator("img").elementHandle();
      await clickVisible(card);
      const close = page.getByRole("button", {
        name: "Close sequence details",
        exact: true,
      });
      await expect(close).toBeVisible();
      await expect(card).toHaveAttribute("aria-pressed", "true");
      if (size.width === 1280) {
        await expectCentered(card);
        expect(
          await retainedImage?.evaluate((image) => image.isConnected)
        ).toBe(true);
      } else {
        await expect(
          page.locator('[role="dialog"]').filter({ has: close })
        ).toBeVisible();
        await expect
          .poll(() => gallery.evaluate((element) => element.clientWidth))
          .toBe(before.width);
        await expect
          .poll(() => gallery.evaluate((element) => element.scrollTop))
          .toBeCloseTo(before.top, 0);
      }
      await assertBounds();
      await page.getByRole("button", { name: frame80ButtonName }).click();
      await expect(
        page.getByRole("button", {
          name: "Back to sequence details",
          exact: true,
        })
      ).toBeVisible();
      await expect(page.locator("[data-sequence-tray-id]")).toHaveCount(0);
      if (size.width === 1280) {
        await expectCentered(card);
      }
      await assertBounds();
      await page
        .getByRole("button", { name: "Back to sequence details", exact: true })
        .click();
      await close.click();
      await expect(close).toHaveCount(0);
      if (route.startsWith("/people/")) {
        // The person page preserves its photo-detail layer when returning to a
        // sequence. Dismiss that existing layer before using the gallery again.
        await page.keyboard.press("Escape");
      } else {
        await expect(card).toBeFocused();
        await expect
          .poll(async () => (await focusGeometry(card)).fullyVisible)
          .toBe(true);
      }
      await assertBounds();
      await page.screenshot({
        path: test.info().outputPath("folded-sequence.png"),
      });
    });
  }
}

test("1280x800 the frame-count button centers an unselected sequence on each shared gallery", async () => {
  for (const route of routes) {
    await openGallery(route);
    const card = await findSequence();
    await expect(card).toHaveAttribute("aria-pressed", "false");
    await card.locator("button").last().click();
    await page.mouse.move(1, 1);
    const close = page.getByRole("button", {
      name: "Close sequence details",
      exact: true,
    });
    await expect(close).toBeVisible();
    await expect(card).toHaveAttribute("aria-pressed", "false");
    await expectCentered(card);
    await assertBounds();
    await close.click();
    await expect(close).toHaveCount(0);
  }
});

test("1280x800 a rapid sequence detail reopen keeps the latest frame-count click centered", async () => {
  for (const route of ["/albums/9002", "/people/9002"]) {
    await openGallery(route);
    const card = await findSequence();
    await clickVisible(card);
    await expectCentered(card);
    await page.getByRole("button", { name: frame80ButtonName }).click();
    await page
      .getByRole("button", { name: "Back to sequence details", exact: true })
      .click();
    const close = page.getByRole("button", {
      name: "Close sequence details",
      exact: true,
    });
    await close.click();
    if (route.startsWith("/people/")) {
      // Preserve the person's existing two-layer close behavior.
      await page.keyboard.press("Escape");
    }
    await clickVisibleButton(card.locator("button").last());
    await expect(close).toBeVisible();
    // Neighboring fixture sequences have only four frames, so frame 80 proves
    // the real click reopened the intended sequence during its width change.
    await expect(
      page.getByRole("button", { name: frame80ButtonName })
    ).toHaveCount(1);
    await expectCentered(card);
    await assertBounds();
    await close.click();
  }
});

for (const route of routes) {
  test(`1280x800 ${route} reveals expanded members only when clipped across reflow, repeat clicks and sidebar frame changes`, async () => {
    await openGallery(route);
    const card = await findSequence();
    await card
      .getByRole("button", { name: "Expand sequence photos", exact: true })
      .click();
    const tray = page.locator(`[data-sequence-tray-id="${targetSequence}"]`);
    await expect(tray).toBeVisible();
    const retainedTray = await tray.elementHandle();
    const member = await findMember(8);
    await startFocusProbe(member);
    await clickVisible(member);
    await expect(member).toHaveAttribute("aria-selected", "true");
    await expectMemberVisible(member);
    const openingSamples = await finishFocusProbe("member-open-reflow");
    expectNoScrollReversal(openingSamples, "outerTop");
    expectNoScrollReversal(openingSamples, "innerTop");
    expect(await retainedTray?.evaluate((element) => element.isConnected)).toBe(
      true
    );

    // Position an already selected member near the inner edge, then repeat.
    const repeatGeometry = await focusGeometry(member);
    const repeatTop =
      repeatGeometry.visibleTop +
      Math.min(
        8,
        Math.max(
          0,
          (repeatGeometry.visibleBottom -
            repeatGeometry.visibleTop -
            (repeatGeometry.cardBottom - repeatGeometry.cardTop)) /
            2
        )
      );
    await member.evaluate((element, visibleTop) => {
      const scroll = element.closest<HTMLElement>(
        "[data-sequence-virtual-scroll]"
      );
      if (scroll) {
        scroll.scrollTop += element.getBoundingClientRect().top - visibleTop;
      }
    }, repeatTop);
    await expectMemberVisible(member);
    await startFocusProbe(member);
    await clickVisible(member);
    await expectMemberVisible(member);
    const repeatSamples = await finishFocusProbe(
      "member-repeat-stable-sidebar"
    );
    expect(repeatSamples.every((sample) => sample.sameCard)).toBe(true);
    const outerPositions = repeatSamples.map((sample) => sample.outerTop);
    expect(
      Math.max(...outerPositions) - Math.min(...outerPositions)
    ).toBeLessThanOrEqual(2);
    const innerPositions = repeatSamples.map((sample) => sample.innerTop);
    expect(
      Math.max(...innerPositions) - Math.min(...innerPositions)
    ).toBeLessThanOrEqual(2);

    const visibleNeighbor = tray.locator(
      `[data-photo-id="${targetSequence * 1000 + 7}"][role="option"]`
    );
    await expectMemberVisible(visibleNeighbor);
    await startFocusProbe(visibleNeighbor);
    await clickVisible(visibleNeighbor);
    await expect(visibleNeighbor).toHaveAttribute("aria-selected", "true");
    await expectMemberVisible(visibleNeighbor);
    const neighborSamples = await finishFocusProbe("member-visible-neighbor");
    for (const key of ["innerTop", "outerTop"] as const) {
      const positions = neighborSamples.map((sample) => sample[key]);
      expect(
        Math.max(...positions) - Math.min(...positions)
      ).toBeLessThanOrEqual(2);
    }

    const quickFirst = await findMember(9);
    const quickLast = tray.locator(
      `[data-photo-id="${targetSequence * 1000 + 10}"][role="option"]`
    );
    await clickVisible(quickFirst);
    await clickVisible(quickLast);
    await expect(quickLast).toHaveAttribute("aria-selected", "true");
    await expect(quickFirst).toHaveAttribute("aria-selected", "false");
    await expectMemberVisible(quickLast);

    // The existing expanded structure must be used when a sidebar opens frame 80.
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("button", {
        name: "Back to sequence details",
        exact: true,
      })
    ).toHaveCount(0);
    await tray
      .getByRole("button", { name: "Collapse sequence", exact: true })
      .click();
    const folded = await findSequence();
    await folded.locator("button").last().click();
    await expect(
      page.getByRole("button", { name: "Close sequence details", exact: true })
    ).toBeVisible();
    await folded
      .getByRole("button", { name: "Expand sequence photos", exact: true })
      .click();
    await expect(tray).toBeVisible();
    await page.getByRole("button", { name: frame80ButtonName }).click();
    const frame80 = tray.locator(
      `[data-photo-id="${targetSequence * 1000 + 80}"][role="option"]`
    );
    await expect(frame80).toBeVisible();
    await expectMemberVisible(frame80);
    await expect(tray).toHaveCount(1);
    await assertBounds();
    await page.screenshot({
      path: test.info().outputPath("expanded-member.png"),
    });
  });
}

test("1280x800 restores an offscreen expanded sequence when a sidebar frame is clicked", async () => {
  for (const route of routes) {
    await openGallery(route);
    const card = await findSequence();
    await clickVisibleButton(card.locator("button").last());
    const close = page.getByRole("button", {
      name: "Close sequence details",
      exact: true,
    });
    await expect(close).toBeVisible();
    await expectCentered(card);
    await card
      .getByRole("button", { name: "Expand sequence photos", exact: true })
      .click();
    const tray = page.locator(`[data-sequence-tray-id="${targetSequence}"]`);
    await expect(tray).toBeVisible();

    await backToTop();
    await expect(close).toBeVisible();
    await expect.poll(() => tray.count()).toBe(0);
    // The pending member must remount the actual tray with its images enabled;
    // an offscreen placeholder cannot publish coordinates for its virtual row.
    await page.getByRole("button", { name: frame80ButtonName }).click();
    const frame80 = tray.locator(
      `[data-photo-id="${targetSequence * 1000 + 80}"][role="option"]`
    );
    await expect(frame80).toBeVisible();
    await expect(frame80).toHaveAttribute("aria-selected", "true");
    await expectMemberVisible(frame80);
    await expect(tray).toHaveCount(1);
    await assertBounds();
  }
});

for (const size of sizes) {
  test(`${size.width}x${size.height} expanded member arrows follow the latest member and preserve the detail display mode`, async () => {
    await openGallery("/", size);
    const card = await findSequence();
    await card
      .getByRole("button", { name: "Expand sequence photos", exact: true })
      .click();
    const tray = page.locator(`[data-sequence-tray-id="${targetSequence}"]`);
    let current = 8;
    const initial = await findMember(current);
    if (size.width === 1280) {
      await clickVisible(initial);
      await expect(initial).toHaveAttribute("aria-selected", "true");
      await expectMemberVisible(initial);
    } else {
      // The existing narrow-screen keyboard flow opens an overlay. Select its
      // starting member without opening details, then verify that the overlay
      // receives subsequent members while leaving the background in place.
      await page.keyboard.down("Control");
      try {
        await clickVisible(initial);
      } finally {
        await page.keyboard.up("Control");
      }
      await expect(initial).toHaveAttribute("aria-selected", "true");
    }
    const columns = await trayColumns(tray);
    const backgroundBefore = await tray.evaluate((element) => ({
      innerTop: element.querySelector<HTMLElement>(
        "[data-sequence-virtual-scroll]"
      )?.scrollTop,
      outerTop: element.closest<HTMLElement>("[data-masonry-scroll]")
        ?.scrollTop,
    }));
    const beforeVirtualRow = await tray
      .locator("[data-sequence-virtual-row]")
      .last()
      .getAttribute("data-sequence-virtual-row");
    let stationarySteps = 0;
    for (const key of [
      "ArrowRight",
      ...new Array<string>(7).fill("ArrowDown"),
      "ArrowLeft",
      "ArrowUp",
    ]) {
      if (key === "ArrowRight") {
        current += 1;
      } else if (key === "ArrowDown") {
        current += columns;
      } else if (key === "ArrowLeft") {
        current -= 1;
      } else {
        current -= columns;
      }
      const nextMember = tray.locator(
        `[data-photo-id="${targetSequence * 1000 + current}"][role="option"]`
      );
      const before =
        size.width === 1280 && (await nextMember.count()) > 0
          ? await focusGeometry(nextMember)
          : null;
      await page.keyboard.press(key);
      if (size.width === 1280) {
        const selected = await expectKeyboardMember(tray, current);
        if (before?.fullyVisible) {
          const after = await focusGeometry(selected);
          expect(
            Math.abs(after.outerTop - before.outerTop)
          ).toBeLessThanOrEqual(1);
          expect(
            Math.abs((after.innerTop ?? 0) - (before.innerTop ?? 0))
          ).toBeLessThanOrEqual(1);
          stationarySteps += 1;
        }
      } else {
        await expect(
          page.locator('[role="dialog"]').filter({
            has: page.locator('[data-surface="inspector"]'),
          })
        ).toBeVisible();
        await expect(page.locator(".photo-detail-preview img")).toHaveAttribute(
          "alt",
          `SequenceFocus-${targetSequence}-${String(current).padStart(3, "0")}.png`
        );
        await expect
          .poll(() =>
            tray.evaluate((element) => ({
              innerTop: element.querySelector<HTMLElement>(
                "[data-sequence-virtual-scroll]"
              )?.scrollTop,
              outerTop: element.closest<HTMLElement>("[data-masonry-scroll]")
                ?.scrollTop,
            }))
          )
          .toEqual(backgroundBefore);
      }
    }
    if (size.width === 1280) {
      expect(stationarySteps).toBeGreaterThan(0);
      expect(Math.floor((current - 1) / columns)).toBeGreaterThan(
        Number(beforeVirtualRow)
      );
    }

    // Repeated arrows must use the new selection rather than the element that
    // originally retained DOM focus before its virtual row was recycled.
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    current += 2;
    if (size.width === 1280) {
      await expectKeyboardMember(tray, current);
    } else {
      await expect(page.locator(".photo-detail-preview img")).toHaveAttribute(
        "alt",
        `SequenceFocus-${targetSequence}-${String(current).padStart(3, "0")}.png`
      );
    }
    await assertBounds();
    if (size.width < 1280) {
      await expect
        .poll(() =>
          tray.evaluate((element) => ({
            innerTop: element.querySelector<HTMLElement>(
              "[data-sequence-virtual-scroll]"
            )?.scrollTop,
            outerTop: element.closest<HTMLElement>("[data-masonry-scroll]")
              ?.scrollTop,
          }))
        )
        .toEqual(backgroundBefore);
      await page.keyboard.press("Escape");
    }
  });
}

for (const size of sizes) {
  for (const boundary of [
    {
      frame: 1,
      outward: "ArrowLeft",
      vertical: "ArrowUp",
      inward: "ArrowRight",
      next: 2,
    },
    {
      frame: 96,
      outward: "ArrowRight",
      vertical: "ArrowDown",
      inward: "ArrowLeft",
      next: 95,
    },
  ]) {
    test(`${size.width}x${size.height} stops at expanded sequence frame ${boundary.frame} without selecting a neighboring sequence`, async () => {
      await openGallery("/", size);
      const card = await findSequence();
      await card
        .getByRole("button", { name: "Expand sequence photos", exact: true })
        .click();
      const tray = page.locator(`[data-sequence-tray-id="${targetSequence}"]`);
      const member = await findMember(boundary.frame, boundary.frame === 96);
      if (size.width === 1280) {
        await clickVisible(member);
        await expectMemberVisible(member);
      } else {
        await page.keyboard.down("Control");
        try {
          await clickVisible(member);
        } finally {
          await page.keyboard.up("Control");
        }
      }
      await expect(member).toHaveAttribute("aria-selected", "true");
      const filename = `SequenceFocus-${targetSequence}-${String(boundary.frame).padStart(3, "0")}.png`;
      await expect(page.locator(".photo-detail-preview img")).toHaveAttribute(
        "alt",
        filename
      );
      const before = await tray.evaluate((element) => ({
        inner: element.querySelector<HTMLElement>(
          "[data-sequence-virtual-scroll]"
        )?.scrollTop,
        outer: element.closest<HTMLElement>("[data-masonry-scroll]")?.scrollTop,
      }));
      for (const key of [
        boundary.outward,
        boundary.outward,
        boundary.vertical,
      ]) {
        await page.keyboard.press(key);
        await expect(member).toHaveAttribute("aria-selected", "true");
        await expect(page.locator(".photo-detail-preview img")).toHaveAttribute(
          "alt",
          filename
        );
      }
      expect(
        await tray.evaluate((element) => ({
          inner: element.querySelector<HTMLElement>(
            "[data-sequence-virtual-scroll]"
          )?.scrollTop,
          outer: element.closest<HTMLElement>("[data-masonry-scroll]")
            ?.scrollTop,
        }))
      ).toEqual(before);
      await page.keyboard.press(boundary.inward);
      if (size.width === 1280) {
        await expectKeyboardMember(tray, boundary.next);
      } else {
        await expect(page.locator(".photo-detail-preview img")).toHaveAttribute(
          "alt",
          `SequenceFocus-${targetSequence}-${String(boundary.next).padStart(3, "0")}.png`
        );
      }
      await expect(tray).toHaveCount(1);
      await assertBounds();
    });
  }
}

test("2000x1000 expanded member vertical arrows use the capped six-column tray", async () => {
  await openGallery("/", { width: 2000, height: 1000 });
  const card = await findSequence();
  await card
    .getByRole("button", { name: "Expand sequence photos", exact: true })
    .click();
  const tray = page.locator(`[data-sequence-tray-id="${targetSequence}"]`);
  const member = await findMember(14);
  await page.keyboard.down("Control");
  try {
    await clickVisible(member);
  } finally {
    await page.keyboard.up("Control");
  }
  await expect(member).toHaveAttribute("aria-selected", "true");
  expect(
    await page
      .locator("[data-masonry-scroll]")
      .evaluate((element) => Math.floor(element.clientWidth / 180))
  ).toBeGreaterThan(6);
  expect(await trayColumns(tray)).toBe(6);
  await page.keyboard.press("ArrowDown");
  await expectKeyboardMember(tray, 20);
  await page.keyboard.press("ArrowUp");
  await expectKeyboardMember(tray, 14);
  await assertBounds();
});

for (const route of ["/", "/albums/9002"]) {
  test(`1280x800 ${route} stays at the top when closing a sequence detail after back to top`, async () => {
    await openGallery(route);
    const card = await findSequence();
    await clickVisible(card);
    await expectCentered(card);
    const gallery = page.locator("[data-masonry-scroll]");
    await backToTop();
    await page
      .getByRole("button", { name: "Close sequence details", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Close sequence details", exact: true })
    ).toHaveCount(0);
    await page.waitForTimeout(700);
    await expect
      .poll(() => gallery.evaluate((element) => element.scrollTop))
      .toBe(0);
    await assertBounds();
  });

  test(`1280x800 ${route} keeps back to top across member detail, return to sequence and close`, async () => {
    await openGallery(route);
    const card = await findSequence();
    await clickVisible(card);
    await expectCentered(card);
    await page.getByRole("button", { name: frame80ButtonName }).click();
    const back = page.getByRole("button", {
      name: "Back to sequence details",
      exact: true,
    });
    await expect(back).toBeVisible();
    const gallery = page.locator("[data-masonry-scroll]");
    await backToTop();
    await back.click();
    const close = page.getByRole("button", {
      name: "Close sequence details",
      exact: true,
    });
    await expect(close).toBeVisible();
    await expect
      .poll(() => gallery.evaluate((element) => element.scrollTop))
      .toBe(0);
    await close.click();
    await expect(close).toHaveCount(0);
    await page.waitForTimeout(700);
    await expect
      .poll(() => gallery.evaluate((element) => element.scrollTop))
      .toBe(0);
    await assertBounds();
  });

  test(`1280x800 ${route} cancels a delayed sequence detail focus when back to top is clicked while loading`, async () => {
    await openGallery(route);
    const card = await findSequence();
    // Delay one real oRPC request at the browser MessagePort boundary. Its
    // eventual response still comes from the isolated database and main process.
    await page.evaluate(() => {
      const original = MessagePort.prototype.postMessage;
      let pending: (() => void) | undefined;
      const gate = {
        held: false,
        release: () => {
          const send = pending;
          pending = undefined;
          send?.();
        },
        restore: () => {
          MessagePort.prototype.postMessage = original;
          gate.release();
          window.sequenceGetGate = undefined;
        },
      };
      window.sequenceGetGate = gate;
      MessagePort.prototype.postMessage = function postMessage(
        message: unknown,
        options?: Transferable[] | StructuredSerializeOptions
      ) {
        const send = () => {
          Reflect.apply(
            original,
            this,
            options ? [message, options] : [message]
          );
        };
        const request = (
          typeof message === "string" ? JSON.parse(message) : message
        ) as { p?: { u?: string } } | null;
        if (!gate.held && request?.p?.u?.includes("/photos/getSequence")) {
          gate.held = true;
          pending = send;
          return;
        }
        send();
      };
    });
    try {
      await clickVisible(card);
      await expect
        .poll(() => page.evaluate(() => window.sequenceGetGate?.held))
        .toBe(true);
      const close = page.getByRole("button", {
        name: "Close sequence details",
        exact: true,
      });
      await expect(close).toHaveCount(0);
      const gallery = page.locator("[data-masonry-scroll]");
      await backToTop();
      await page.evaluate(() => window.sequenceGetGate?.release());
      await expect(close).toBeVisible();
      await expect
        .poll(() => gallery.evaluate((element) => element.scrollTop))
        .toBe(0);
      await close.click();
      await expect(close).toHaveCount(0);
      await page.waitForTimeout(700);
      await expect
        .poll(() => gallery.evaluate((element) => element.scrollTop))
        .toBe(0);
      await assertBounds();
    } finally {
      await page.evaluate(() => window.sequenceGetGate?.restore());
    }
  });
}

test("1280x800 sequence double-click opens playback without a delayed detail request", async () => {
  await openGallery("/");
  const card = await findSequence();
  await clickVisible(card, 2);
  const lightbox = page.locator(".lightbox-interactive");
  await expect(lightbox).toBeVisible();
  await page.waitForTimeout(400);
  await expect(
    page.getByRole("button", { name: "Close sequence details", exact: true })
  ).toHaveCount(0);
  await lightbox.getByRole("button", { name: "Close", exact: true }).click();
  await expect(card).toBeFocused();
  await expect(page.locator("[data-sequence-tray-id]")).toHaveCount(0);
});

test("1280x800 active scrolling releases expanded member positioning and does not replay it after remount", async () => {
  await openGallery("/");
  const card = await findSequence();
  await card
    .getByRole("button", { name: "Expand sequence photos", exact: true })
    .click();
  const tray = page.locator(`[data-sequence-tray-id="${targetSequence}"]`);
  const member = await findMember(20);
  await clickVisible(member);
  await expect(member).toHaveAttribute("aria-selected", "true");
  await expectMemberVisible(member);
  const inner = page.locator("[data-sequence-virtual-scroll]");
  const before = await inner.evaluate((element) => element.scrollTop);
  const bounds = await inner.boundingBox();
  if (!bounds) {
    throw new Error("Missing sequence scroll bounds");
  }
  await page.mouse.move(
    bounds.x + bounds.width / 2,
    bounds.y + bounds.height / 2
  );
  await page.mouse.wheel(0, 380);
  await expect
    .poll(() => inner.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before + 100);
  await page.waitForTimeout(300);
  const after = await inner.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(400);
  expect(await inner.evaluate((element) => element.scrollTop)).toBeCloseTo(
    after,
    0
  );

  const gallery = page.locator("[data-masonry-scroll]");
  const centeredOuterTop = await gallery.evaluate(
    (element) => element.scrollTop
  );
  await gallery.evaluate((element) => {
    element.dispatchEvent(
      new WheelEvent("wheel", { bubbles: true, deltaY: -100 })
    );
    element.scrollTop = 0;
  });
  await expect
    .poll(() => gallery.evaluate((element) => element.scrollTop))
    .toBe(0);
  await gallery.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => tray.count()).toBe(0);
  await gallery.evaluate((element, previous) => {
    element.scrollTop = previous + 120;
  }, centeredOuterTop);
  await expect(tray).toBeVisible();
  const restoredTop = await gallery.evaluate((element) => element.scrollTop);
  await page.waitForTimeout(500);
  expect(await gallery.evaluate((element) => element.scrollTop)).toBeCloseTo(
    restoredTop,
    0
  );
});

for (const placement of ["above", "below"] as const) {
  test(`1280x800 centers a ${placement} partially visible sequence card`, async () => {
    await openGallery("/");
    const card = await findSequence();
    await card.evaluate((element, position) => {
      const scroll = element.closest<HTMLElement>("[data-masonry-scroll]");
      if (!scroll) {
        throw new Error("Missing masonry scroll surface");
      }
      const bounds = scroll.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const inset =
        document
          .querySelector(".home-gallery-toolbar-layer, .page-toolbar.absolute")
          ?.getBoundingClientRect().height ?? 0;
      const paddingBottom =
        Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0;
      const edge =
        position === "above"
          ? bounds.top + inset
          : bounds.top + scroll.clientHeight - paddingBottom;
      scroll.scrollTop += rect.top - (edge - rect.height / 2);
    }, placement);
    await clickVisible(card);
    await expect(
      page.getByRole("button", { name: "Close sequence details", exact: true })
    ).toBeVisible();
    await expectCentered(card);
    await assertBounds();
  });
}

test("1280x800 modifier sequence selection does not open details", async () => {
  await openGallery("/");
  const card = await findSequence();
  await page.keyboard.down("Control");
  try {
    await clickVisible(card);
  } finally {
    await page.keyboard.up("Control");
  }
  await expect(card).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(400);
  await expect(
    page.getByRole("button", { name: "Close sequence details", exact: true })
  ).toHaveCount(0);
  await expect(page.locator("[data-sequence-tray-id]")).toHaveCount(0);
});
