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
        targetRetained: boolean;
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

async function startProbe(prepareClick = false, preferredTargetId?: string) {
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
    // Keep the general reflow fixture target fully visible before the click.
    // Dedicated focus cases below also exercise partially visible cards.
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
  // Start measuring reflow after the cold-cache click target has decoded.
  await expect
    .poll(() =>
      page.evaluate((requestedId) => {
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
        const visible = Array.from(
          scroll.querySelectorAll<HTMLElement>('[data-photo-id][role="option"]')
        ).filter((card) => {
          const rect = card.getBoundingClientRect();
          return rect.bottom > bounds.top + inset && rect.top < bounds.bottom;
        });
        const clickTarget = requestedId
          ? visible.find((card) => card.dataset.photoId === requestedId)
          : (visible.find((card) => {
              const rect = card.getBoundingClientRect();
              return (
                rect.top >= bounds.top + inset && rect.bottom <= bounds.bottom
              );
            }) ?? visible[0]);
        const image = clickTarget?.querySelector<HTMLImageElement>("img");
        return image?.dataset.loadState === "loaded" && image.naturalWidth > 0;
      }, preferredTargetId)
    )
    .toBe(true);
  return await page.evaluate((requestedId) => {
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
    const clickTarget = requestedId
      ? visible.find((card) => card.dataset.photoId === requestedId)
      : (visible.find((card) => {
          const rect = card.getBoundingClientRect();
          return rect.top >= bounds.top + inset && rect.bottom <= bounds.bottom;
        }) ?? anchor);
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
      // Queued cards have no image node until the shared scheduler decodes
      // them. Their first image is an arrival, not a replaced old image.
      visible.flatMap((card) => {
        const image = card.querySelector("img");
        return image ? [[card.dataset.photoId, image] as const] : [];
      })
    );
    const targetImage = clickTarget.querySelector("img");
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
          targetRetained:
            targetImage !== null &&
            clickTarget.querySelector("img") === targetImage &&
            clickTarget.isConnected &&
            !removed.has(targetImage),
          initialOffset,
          initialScrollTop,
        };
      },
    };
    return clickTarget.dataset.photoId;
  }, preferredTargetId);
}

async function openProbeTarget(id: string | undefined) {
  const point = { x: 0, y: 0 };
  await expect
    .poll(
      async () => {
        const result = await page
          .locator(`[data-photo-id="${id}"][role="option"]`)
          .evaluate((card) => {
            const scroll = card.closest<HTMLElement>("[data-masonry-scroll]");
            if (!scroll) {
              throw new Error("Missing masonry scroll surface");
            }
            const bounds = scroll.getBoundingClientRect();
            const rect = card.getBoundingClientRect();
            const inset =
              document
                .querySelector(".home-gallery-toolbar-layer")
                ?.getBoundingClientRect().height ?? 0;
            const paddingBottom =
              Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0;
            const statusBounds = document
              .querySelector(".home-gallery-status-bar")
              ?.getBoundingClientRect();
            const viewportBottom = Math.min(
              bounds.top + scroll.clientHeight - paddingBottom,
              statusBounds && statusBounds.height > 0
                ? statusBounds.top
                : bounds.bottom
            );
            const top = Math.max(rect.top, bounds.top + inset);
            const bottom = Math.min(rect.bottom, viewportBottom);
            const left = Math.max(rect.left, bounds.left);
            const right = Math.min(rect.right, bounds.right);
            if (bottom <= top || right <= left) {
              return {
                point: null,
                blockedBy: "Fixture card has no clickable visible area",
              };
            }
            const blockers = new Set<string>();
            for (const yRatio of [0.5, 0.25, 0.75]) {
              for (const xRatio of [0.5, 0.25, 0.75]) {
                const candidate = {
                  x: left + (right - left) * xRatio,
                  y: top + (bottom - top) * yRatio,
                };
                const hit = document.elementFromPoint(candidate.x, candidate.y);
                if (
                  card.contains(hit) &&
                  !hit?.closest('button, [role="button"], input, a')
                ) {
                  return { point: candidate, blockedBy: null };
                }
                blockers.add(
                  hit
                    ? `${hit.tagName}.${hit.getAttribute("class") ?? ""}`
                    : "null"
                );
              }
            }
            return {
              point: null,
              blockedBy: `Fixture card is covered by ${[...blockers].join("; ")}`,
            };
          });
        if (result.point) {
          Object.assign(point, result.point);
        }
        return result.blockedBy;
      },
      { timeout: 10_000, message: `Wait for unobscured fixture card ${id}` }
    )
    .toBeNull();
  // Click the visible area without Playwright scrolling a tall card into view.
  await page.mouse.click(point.x, point.y);
}

type ClickVisibility = "above" | "below" | "inside";

async function positionFocusTarget(
  visibility: ClickVisibility,
  requestedId?: string
) {
  const id = await page.evaluate(
    ({ placement, targetId }) => {
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
      const paddingBottom =
        Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0;
      const statusBounds = document
        .querySelector(".home-gallery-status-bar")
        ?.getBoundingClientRect();
      const top = bounds.top + inset;
      const bottom = Math.min(
        bounds.top + scroll.clientHeight - paddingBottom,
        statusBounds && statusBounds.height > 0
          ? statusBounds.top
          : bounds.bottom
      );
      const cards = Array.from(
        scroll.querySelectorAll<HTMLElement>('[data-photo-id][role="option"]')
      );
      const target = targetId
        ? cards.find((card) => card.dataset.photoId === targetId)
        : cards.find((card) => {
            const rect = card.getBoundingClientRect();
            return (
              rect.top >= top &&
              rect.bottom <= bottom &&
              rect.height < bottom - top - 48
            );
          });
      if (!target?.dataset.photoId) {
        throw new Error("No visible fixture card fits the focus test");
      }
      const rect = target.getBoundingClientRect();
      const translateY =
        Number.parseFloat(
          getComputedStyle(target).translate.split(" ")[1] ?? "0"
        ) || 0;
      let desiredTop = top + 24;
      if (placement === "above") {
        desiredTop = top - rect.height / 2;
      } else if (placement === "below") {
        desiredTop = bottom - rect.height / 2;
      }
      scroll.scrollTop += rect.top - translateY - desiredTop;
      return target.dataset.photoId;
    },
    { placement: visibility, targetId: requestedId }
  );
  await expect
    .poll(() =>
      page
        .locator(`[data-photo-id="${id}"][role="option"]`)
        .evaluate((card, placement) => {
          const scroll = card.closest<HTMLElement>("[data-masonry-scroll]");
          if (!scroll) {
            throw new Error("Missing masonry scroll surface");
          }
          const bounds = scroll.getBoundingClientRect();
          const rect = card.getBoundingClientRect();
          const inset =
            document
              .querySelector(".home-gallery-toolbar-layer")
              ?.getBoundingClientRect().height ?? 0;
          const paddingBottom =
            Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0;
          const statusBounds = document
            .querySelector(".home-gallery-status-bar")
            ?.getBoundingClientRect();
          const translateY =
            Number.parseFloat(
              getComputedStyle(card).translate.split(" ")[1] ?? "0"
            ) || 0;
          const top = rect.top - translateY;
          const bottom = rect.bottom - translateY;
          const viewportTop = bounds.top + inset;
          const viewportBottom = Math.min(
            bounds.top + scroll.clientHeight - paddingBottom,
            statusBounds && statusBounds.height > 0
              ? statusBounds.top
              : bounds.bottom
          );
          if (placement === "above") {
            return top < viewportTop - 2 && bottom > viewportTop + 2;
          }
          if (placement === "below") {
            return top < viewportBottom - 2 && bottom > viewportBottom + 2;
          }
          return top > viewportTop + 2 && bottom < viewportBottom - 2;
        }, visibility)
    )
    .toBe(true);
  return id;
}

async function expectCenteredTarget(id: string) {
  const card = page.locator(`[data-photo-id="${id}"][role="option"]`);
  await expect(card).toHaveAttribute("aria-selected", "true");
  await expect
    .poll(() =>
      card.evaluate((element) => {
        const scroll = element.closest<HTMLElement>("[data-masonry-scroll]");
        if (!scroll) {
          throw new Error("Missing masonry scroll surface");
        }
        const bounds = scroll.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        const inset =
          document
            .querySelector(".home-gallery-toolbar-layer")
            ?.getBoundingClientRect().height ?? 0;
        const paddingBottom =
          Number.parseFloat(getComputedStyle(scroll).paddingBottom) || 0;
        const translateY =
          Number.parseFloat(
            getComputedStyle(element).translate.split(" ")[1] ?? "0"
          ) || 0;
        const top = rect.top - translateY;
        const bottom = rect.bottom - translateY;
        const viewportTop = bounds.top + inset;
        const viewportBottom = bounds.top + scroll.clientHeight - paddingBottom;
        const centerError =
          (top + bottom) / 2 - (viewportTop + viewportBottom) / 2;
        const expectedScrollTop = Math.max(
          0,
          Math.min(
            scroll.scrollTop + centerError,
            scroll.scrollHeight - scroll.clientHeight
          )
        );
        const fits = rect.height <= viewportBottom - viewportTop;
        return (
          Math.abs(scroll.scrollTop - expectedScrollTop) <= 2 &&
          (!fits || (top >= viewportTop - 2 && bottom <= viewportBottom + 2))
        );
      })
    )
    .toBe(true);
}

async function finishProbe(
  label: string,
  overlay: boolean,
  centeredTargetId?: string
) {
  await page.waitForTimeout(350);
  if (centeredTargetId) {
    await expectCenteredTarget(centeredTargetId);
  }
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
  if (centeredTargetId) {
    expect(result.targetRetained).toBe(true);
  }
  expect(result.frames.length).toBeGreaterThan(2);
  for (const frame of result.frames) {
    expect(frame.loaded).toBeGreaterThan(0);
    if (!centeredTargetId) {
      expect(frame.anchorOffset).not.toBeNull();
      // At the top boundary, a wrapping toolbar can legitimately change padding.
      if (result.initialScrollTop > 0 || frame.scrollTop > 0) {
        expect(
          Math.abs((frame.anchorOffset ?? 0) - result.initialOffset)
        ).toBeLessThanOrEqual(2);
      }
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

for (const visibility of ["above", "below", "inside"] as const) {
  test(`1280x800 centers the clicked ${visibility} card after opening details`, async () => {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 800)
    );
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    const gallery = page.locator("[data-masonry-scroll]");
    await expect(gallery).toBeVisible();
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    await expect
      .poll(() => gallery.locator('[data-photo-id][role="option"]').count())
      .toBeGreaterThan(5);
    await gallery.evaluate((element) => {
      element.scrollTop = 1500;
    });
    await page.waitForTimeout(700);
    const id = await positionFocusTarget(visibility);
    await startProbe(false, id);
    await openProbeTarget(id);
    await expect(page.locator(".home-detail-panel-container")).toBeVisible();
    await finishProbe(`${visibility}-click-open`, false, id);

    if (visibility === "inside") {
      // The selected ID stays the same: a new click must still recenter it.
      await positionFocusTarget("above", id);
      await startProbe(false, id);
      await openProbeTarget(id);
      await finishProbe("same-card-click", false, id);
    }
  });
}

for (const closeMethod of ["button", "Escape"] as const) {
  test(`1280x800 stays at back to top when closing details with ${closeMethod}`, async () => {
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1280, 800)
    );
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    const gallery = page.locator("[data-masonry-scroll]");
    const details = page.locator(".home-detail-panel-container");
    await expect(gallery).toBeVisible();
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    await expect
      .poll(
        () =>
          gallery.evaluate((element) => {
            if (element.scrollHeight < 13_000) {
              element.scrollTop = element.scrollHeight;
              element.dispatchEvent(new Event("scroll"));
            }
            return element.scrollHeight;
          }),
        { timeout: 60_000 }
      )
      .toBeGreaterThan(13_000);

    const waitForLoadedViewport = async (targetId?: string) => {
      await expect
        .poll(() =>
          gallery.evaluate((element, requestedId) => {
            const bounds = element.getBoundingClientRect();
            const inset =
              document
                .querySelector(".home-gallery-toolbar-layer")
                ?.getBoundingClientRect().height ?? 0;
            return Array.from(
              element.querySelectorAll<HTMLImageElement>(
                requestedId ? `[data-photo-id="${requestedId}"] img` : "img"
              )
            ).some((image) => {
              const rect = image.getBoundingClientRect();
              return (
                rect.bottom > bounds.top + inset &&
                rect.top < bounds.bottom &&
                image.dataset.loadState === "loaded" &&
                image.naturalWidth > 0
              );
            });
          }, targetId)
        )
        .toBe(true);
    };
    const prepareProbeTarget = async () => {
      const id = await positionFocusTarget("inside");
      await waitForLoadedViewport(id);
      await startProbe(false, id);
      return id;
    };
    const openMiddleDetail = async (label: string) => {
      await gallery.evaluate((element) => {
        element.scrollTop = 10_000;
      });
      await page.waitForTimeout(700);
      const id = await prepareProbeTarget();
      await openProbeTarget(id);
      await expect(details).toBeVisible();
      await finishProbe(label, false, id);
      return id;
    };
    const returnToTop = async () => {
      await page
        .getByRole("button", { name: "Back to top", exact: true })
        .click();
      await expect
        .poll(() => gallery.evaluate((element) => element.scrollTop))
        .toBe(0);
      await expect(details).toBeVisible();
      await waitForLoadedViewport();
    };

    await openMiddleDetail(`${closeMethod}-back-top-open`);
    await returnToTop();
    await startProbe();
    if (closeMethod === "button") {
      await details.locator("button:has(svg.lucide-x)").click();
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(details).toHaveCount(0);
    // Record well beyond the close reflow so a delayed return cannot pass.
    await page.waitForTimeout(600);
    await finishProbe(`${closeMethod}-back-top-close`, true);
    await expect
      .poll(() => gallery.evaluate((element) => element.scrollTop))
      .toBe(0);

    if (closeMethod === "button") {
      const previousId = await openMiddleDetail("new-click-back-top-open");
      await returnToTop();
      const nextId = await prepareProbeTarget();
      expect(nextId).not.toBe(previousId);
      await openProbeTarget(nextId);
      await finishProbe("new-click-after-back-top", false, nextId);
      // A new ordinary click restores the usual return behavior. Move away
      // without closing details, then close and expect that new photo again.
      await gallery.evaluate((element) => {
        element.scrollTop = 10_000;
      });
      await expect
        .poll(() => gallery.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(9000);
      await details.locator("button:has(svg.lucide-x)").click();
      await expect(details).toHaveCount(0);
      const returnedCard = gallery.locator(
        `[data-photo-id="${nextId}"][role="option"]`
      );
      await expect(returnedCard).toHaveAttribute(
        "data-recently-viewed",
        "true"
      );
      await expect
        .poll(() =>
          returnedCard.evaluate((card) => {
            const scroll = card.closest<HTMLElement>("[data-masonry-scroll]");
            if (!scroll) {
              throw new Error("Missing masonry scroll surface");
            }
            const bounds = scroll.getBoundingClientRect();
            const rect = card.getBoundingClientRect();
            const inset =
              document
                .querySelector(".home-gallery-toolbar-layer")
                ?.getBoundingClientRect().height ?? 0;
            return rect.bottom > bounds.top + inset && rect.top < bounds.bottom;
          })
        )
        .toBe(true);
      expect(
        await page.evaluate(() =>
          [
            document.documentElement,
            document.body,
            ...document.querySelectorAll("main"),
          ].some((element) => element.scrollWidth > element.clientWidth + 2)
        )
      ).toBe(false);
    }
  });
}

for (const size of sizes) {
  test(`${size.width}x${size.height} preserves masonry when switching windows and restoring from desktop`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await page.keyboard.press("Escape");
    const input = page.locator("input.home-search-input");
    await input.fill("");
    await input.press("Enter");
    await page.getByRole("button", { name: "Photos", exact: true }).click();
    const gallery = page.locator("[data-masonry-scroll]");
    for (const scope of ["browse", "search"]) {
      if (scope === "search") {
        await input.fill("ReflowFixture-*.png");
        await input.press("Enter");
      }
      await expect(gallery).toBeVisible();
      await expect
        .poll(() => gallery.locator('[data-photo-id][role="option"]').count())
        .toBeGreaterThan(5);
      await gallery.evaluate((element) => {
        element.scrollTop = 1500;
      });
      await page.waitForTimeout(700);
      await startProbe();
      const otherPageReady = app.waitForEvent("window");
      const windows = await app.evaluate(async ({ BrowserWindow }) => {
        const main = BrowserWindow.getAllWindows()[0];
        const other = new BrowserWindow({
          parent: main,
          width: 240,
          height: 180,
        });
        await other.loadURL("about:blank");
        main.blur();
        other.focus();
        return { main: main.id, other: other.id };
      });
      const otherPage = await otherPageReady;
      await otherPage.waitForLoadState("domcontentloaded");
      // Playwright emulates document focus. Native BrowserWindow state is the
      // authority for this real window-switching and desktop-restore check.
      await app.evaluate(({ BrowserWindow }, ids) => {
        BrowserWindow.fromId(ids.main)?.blur();
        BrowserWindow.fromId(ids.other)?.focus();
      }, windows);
      try {
        await expect
          .poll(() =>
            app.evaluate(
              ({ BrowserWindow }, ids) => ({
                main: BrowserWindow.fromId(ids.main)?.isFocused(),
                other: BrowserWindow.fromId(ids.other)?.isFocused(),
              }),
              windows
            )
          )
          .toEqual({ main: false, other: true });
      } catch (error) {
        await test.info().attach("native-focus-state", {
          body: JSON.stringify({
            scope,
            documentFocused: await page.evaluate(() => document.hasFocus()),
            windows: await app.evaluate(
              ({ BrowserWindow }, ids) => ({
                focused: BrowserWindow.getFocusedWindow()?.id,
                main: BrowserWindow.fromId(ids.main)?.isFocused(),
                other: BrowserWindow.fromId(ids.other)?.isFocused(),
                otherVisible: BrowserWindow.fromId(ids.other)?.isVisible(),
              }),
              windows
            ),
          }),
          contentType: "application/json",
        });
        throw error;
      } finally {
        await app.evaluate(({ BrowserWindow }, ids) => {
          BrowserWindow.fromId(ids.other)?.close();
          BrowserWindow.fromId(ids.main)?.focus();
        }, windows);
      }
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
            windows.main
          )
        )
        .toBe(true);
      await finishProbe(`${scope}-window-focus`, true);

      await startProbe();
      await app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id)?.minimize();
      }, windows.main);
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isMinimized(),
            windows.main
          )
        )
        .toBe(true);
      await app.evaluate(({ BrowserWindow }, id) => {
        const main = BrowserWindow.fromId(id);
        main?.restore();
        main?.focus();
      }, windows.main);
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
            windows.main
          )
        )
        .toBe(true);
      await finishProbe(`${scope}-desktop-return`, true);
    }
    await input.fill("");
    await input.press("Enter");
  });

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
        await finishProbe(
          `depth-${depth}-open-${repeat}`,
          overlay,
          overlay ? undefined : id
        );
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
      await finishProbe("drag-open", false, id);
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
