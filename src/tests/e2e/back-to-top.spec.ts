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
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

async function launch() {
  app = await launchTestApp(root, {
    args: ["-r", path.join(root, "isolation.cjs"), "--e2e", path.resolve(".")],
    env,
    recordVideo: { dir: path.join(root, "video"), size: sizes[2] },
  });
  app
    .process()
    .stderr?.on("data", (data) =>
      fs.appendFileSync(path.join(root, "electron.log"), data)
    );
  page = await app.firstWindow();
  await page.waitForLoadState("load");
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
  root = createTestRuntime("back-to-top");
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
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${escapeSql(fixture)}','BackTopFixture',2000,1)`,
    "INSERT INTO albums(id,name,created_at) VALUES(1,'BackTopAlbum',1)",
  ];
  for (let id = 1; id <= 2000; id++) {
    const filename = `BackTopFixture-${id}.png`;
    const photoPath = path.join(fixture, filename);
    const group = Math.floor((id - 1) / 2);
    fs.writeFileSync(
      photoPath,
      Buffer.concat([images[group % 5], Buffer.from(String(group))])
    );
    const height = [660, 1500, 1000, 800, 1250][group % 5];
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${escapeSql(photoPath)}','${filename}',1,1024,${1_780_000_000_000 + id},1000,${height},'png','${escapeSql(photoPath)}',1,1,1,1)`
    );
    statements.push(
      `INSERT INTO album_photos(album_id,photo_id,sort_order) VALUES(1,${id},${id})`
    );
  }
  statements.push(`UPDATE photos SET deleted_at=${Date.now()} WHERE id > 1760`);
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
  const video = page?.video();
  await app?.close();
  if (video) {
    await test.info().attach("back-to-top-video", {
      path: await video.path(),
      contentType: "video/webm",
    });
  }
});

test.beforeEach(async () => {
  // Search and deep-scroll cases must not inherit another case's restoration
  // anchors or query cache. The isolated fixture database stays unchanged.
  await page.evaluate(() => {
    sessionStorage.clear();
    localStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
});

test("records near and distant back to top", async () => {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1280, 800)
  );
  await page.evaluate(() => window.__e2eNavigate?.("/"));
  await page.getByRole("button", { name: "Photos", exact: true }).click();
  const gallery = page.locator("[data-masonry-scroll]");
  await expect
    .poll(
      () =>
        gallery.evaluate((el) => {
          if (el.scrollHeight < el.clientHeight * 56) {
            el.scrollTop = el.scrollHeight;
          }
          return el.scrollHeight / el.clientHeight;
        }),
      { timeout: 60_000 }
    )
    .toBeGreaterThan(55);
  const results: unknown[] = [];
  for (const screens of [3, 3.95, 4.05, 50]) {
    await gallery.evaluate((el, distance) => {
      el.scrollTop = distance * el.clientHeight;
    }, screens);
    await page.waitForTimeout(350);
    const frames = await gallery.evaluate(async (el) => {
      const button =
        document.querySelector<HTMLButtonElement>(".scroll-to-top-btn");
      if (!button) {
        throw new Error("Missing back to top button");
      }
      const frames: {
        time: number;
        top: number;
        opacity: number;
        cards: number;
        visibleCards: number;
      }[] = [];
      const start = performance.now();
      button.click();
      await new Promise<void>((resolve) => {
        function sample() {
          const content = el.querySelector("[data-back-to-top-content]") ?? el;
          const bounds = el.getBoundingClientRect();
          const visibleCards = Array.from(
            el.querySelectorAll("[data-photo-id]")
          ).filter((card) => {
            const rect = card.getBoundingClientRect();
            return rect.bottom > bounds.top + 110 && rect.top < bounds.bottom;
          }).length;
          frames.push({
            time: performance.now() - start,
            top: el.scrollTop,
            opacity: Number(getComputedStyle(content).opacity),
            cards: el.querySelectorAll("[data-photo-id]").length,
            visibleCards,
          });
          if (performance.now() - start < 1100) {
            requestAnimationFrame(sample);
          } else {
            resolve();
          }
        }
        requestAnimationFrame(sample);
      });
      return frames;
    });
    expect(await gallery.evaluate((el) => el.scrollTop)).toBe(0);
    fs.writeFileSync(
      test.info().outputPath(`frames-${screens}.json`),
      JSON.stringify(frames)
    );
    expect(
      frames.every(
        (frame) =>
          frame.cards > 0 && frame.opacity >= 0.34 && frame.visibleCards > 0
      )
    ).toBe(true);
    if (screens > 4) {
      expect(Math.max(...frames.map((frame) => frame.cards))).toBeLessThan(250);
      expect(frames.some((frame) => frame.opacity < 0.9 && frame.top > 0)).toBe(
        true
      );
      expect(
        frames.some((frame) => frame.opacity < 0.9 && frame.top === 0)
      ).toBe(true);
      expect(
        new Set(frames.map((frame) => frame.top)).size
      ).toBeLessThanOrEqual(2);
    } else {
      expect(new Set(frames.map((frame) => frame.top)).size).toBeGreaterThan(3);
    }
    results.push({ screens, frames });
  }
  fs.writeFileSync(
    test.info().outputPath("frames.json"),
    JSON.stringify(results, null, 2)
  );
  await test.info().attach("back-to-top-frames", {
    body: JSON.stringify(results, null, 2),
    contentType: "application/json",
  });
});

for (const size of sizes) {
  test(`${size.width}x${size.height} keeps the button, tooltip and focus in bounds on all lists`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, dimensions) =>
        BrowserWindow.getAllWindows()[0].setSize(
          dimensions.width,
          dimensions.height
        ),
      size
    );
    for (const route of ["/", "/albums/1", "/trash", "/duplicates"]) {
      await page.evaluate((target) => window.__e2eNavigate?.(target), route);
      if (route === "/") {
        await page.getByRole("button", { name: "Photos", exact: true }).click();
      }
      const selectors: Record<string, string> = {
        "/trash": "div[aria-busy].overflow-y-auto",
        "/duplicates": "main.overflow-y-auto",
      };
      const scroll = page.locator(selectors[route] ?? "[data-masonry-scroll]");
      await expect(scroll).toBeVisible();
      await expect
        .poll(
          () => scroll.evaluate((el) => el.scrollHeight / el.clientHeight),
          { timeout: 60_000 }
        )
        .toBeGreaterThan(5);
      const button = page.getByRole("button", {
        name: "Back to top",
        exact: true,
      });
      await scroll.evaluate((el) => {
        el.scrollTop = 1;
      });
      await expect(button).toBeHidden();
      await scroll.evaluate((el) => {
        el.scrollTop = el.clientHeight * 2.1;
      });
      await expect(button).toBeVisible();
      await scroll.evaluate((el) => {
        el.scrollTop = el.clientHeight * 4.2;
      });
      if (route === "/" || route === "/albums/1") {
        await expect
          .poll(() =>
            scroll.evaluate((el) => {
              const bounds = el.getBoundingClientRect();
              const cards = Array.from(
                el.querySelectorAll<HTMLElement>(
                  '[data-photo-id][role="option"]'
                )
              ).filter((item) => {
                const rect = item.getBoundingClientRect();
                return (
                  rect.bottom > bounds.top + 110 &&
                  rect.top < bounds.bottom - 60
                );
              });
              if (cards.length < 2) {
                return false;
              }
              for (const card of cards.slice(0, 2)) {
                card.dispatchEvent(
                  new MouseEvent("click", { bubbles: true, ctrlKey: true })
                );
              }
              return true;
            })
          )
          .toBe(true);
        await expect(
          page.locator('.selection-action-layer[data-selection-visible="true"]')
        ).toBeVisible();
        await expect(
          page.getByRole("dialog", { name: "Photo Detail", exact: true })
        ).toBeHidden();
        await expect
          .poll(async () => {
            const arrow = await button.boundingBox();
            const bar = await page
              .locator('.selection-action-layer[data-selection-visible="true"]')
              .boundingBox();
            return Boolean(arrow && bar && arrow.y + arrow.height <= bar.y);
          })
          .toBe(true);
      }
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => (await button.boundingBox())?.width)
        .toBe(36);
      await button.hover();
      await expect(
        page.getByRole("tooltip", { name: "Back to top", exact: true })
      ).toBeVisible();
      await expect
        .poll(async () => (await button.boundingBox())?.width)
        .toBe(110);
      const bounds = await page.evaluate(() => {
        const elements = [
          document.documentElement,
          ...document.querySelectorAll(
            "main, .scroll-to-top-btn, [role=tooltip]"
          ),
        ];
        return (
          elements.every((el) => {
            const rect = el.getBoundingClientRect();
            return (
              rect.left >= -1 &&
              rect.right <= innerWidth + 1 &&
              rect.bottom <= innerHeight + 1
            );
          }) && document.documentElement.scrollWidth <= innerWidth
        );
      });
      expect(bounds).toBe(true);
      await page.mouse.move(0, 0);
      await expect
        .poll(async () => (await button.boundingBox())?.width)
        .toBe(36);
      await button.focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => scroll.evaluate((el) => el.scrollTop)).toBe(0);
      await expect(scroll).toBeFocused();
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() =>
          document.activeElement?.getAttribute("aria-hidden")
        )
      ).not.toBe("true");
      await test.info().attach(`${route.replaceAll("/", "-")}-${size.width}`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
    }
  });
}

test("input interrupts a distant jump and system reduced motion bypasses it", async () => {
  await page.getByRole("button", { name: "Photos", exact: true }).click();
  const scroll = page.locator("[data-masonry-scroll]");
  await scroll.evaluate((el) => {
    el.scrollTop = el.clientHeight * 4.1;
  });
  await expect(
    page.getByRole("button", { name: "Back to top", exact: true })
  ).toBeVisible();
  const top = await scroll.evaluate((el) => {
    document.querySelector<HTMLButtonElement>(".scroll-to-top-btn")?.click();
    el.dispatchEvent(new WheelEvent("wheel", { deltaY: 50, bubbles: true }));
    return el.scrollTop;
  });
  await page.waitForTimeout(350);
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(top);
  expect(
    await scroll
      .locator("[data-back-to-top-content]")
      .evaluate((el) => el.getAnimations().length)
  ).toBe(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Back to top", exact: true }).click();
  expect(await scroll.evaluate((el) => el.scrollTop)).toBe(0);
  await page.emulateMedia({ reducedMotion: "no-preference" });
});

test("distant return reveals first-screen placeholders while thumbnails are still loading", async () => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/photo-thumbnail?**", async (route) => {
    await held;
    await route.continue().catch(() => undefined);
  });
  try {
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    const gallery = page.locator("[data-masonry-scroll]");
    await gallery.evaluate((el) => {
      el.scrollTop = el.clientHeight * 4.1;
    });
    await expect(
      page.getByRole("button", { name: "Back to top", exact: true })
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Back to top", exact: true })
      .click();
    await expect.poll(() => gallery.evaluate((el) => el.scrollTop)).toBe(0);
    await expect
      .poll(() =>
        gallery
          .locator("[data-back-to-top-content]")
          .evaluate((el) => el.getAnimations().length)
      )
      .toBe(0);
    const state = await gallery.evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      return Array.from(el.querySelectorAll("[data-photo-id]"))
        .filter((card) => {
          const rect = card.getBoundingClientRect();
          return rect.bottom > bounds.top + 110 && rect.top < bounds.bottom;
        })
        .map((card) => ({
          loaded: Array.from(card.querySelectorAll("img")).some(
            (image) => image.naturalWidth > 0
          ),
          height: card.getBoundingClientRect().height,
        }));
    });
    expect(state.length).toBeGreaterThan(0);
    expect(state.every((card) => card.height > 0 && !card.loaded)).toBe(true);
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
