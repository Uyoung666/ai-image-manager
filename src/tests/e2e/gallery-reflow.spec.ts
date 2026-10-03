import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electronPath = createRequire(import.meta.url)("electron") as string;
const sizes = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
interface ReflowFrame {
  anchorOffset: number | null;
  loaded: number;
  scrollTop: number;
  width: number;
}
declare global {
  interface Window {
    masonryReflowProbe: {
      stop: () => {
        frames: ReflowFrame[];
        retained: number;
        replaced: number;
        removed: number;
        initialOffset: number;
        initialScrollTop: number;
      };
    };
  }
}
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

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
    localStorage.setItem("ui.reduceMotion", "false");
    localStorage.setItem("sidebar_collapsed", "true");
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
}

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);
test.beforeAll(async () => {
  root = createTestRuntime("gallery-reflow");
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
  const escapeSql = (value: string) => value.replaceAll("'", "''");
  const images = await Promise.all(
    [66, 150, 100, 80, 125].map((height) =>
      sharp({
        create: {
          width: 100,
          height,
          channels: 3,
          background: { r: 75, g: 135, b: 185 },
        },
      })
        .png()
        .toBuffer()
    )
  );
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${escapeSql(fixture)}','ReflowFixture',2000,1)`,
  ];
  for (let id = 1; id <= 2000; id++) {
    const filename = `ReflowFixture-${id}.png`;
    const photoPath = path.join(fixture, filename);
    fs.writeFileSync(photoPath, images[(id - 1) % 5]);
    const height = [660, 1500, 1000, 800, 1250][(id - 1) % 5];
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${escapeSql(photoPath)}','${filename}',1,1024,${1_780_000_000_000 + id},1000,${height},'png','${escapeSql(photoPath)}',1,1,1,1)`
    );
  }
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

async function startProbe(prepareClick = false) {
  if (prepareClick) {
    const targetId = await page.evaluate(() => {
      const scroll = document.querySelector<HTMLElement>(
        "[data-masonry-scroll]"
      );
      if (!scroll) {
        throw new Error("Missing masonry scroll surface");
      }
      const bounds = scroll.getBoundingClientRect();
      const inset =
        document
          .querySelector(".home-gallery-toolbar-layer")
          ?.getBoundingClientRect().height ?? 0;
      const top = bounds.top + inset + 3;
      const bottom = bounds.bottom - 3;
      const candidates = Array.from(
        scroll.querySelectorAll<HTMLElement>('[data-photo-id][role="option"]')
      ).filter((card) => card.getBoundingClientRect().height <= bottom - top);
      const distance = (card: HTMLElement) => {
        const rect = card.getBoundingClientRect();
        return Math.max(top - rect.top, rect.bottom - bottom, 0);
      };
      const target = candidates.sort((a, b) => distance(a) - distance(b))[0];
      if (!target) {
        throw new Error("No fixture card fits the available viewport");
      }
      const rect = target.getBoundingClientRect();
      if (rect.top < top) {
        scroll.scrollTop += rect.top - top;
      } else if (rect.bottom > bottom) {
        scroll.scrollTop += rect.bottom - bottom;
      }
      return target.dataset.photoId;
    });
    // Selected-photo scrolling is intentional. Prepare a fully visible target
    // before measuring only the detail panel's layout transition.
    await expect
      .poll(async () =>
        page
          .locator(`[data-photo-id="${targetId}"][role="option"]`)
          .evaluate((card) => {
            const bounds = card
              .closest("[data-masonry-scroll]")
              ?.getBoundingClientRect();
            const rect = card.getBoundingClientRect();
            const inset =
              document
                .querySelector(".home-gallery-toolbar-layer")
                ?.getBoundingClientRect().height ?? 0;
            return (
              bounds &&
              rect.top >= bounds.top + inset &&
              rect.bottom <= bounds.bottom
            );
          })
      )
      .toBe(true);
  }
  return await page.evaluate(() => {
    const scroll = document.querySelector<HTMLElement>("[data-masonry-scroll]");
    if (!scroll) {
      throw new Error("Missing masonry scroll surface");
    }
    const bounds = scroll.getBoundingClientRect();
    const inset =
      document
        .querySelector(".home-gallery-toolbar-layer")
        ?.getBoundingClientRect().height ?? 0;
    const cards = Array.from(
      scroll.querySelectorAll<HTMLElement>('[data-photo-id][role="option"]')
    );
    const visible = cards.filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.bottom > bounds.top + inset && rect.top < bounds.bottom;
    });
    const anchor = visible[0];
    // A portrait card can be taller than the available narrow-window viewport.
    const clickTarget =
      visible.find((card) => {
        const rect = card.getBoundingClientRect();
        return rect.top >= bounds.top + inset && rect.bottom <= bounds.bottom;
      }) ?? anchor;
    if (!(anchor && clickTarget)) {
      throw new Error("No visible fixture cards");
    }
    const getAnchorOffset = (viewportTop: number) => {
      // The intentional two-pixel hover lift is separate from masonry geometry.
      const translateY =
        Number.parseFloat(
          getComputedStyle(anchor).translate.split(" ")[1] ?? "0"
        ) || 0;
      return anchor.getBoundingClientRect().top - viewportTop - translateY;
    };
    const initialOffset = getAnchorOffset(bounds.top);
    const initialScrollTop = scroll.scrollTop;
    const images = new Map(
      visible.map((card) => [card.dataset.photoId, card.querySelector("img")])
    );
    const removed = new Set<Element>();
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element) {
            for (const image of images.values()) {
              if (image && (node === image || node.contains(image))) {
                removed.add(image);
              }
            }
          }
        }
      }
    });
    observer.observe(scroll, { childList: true, subtree: true });
    const frames: ReflowFrame[] = [];
    let frame = 0;
    const sample = () => {
      const rect = scroll.getBoundingClientRect();
      let loaded = 0;
      for (const image of scroll.querySelectorAll<HTMLImageElement>("img")) {
        const imageBounds = image.getBoundingClientRect();
        if (
          imageBounds.bottom > rect.top + inset &&
          imageBounds.top < rect.bottom &&
          image.dataset.loadState === "loaded" &&
          image.naturalWidth > 0
        ) {
          loaded++;
        }
      }
      frames.push({
        anchorOffset: anchor.isConnected ? getAnchorOffset(rect.top) : null,
        loaded,
        scrollTop: scroll.scrollTop,
        width: rect.width,
      });
      frame = requestAnimationFrame(sample);
    };
    sample();
    window.masonryReflowProbe = {
      stop: () => {
        cancelAnimationFrame(frame);
        observer.disconnect();
        let retained = 0;
        let replaced = 0;
        let removedCount = 0;
        for (const [id, image] of images) {
          const current = scroll.querySelector(`[data-photo-id="${id}"] img`);
          if (current) {
            retained++;
            if (current !== image) {
              replaced++;
            }
            if (image && removed.has(image)) {
              removedCount++;
            }
          }
        }
        return {
          frames,
          retained,
          replaced,
          removed: removedCount,
          initialOffset,
          initialScrollTop,
        };
      },
    };
    return clickTarget.dataset.photoId;
  });
}

async function openProbeTarget(id: string | undefined) {
  const point = await page
    .locator(`[data-photo-id="${id}"][role="option"]`)
    .evaluate((card) => {
      const scroll = card.closest("[data-masonry-scroll]");
      if (!scroll) {
        throw new Error("Missing masonry scroll surface");
      }
      const bounds = scroll.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      const inset =
        document
          .querySelector(".home-gallery-toolbar-layer")
          ?.getBoundingClientRect().height ?? 0;
      const top = Math.max(rect.top, bounds.top + inset);
      const bottom = Math.min(rect.bottom, bounds.bottom);
      if (bottom <= top) {
        throw new Error("Fixture card has no clickable visible area");
      }
      return {
        x:
          (Math.max(rect.left, bounds.left) +
            Math.min(rect.right, bounds.right)) /
          2,
        y: (top + bottom) / 2,
      };
    });
  // Click the visible area without Playwright scrolling a tall card into view.
  await page.mouse.click(point.x, point.y);
}

async function finishProbe(label: string, overlay: boolean) {
  await page.waitForTimeout(350);
  const result = await page.evaluate(() => window.masonryReflowProbe.stop());
  const framePath = test.info().outputPath(`${label}.json`);
  fs.writeFileSync(framePath, JSON.stringify(result, null, 2));
  await test.info().attach(label, {
    path: framePath,
    contentType: "application/json",
  });
  expect(result.retained).toBeGreaterThan(0);
  expect(result.replaced).toBe(0);
  expect(result.removed).toBe(0);
  expect(result.frames.length).toBeGreaterThan(2);
  for (const frame of result.frames) {
    expect(frame.loaded).toBeGreaterThan(0);
    expect(frame.anchorOffset).not.toBeNull();
    // At the top boundary, a wrapping toolbar can legitimately change padding.
    if (result.initialScrollTop > 0 || frame.scrollTop > 0) {
      expect(
        Math.abs((frame.anchorOffset ?? 0) - result.initialOffset)
      ).toBeLessThanOrEqual(2);
    }
    if (overlay) {
      expect(frame.scrollTop).toBe(result.initialScrollTop);
    }
  }
  const overflow = await page.evaluate(() =>
    [
      document.documentElement,
      document.body,
      ...document.querySelectorAll("main"),
    ].some((element) => element.scrollWidth > element.clientWidth + 2)
  );
  expect(overflow).toBe(false);
  await page.screenshot({ path: test.info().outputPath(`${label}.png`) });
}

for (const size of sizes) {
  test(`${size.width}x${size.height} preserves deep masonry images during detail reflow`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    const gallery = page.locator("[data-masonry-scroll]");
    await expect(gallery).toBeVisible();
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    const overlay = size.width <= 1120;
    for (const depth of [0, 10_000, 30_000]) {
      await expect
        .poll(
          async () =>
            await gallery.evaluate((element, target) => {
              if (element.scrollHeight < target + element.clientHeight + 2000) {
                element.scrollTop = element.scrollHeight;
                element.dispatchEvent(new Event("scroll"));
              }
              return element.scrollHeight;
            }, depth),
          { timeout: 60_000 }
        )
        .toBeGreaterThan(depth + 3000);
      await gallery.evaluate((element, target) => {
        element.scrollTop = target;
      }, depth);
      await page.waitForTimeout(700);
      for (let repeat = 0; repeat < 2; repeat++) {
        const id = await startProbe(true);
        await openProbeTarget(id);
        await expect(
          page.locator(".home-detail-panel-container")
        ).toBeVisible();
        await finishProbe(`depth-${depth}-open-${repeat}`, overlay);
        await startProbe();
        await page.keyboard.press("Escape");
        await expect(page.locator(".home-detail-panel-container")).toHaveCount(
          0
        );
        await finishProbe(`depth-${depth}-close-${repeat}`, overlay);
      }
    }
    if (!overlay) {
      const id = await startProbe(true);
      await openProbeTarget(id);
      await expect(page.locator(".home-detail-panel-container")).toBeVisible();
      await finishProbe("drag-open", false);
      await startProbe();
      const handle = await page
        .locator(".photo-detail-panel-resize-handle")
        .boundingBox();
      if (!handle) {
        throw new Error("Missing detail resize handle");
      }
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 100);
      await page.mouse.down();
      await page.mouse.move(handle.x - 80, handle.y + 100, { steps: 6 });
      await page.mouse.up();
      await finishProbe("drag-width", false);
      await page.keyboard.press("Escape");
    }
  });
}
