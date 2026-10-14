import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electronPath = createRequire(import.meta.url)("electron") as string;
const FRAME_COUNT = 12;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const SEQUENCES = /^Sequences/;
const FRAME_NUMBER = /^\d+ \/ 12$/;
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let originals: string;
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
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
}

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);
test.beforeAll(async () => {
  root = createTestRuntime("sequence-playback-pause");
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
  const dpr = await app.evaluate(({ screen }) =>
    Math.min(Math.ceil(screen.getPrimaryDisplay().scaleFactor), 3)
  );
  await app.close();

  const fixture = path.join(root, "fixture");
  originals = path.join(fixture, "originals");
  const thumbnails = path.join(profile, "thumbnails");
  fs.mkdirSync(originals, { recursive: true });
  fs.mkdirSync(thumbnails, { recursive: true });
  const sqlEscape = (value: string) => value.replaceAll("'", "''");
  const statements = [
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'${sqlEscape(fixture)}','PauseFixture',${FRAME_COUNT},1)`,
  ];
  for (let id = 1; id <= FRAME_COUNT; id++) {
    const filename = `PauseFixture-${String(id).padStart(2, "0")}.png`;
    const photoPath = path.join(originals, filename);
    // Match thumbnailer v4: startup reconciles every stored path to canonical md.
    const thumbnailPath = (size: string) =>
      path.join(
        thumbnails,
        `${createHash("md5").update(`${photoPath}_${size}_v4_${dpr}`).digest("hex")}.webp`
      );
    const image = sharp({
      create: {
        width: 1600,
        height: 1000,
        channels: 3,
        background: { r: 40 + id * 12, g: 105, b: 190 - id * 8 },
      },
    });
    await image.clone().png().toFile(photoPath);
    for (const [size, base] of Object.entries({ sm: 256, md: 512, lg: 800 })) {
      await image
        .clone()
        .resize(base * dpr, base * dpr, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .webp({ quality: 85, effort: 1 })
        .toFile(thumbnailPath(size));
    }
    statements.push(
      `INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_favorite,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(${id},'${sqlEscape(photoPath)}','${filename}',1,${fs.statSync(photoPath).size},${id},1600,1000,'png','${sqlEscape(thumbnailPath("md"))}',0,1,1,1,1)`
    );
  }
  statements.push(
    `INSERT INTO photo_sequences(id,folder_id,type,source,representative_photo_id,started_at,ended_at,frame_count,user_locked,created_at,updated_at) VALUES(1,1,'burst','manual',1,1,${FRAME_COUNT},${FRAME_COUNT},1,1,1)`
  );
  for (let id = 1; id <= FRAME_COUNT; id++) {
    statements.push(
      `INSERT INTO photo_sequence_members(sequence_id,photo_id,position) VALUES(1,${id},${id - 1})`
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
async function assertBounds() {
  const issues = await page.evaluate(() => {
    const overflow = [
      document.documentElement,
      document.body,
      ...document.querySelectorAll("main"),
    ].some((element) => element.scrollWidth > element.clientWidth + 2);
    const escaped = [
      ...document.querySelectorAll(
        '.lightbox-interactive, .lightbox-interactive header, .lightbox-interactive header button, .lightbox-interactive .lightbox-control-button, .lightbox-interactive [role="status"], .lightbox-interactive [role="status"] button, [role="dialog"], [role="menu"]'
      ),
    ]
      .filter((element) => {
        const style = getComputedStyle(element);
        return (
          element.getClientRects().length > 0 &&
          style.visibility !== "hidden" &&
          Number(style.opacity) > 0
        );
      })
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

async function startSequencePlayback() {
  const group = page.locator('[data-sequence-id="1"]');
  await expect(group).toBeVisible();
  await group.dblclick();
  const lightbox = page.locator(".lightbox-interactive");
  await expect(lightbox).toBeVisible();
  const pause = lightbox.getByRole("button", {
    name: "Pause slideshow",
    exact: true,
  });
  if (!(await pause.isVisible())) {
    await page.keyboard.press("Space");
  }
  await expect(pause).toBeVisible();
  await lightbox.getByRole("button", { name: "2 fps", exact: true }).click();
  const preview = lightbox.locator("[data-lightbox-playback-frame]");
  await expect(preview).toBeVisible();
  await expect
    .poll(() =>
      preview.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0
      )
    )
    .toBe(true);
  const firstSource = await preview.getAttribute("src");
  await expect(preview).not.toHaveAttribute("src", firstSource ?? "");
  await expect
    .poll(() =>
      preview.evaluate(
        (element: HTMLImageElement) =>
          element.complete && element.naturalWidth > 0
      )
    )
    .toBe(true);
  return { lightbox, preview };
}

for (const size of SIZES) {
  for (const pauseWith of ["button", "Space"] as const) {
    test(`${size.width}x${size.height} ${pauseWith} freezes the preview while the original loads`, async () => {
      await app.evaluate(({ BrowserWindow }, requested) => {
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        );
      }, size);
      await page.reload();
      await page.waitForFunction(() => Boolean(window.__e2eNavigate));
      await page.evaluate(() => window.__e2eNavigate?.("/"));
      await page.getByRole("button", { name: SEQUENCES }).click();
      const { lightbox, preview } = await startSequencePlayback();

      let releaseOriginals: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseOriginals = resolve;
      });
      const heldUrls: string[] = [];
      const originalRequest = (url: URL) =>
        url.pathname === "/image" &&
        url.searchParams.get("path")?.startsWith(`${originals}${path.sep}`) ===
          true;
      await page.route(originalRequest, async (route) => {
        heldUrls.push(route.request().url());
        await gate;
        await route.fulfill({ response: await route.fetch() });
      });

      try {
        if (pauseWith === "button") {
          await lightbox
            .getByRole("button", { name: "Pause slideshow", exact: true })
            .click();
        } else {
          await page.keyboard.press("Space");
        }
        await expect(
          lightbox.getByRole("button", { name: "Play slideshow", exact: true })
        ).toBeVisible();

        const counter = lightbox.locator("header span").first();
        await expect(counter).toHaveText(FRAME_NUMBER);
        const pausedFrame = await counter.textContent();
        const pausedSource = await preview.getAttribute("src");
        const original = lightbox.locator("[data-lightbox-original-frame]");
        await expect(original).toHaveAttribute("aria-hidden", "true");
        await expect(original).toHaveCSS("opacity", "0");
        const originalSource = await original.getAttribute("src");
        expect(originalSource).not.toBe(pausedSource);
        await expect
          .poll(() => heldUrls.includes(originalSource ?? ""))
          .toBe(true);
        await expect(lightbox.locator("[data-lightbox-image]")).toHaveAttribute(
          "src",
          pausedSource ?? ""
        );

        // Hold longer than both the spinner grace period and a playback tick.
        const samples = await lightbox.evaluate(
          (element) =>
            new Promise<
              Array<{
                frame: string | null;
                previewReady: boolean;
                source: string | null;
                loading: boolean;
              }>
            >((resolve) => {
              const frames: Array<{
                frame: string | null;
                previewReady: boolean;
                source: string | null;
                loading: boolean;
              }> = [];
              const started = performance.now();
              const sample = () => {
                const image = element.querySelector<HTMLImageElement>(
                  "[data-lightbox-playback-frame]"
                );
                frames.push({
                  frame:
                    element.querySelector("header span")?.textContent ?? null,
                  previewReady: Boolean(
                    image?.complete &&
                      image.naturalWidth > 0 &&
                      Number(getComputedStyle(image).opacity) > 0
                  ),
                  source: image?.getAttribute("src") ?? null,
                  loading: Boolean(
                    element.querySelector('[aria-label="Loading..."]')
                  ),
                });
                if (performance.now() - started >= 800) {
                  resolve(frames);
                } else {
                  requestAnimationFrame(sample);
                }
              };
              sample();
            })
        );
        expect(samples.length).toBeGreaterThan(1);
        expect(
          samples.every(
            (sample) =>
              sample.frame === pausedFrame &&
              sample.previewReady &&
              sample.source === pausedSource &&
              !sample.loading
          )
        ).toBe(true);
        await assertBounds();
        await page.screenshot({
          path: test.info().outputPath("paused-preview.png"),
        });

        releaseOriginals();
        await expect(original).toHaveAttribute("data-lightbox-image", "true");
        await expect(original).not.toHaveAttribute("aria-hidden", "true");
        await expect(original).toHaveCSS("opacity", "1");
        await expect(preview).toHaveCount(0);
        await expect(counter).toHaveText(pausedFrame ?? "");
        await expect
          .poll(() =>
            original.evaluate(
              (element: HTMLImageElement) =>
                element.complete && element.naturalWidth === 1600
            )
          )
          .toBe(true);
        await expect(lightbox.locator('[aria-label="Loading..."]')).toHaveCount(
          0
        );
        await assertBounds();
        await page.screenshot({
          path: test.info().outputPath("paused-original.png"),
        });
        await lightbox
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await expect(lightbox).toHaveCount(0);
      } finally {
        releaseOriginals();
        await page.unrouteAll({ behavior: "wait" });
      }
    });
  }

  test(`${size.width}x${size.height} keeps the preview after an original failure and retries successfully`, async () => {
    await app.evaluate(({ BrowserWindow }, requested) => {
      BrowserWindow.getAllWindows()[0].setSize(
        requested.width,
        requested.height
      );
    }, size);
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await page.getByRole("button", { name: SEQUENCES }).click();
    const { lightbox, preview } = await startSequencePlayback();

    let originalRequests = 0;
    const originalRequest = (url: URL) =>
      url.pathname === "/image" &&
      url.searchParams.get("path")?.startsWith(`${originals}${path.sep}`) ===
        true;
    await page.route(originalRequest, async (route) => {
      originalRequests++;
      if (originalRequests === 1) {
        await route.abort("failed");
      } else {
        await route.fulfill({ response: await route.fetch() });
      }
    });

    try {
      await lightbox
        .getByRole("button", { name: "Pause slideshow", exact: true })
        .click();
      await expect(
        lightbox.getByRole("button", { name: "Play slideshow", exact: true })
      ).toBeVisible();
      const counter = lightbox.locator("header span").first();
      const pausedFrame = await counter.textContent();
      const pausedSource = await preview.getAttribute("src");
      const status = lightbox.getByRole("status");
      await expect(status).toContainText(
        "Could not load the original. Showing the preview."
      );
      await expect.poll(() => originalRequests).toBe(1);
      await expect(preview).toBeVisible();
      await expect(preview).toHaveAttribute("data-lightbox-image", "true");
      await expect(preview).toHaveAttribute("src", pausedSource ?? "");
      await expect(lightbox.locator('[aria-label="Loading..."]')).toHaveCount(
        0
      );
      const previewBox = await preview.boundingBox();
      expect(previewBox).not.toBeNull();
      await assertBounds();
      await page.screenshot({
        path: test.info().outputPath("original-failed-preview.png"),
      });

      await status.getByRole("button", { name: "Retry", exact: true }).click();
      const original = lightbox.locator("[data-lightbox-original-frame]");
      await expect.poll(() => originalRequests).toBe(2);
      await expect(original).toHaveAttribute("data-lightbox-image", "true");
      await expect(original).toHaveCSS("opacity", "1");
      await expect(preview).toHaveCount(0);
      await expect(status).toHaveCount(0);
      await expect(counter).toHaveText(pausedFrame ?? "");
      const originalBox = await original.boundingBox();
      expect(originalBox).not.toBeNull();
      if (previewBox && originalBox) {
        for (const dimension of ["x", "y", "width", "height"] as const) {
          expect(
            Math.abs(originalBox[dimension] - previewBox[dimension])
          ).toBeLessThanOrEqual(1);
        }
      }
      await assertBounds();
      await page.screenshot({
        path: test.info().outputPath("original-retry-success.png"),
      });
      await lightbox
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await expect(lightbox).toHaveCount(0);
    } finally {
      await page.unrouteAll({ behavior: "wait" });
    }
  });
}
