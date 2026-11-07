import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import sharp from "sharp";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const SIZES = [
  [720, 480],
  [900, 600],
  [1280, 800],
] as const;
const SCROLLED = /is-scrolled/;
const BLUR = /blur\(36px\)/;
const CHOOSE_ASSET = /^(Choose image|Choose video|Replace file)$/;
const PLUGIN_PANEL = '[data-plugin-section="configuration"]';
const PLUGIN_TOOLBAR =
  '[data-plugin-manager-view] > [data-surface="page-heading"]';
const PLUGIN_TEXT = [
  `${PLUGIN_TOOLBAR} h1`,
  `${PLUGIN_TOOLBAR} p`,
  `${PLUGIN_PANEL} h3`,
  "[data-plugin-list] h2",
];
const MODES = [
  ["Floating layout", "mica"],
  ["Classic layout", "compatibility"],
] as const;
let app: ElectronApplication;
let page: Page;
let root: string;
let profile: string;
let env: Record<string, string>;

async function navigate(route: string) {
  const result = await page.evaluate(
    (next) => window.__e2eNavigate?.(next),
    route
  );
  expect(result).toBe(route);
  await page.locator("main").first().waitFor();
}

async function applyTheme(theme: "dark" | "light") {
  await navigate("/settings/appearance");
  const toggle = page.locator(".theme-toggle-switch");
  await expect(toggle).toBeVisible();
  const html = page.locator("html");
  if (
    !(await html.evaluate(
      (root, value) => root.classList.contains(value),
      theme
    ))
  ) {
    await toggle.click();
  }
  await expect
    .poll(() =>
      html.evaluate((root, value) => root.classList.contains(value), theme)
    )
    .toBe(true);
  await expect(html).not.toHaveAttribute("data-theme-transition");
}

async function chooseSetting(label: string, option: string) {
  const control = page.getByRole("combobox", { name: label, exact: true });
  await control.focus();
  await control.press("ArrowDown");
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function resize(width: number, height: number) {
  await app.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()
        .find((window) => !window.isDestroyed() && window.isVisible())
        ?.setSize(size.width, size.height);
    },
    { width, height }
  );
  await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(width);
}

function execute(sql: string) {
  execFileSync(
    createRequire(import.meta.url)("electron") as string,
    [
      "-e",
      "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.exec(require('node:fs').readFileSync(0,'utf8'))}finally{d.close()}",
      path.join(profile, "data", "ai-image-manager.db"),
    ],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, input: sql, encoding: "utf8" }
  );
}

function fillOf(selector: string) {
  return page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);
}

async function assertBounds() {
  const overflow = await page.evaluate(() => {
    const elements = [
      document.documentElement,
      ...document.querySelectorAll(
        "main, [data-surface='toolbar'], [data-surface='page-heading'], [data-surface='overlay'], [data-surface='inspector-shell']"
      ),
    ];
    return elements
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          right: bounds.right,
          bottom: bounds.bottom,
          overflow: element.scrollWidth - element.clientWidth,
          overlay: element.matches(
            "[data-surface='overlay'], [data-surface='inspector-shell']"
          ),
          top: bounds.top,
          viewportHeight: innerHeight,
          viewportWidth: innerWidth,
        };
      })
      .filter((bounds) => bounds.right > 0 && bounds.bottom > 0);
  });
  for (const bounds of overflow) {
    expect(bounds.left).toBeGreaterThanOrEqual(-2);
    expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth + 2);
    expect(bounds.overflow).toBeLessThanOrEqual(2);
    if (bounds.overlay) {
      expect(bounds.top).toBeGreaterThanOrEqual(-2);
      expect(bounds.bottom).toBeLessThanOrEqual(bounds.viewportHeight + 2);
    }
  }
}

test.setTimeout(240_000);
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  root = createTestRuntime("nebula-material");
  profile = path.join(root, "profile");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch, { recursive: true });
  const hook = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    hook,
    `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');app.setAppPath(${JSON.stringify(path.resolve("."))});for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
  );
  env = Object.fromEntries(
    Object.entries({
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "local"),
      TEMP: scratch,
      TMP: scratch,
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  app = await launchTestApp(root, {
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "-r",
      hook,
      "--e2e",
      path.resolve("."),
    ],
    env,
  });
  page = await waitForHomeWindow(app);
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("theme", "dark");
  });
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  execute(
    Array.from(
      { length: 24 },
      (_, i) =>
        `INSERT INTO cull_sessions(name,mode,status,created_at,archived_at) VALUES ('${i === 0 ? "Autumn portrait shoot — long task name for responsive layout" : `Archived shoot ${i + 1}`}', 'duel', 'completed', 1793203200000, 1793203200000);`
    ).join("\n") +
      "\nINSERT INTO cull_sessions(name,created_at) VALUES ('Active shoot',1793203200000);"
  );
  const photo = path.join(root, "photo.png");
  fs.copyFileSync(path.resolve("assets/readme/background.png"), photo);
  const sqlPath = (value: string) => value.replaceAll("'", "''");
  execute(
    `INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES (1,'${sqlPath(root)}','Nebula test',1,1793203200000);
    INSERT INTO photos(id,path,folder_id,filename,width,height,format,thumbnail_path,is_ai_processed,is_face_processed,created_at)
    VALUES (1,'${sqlPath(photo)}',1,'Nebula test photo.png',1586,992,'png','${sqlPath(photo)}',1,1,1793203200000);
    INSERT INTO advanced_exif_data(photo_id,status,parser_version,enriched_at)
    VALUES (1,'unsupported',3,1793203200000);`
  );
  await page.reload();
  await page.waitForFunction(() => Boolean(window.__e2eNavigate));
  await navigate("/settings/plugins");
  await page
    .getByRole("checkbox", { name: "Toggle plugin: Nebula Glass" })
    .locator("..")
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-nebula-glass",
    "active"
  );
});

test("keeps archive materials readable, responsive and tied to plugin settings", async () => {
  for (const theme of ["dark", "light"] as const) {
    await applyTheme(theme);
    for (const [width, height] of SIZES) {
      await resize(width, height);
      await navigate("/settings/cull-archive");
      await expect(page.locator("[data-task-key]")).toHaveCount(24);
      const scroll = page.getByTestId("cull-list-scroll");
      const header = page.getByTestId("cull-list-header");
      await scroll.evaluate((element) => {
        element.scrollTop = 0;
      });
      await expect(header).not.toHaveClass(SCROLLED);
      await expect(header).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      expect(
        await page
          .locator("[data-task-key]")
          .first()
          .evaluate((element) => getComputedStyle(element).backdropFilter)
      ).toBe("none");
      await assertBounds();
      if (width === 1280) {
        await assertTextContrast();
      }
      await page.screenshot({
        path: test.info().outputPath(`archive-${theme}-${width}x${height}.png`),
      });
      if (width === 1280 && process.env.AIM_NEBULA_BASELINE_CSS) {
        // Suspend only Nebula rules so the baseline is not mixed with the new recipe.
        const suspended = await page.evaluateHandle(() => {
          const recipes: Array<{ style: CSSStyleDeclaration; text: string }> =
            [];
          const visit = (rules: CSSRuleList) => {
            for (const rule of rules) {
              if (
                rule instanceof CSSStyleRule &&
                rule.selectorText.includes("data-nebula-glass")
              ) {
                recipes.push({ style: rule.style, text: rule.style.cssText });
                rule.style.cssText = "";
              } else if ("cssRules" in rule) {
                visit((rule as CSSGroupingRule).cssRules);
              }
            }
          };
          for (const sheet of document.styleSheets) {
            visit(sheet.cssRules);
          }
          const cards = [...document.querySelectorAll("[data-task-key]")];
          for (const card of cards) {
            card.removeAttribute("data-surface");
          }
          return { recipes, cards };
        });
        const baseline = await page.addStyleTag({
          content: fs.readFileSync(process.env.AIM_NEBULA_BASELINE_CSS, "utf8"),
        });
        await page.screenshot({
          path: test.info().outputPath(`archive-${theme}-before.png`),
        });
        await baseline.evaluate((element) =>
          element.parentNode?.removeChild(element)
        );
        await suspended.evaluate(({ recipes, cards }) => {
          for (const { style, text } of recipes) {
            style.cssText = text;
          }
          for (const card of cards) {
            card.setAttribute("data-surface", "card");
          }
        });
        await suspended.dispose();
      }
      await scroll.evaluate((element) => {
        element.scrollTop = 400;
      });
      await expect(header).toHaveClass(SCROLLED);
      await expect(header).not.toHaveCSS(
        "background-color",
        "rgba(0, 0, 0, 0)"
      );
      await assertBounds();
      await header.getByRole("searchbox").fill("no matches here");
      await expect(page.locator("[data-task-key]")).toHaveCount(0);
      await header.getByRole("searchbox").fill("");
      await expect(page.locator("[data-task-key]")).toHaveCount(24);
    }
    for (const [width, height] of SIZES) {
      await resize(width, height);
      for (const route of [
        "/cull",
        "/people",
        "/duplicates",
        "/trash",
        "/dashboard",
        "/settings/appearance",
        "/albums",
      ]) {
        await navigate(route);
        await assertBounds();
      }
    }
  }
  await navigate("/settings/cull-archive");
  await page.getByTestId("cull-list-scroll").evaluate((element) => {
    element.scrollTop = 0;
  });
  await page
    .locator("[data-task-key]")
    .first()
    .getByRole("button")
    .last()
    .click();
  await expect(page.locator('[data-surface="overlay"]').last()).toBeVisible();
  await assertBounds();
  await page.keyboard.press("Escape");
  await page.getByTestId("cull-clear-archives").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertBounds();
  await page.keyboard.press("Escape");
  await navigate("/settings/plugins");
  const blur = page.getByRole("slider", { name: "Glass blur", exact: true });
  await blur.focus();
  await blur.press("End");
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((element) =>
          element.style.getPropertyValue("--nebula-glass-blur")
        )
    )
    .toBe("36px");
  await navigate("/settings/cull-archive");
  const archive = page.locator('[data-surface="page"]');
  await expect
    .poll(() =>
      archive.evaluate((element) => getComputedStyle(element).backdropFilter)
    )
    .toMatch(BLUR);
  await app.evaluate(({ webContents }) => {
    webContents
      .getAllWebContents()
      .find(
        (contents) => contents.getType() === "window" && !contents.isDestroyed()
      )
      ?.setZoomFactor(1.25);
  });
  await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1024);
  await assertBounds();
  await app.evaluate(({ webContents }) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) {
        contents.setZoomFactor(1);
      }
    }
  });
  await page.emulateMedia({ forcedColors: "active" });
  await expect
    .poll(() =>
      page
        .getByTestId("cull-list-header")
        .evaluate((element) => getComputedStyle(element).backdropFilter)
    )
    .toBe("none");
  await page.emulateMedia({ forcedColors: "none" });
  const session = await page.context().newCDPSession(page);
  await session.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-transparency", value: "reduce" }],
  });
  await expect
    .poll(() =>
      page
        .getByTestId("cull-list-header")
        .evaluate((element) => getComputedStyle(element).backdropFilter)
    )
    .toBe("none");
  await expect
    .poll(() => fillOf('[data-testid="cull-list-header"]'))
    .toBe("rgb(255, 255, 255)");
  await session.send("Emulation.setEmulatedMedia", { features: [] });
  await session.detach();
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "true";
  });
  await page.getByTestId("cull-list-scroll").evaluate((element) => {
    element.scrollTop = 400;
  });
  await expect
    .poll(() =>
      page
        .getByTestId("cull-list-header")
        .evaluate((element) => getComputedStyle(element).backdropFilter)
    )
    .toBe("none");
  await page.evaluate(() => {
    document.documentElement.dataset.reducedMotion = "false";
  });
  await navigate("/cull/999999999");
  expect(await fillOf('[data-surface="immersive"]')).toBe("rgb(0, 0, 0)");
  await navigate("/settings/plugins");
  await page
    .getByRole("checkbox", { name: "Toggle plugin: Nebula Glass" })
    .locator("..")
    .click();
  await expect(page.locator("html")).not.toHaveAttribute("data-nebula-glass");
  expect(
    await page
      .locator("html")
      .evaluate((element) =>
        element.style.getPropertyValue("--nebula-glass-blur")
      )
  ).toBe("");
});

async function assertTextContrast(
  selectors = [
    '[data-surface="settings"] > [data-surface="toolbar"] h1',
    '[data-surface="sidebar"] button.text-muted-foreground',
    ".draglayer .text-muted-foreground",
    '[data-testid="cull-list-header"] h1',
    '[data-testid="cull-list-header"] .text-muted-foreground',
    "[data-task-key] .text-muted-foreground",
    "[data-task-key] .text-primary",
    '[data-testid="cull-clear-archives"]',
  ]
) {
  await page.mouse.move(1, 1);
  const targets = await page.evaluate((selectors) => {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas unavailable");
    }
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Missing contrast target: ${selector}`);
      }
      const rect = element.getBoundingClientRect();
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = getComputedStyle(element).color;
      context.fillRect(0, 0, 1, 1);
      const y = Math.floor(rect.y + rect.height / 2);
      return {
        selector,
        points: [0.2, 0.5, 0.8].map((fraction) => [
          Math.floor(rect.x + rect.width * fraction),
          y,
        ]),
        foreground: [...context.getImageData(0, 0, 1, 1).data],
      };
    });
  }, selectors);
  const hiddenText = await page.addStyleTag({
    content:
      "#app * { -webkit-text-fill-color: transparent !important; text-shadow: none !important; caret-color: transparent !important; } #app svg { visibility: hidden !important; }",
  });
  let screenshot: Buffer;
  try {
    screenshot = await page.screenshot();
  } finally {
    await hiddenText.evaluate((element) =>
      element.parentNode?.removeChild(element)
    );
  }
  const { data, info } = await sharp(screenshot)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  for (const target of targets) {
    for (const [x, y] of target.points) {
      const offset = (y * info.width + x) * info.channels;
      const color = [...data.subarray(offset, offset + 3)];
      const background = luminance(color);
      const alpha = target.foreground[3] / 255;
      const foreground = luminance(
        color.map(
          (channel, i) => target.foreground[i] * alpha + channel * (1 - alpha)
        )
      );
      const contrast =
        (Math.max(background, foreground) + 0.05) /
        (Math.min(background, foreground) + 0.05);
      expect(
        contrast,
        `${target.selector} at ${x},${y}`
      ).toBeGreaterThanOrEqual(4.5);
    }
  }
}

test("maintains contrast over bright, dark, detailed image and video backdrops", async () => {
  await navigate("/settings/plugins");
  await page
    .getByRole("checkbox", { name: "Toggle plugin: Nebula Glass" })
    .locator("..")
    .click();
  const fixtures: Array<{ file: string; kind: "Image" | "Video" }> = [];
  for (const [name, color] of [
    ["bright", "#ffffff"],
    ["dark", "#000000"],
  ]) {
    const file = path.join(root, `${name}.png`);
    await sharp({
      create: { width: 1280, height: 800, channels: 3, background: color },
    })
      .png()
      .toFile(file);
    fixtures.push({ file, kind: "Image" });
  }
  const detail = path.join(root, "detail.png");
  await sharp(
    Buffer.from(
      '<svg width="1280" height="800" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="a" width="24" height="24" patternUnits="userSpaceOnUse"><path fill="white" d="M0 0h24v24H0z"/><path fill="black" d="M0 0h12v12H0zM12 12h12v12H12z"/></pattern></defs><path fill="url(#a)" d="M0 0h1280v800H0z"/></svg>'
    )
  )
    .png()
    .toFile(detail);
  fixtures.push({ file: detail, kind: "Image" });
  fixtures.push({ file: path.join(root, "photo.png"), kind: "Image" });
  const video = await page.evaluate(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 200;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas unavailable");
    }
    const stream = canvas.captureStream(12);
    const recorder = new MediaRecorder(stream, {
      mimeType: "video/webm;codecs=vp8",
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.start();
    context.fillStyle = "white";
    context.fillRect(0, 0, 320, 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    context.fillStyle = "black";
    context.fillRect(0, 0, 160, 200);
    await new Promise((resolve) => setTimeout(resolve, 200));
    recorder.stop();
    await stopped;
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
  });
  const videoFile = path.join(root, "backdrop.webm");
  fs.writeFileSync(videoFile, Buffer.from(video));
  fixtures.push({ file: videoFile, kind: "Video" });
  for (const fixture of fixtures) {
    await navigate("/settings/plugins");
    await page.getByRole("combobox", { name: "Backdrop", exact: true }).click();
    await page.getByRole("option", { name: fixture.kind, exact: true }).click();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [file],
      });
    }, fixture.file);
    const wallpaper = page.locator(".nebula-glass-wallpaper");
    const previousSource = (await wallpaper.count())
      ? await wallpaper.getAttribute("src")
      : null;
    await page.getByRole("button", { name: CHOOSE_ASSET }).click();
    await expect
      .poll(() => page.locator(".nebula-glass-wallpaper").getAttribute("src"))
      .toContain("aim-plugin-user:");
    await expect
      .poll(() => page.locator(".nebula-glass-wallpaper").getAttribute("src"))
      .not.toBe(previousSource);
    await expect
      .poll(() =>
        page
          .locator(".nebula-glass-wallpaper")
          .evaluate((element) =>
            element instanceof HTMLImageElement
              ? element.complete && element.naturalWidth > 0
              : element instanceof HTMLVideoElement && element.readyState >= 2
          )
      )
      .toBe(true);
    for (const theme of ["light", "dark"] as const) {
      await resize(1280, 800);
      await applyTheme(theme);
      await navigate("/settings/plugins");
      await waitForPane();
      await assertTextContrast(PLUGIN_TEXT);
      await assertControlBoundary();
      await page.screenshot({
        path: test
          .info()
          .outputPath(`${path.basename(fixture.file)}-${theme}.png`),
      });
      if (fixture.file === detail) {
        await assertWallpaperIsBlurred();
      }
      if (fixture.kind === "Video") {
        await page.emulateMedia({ reducedMotion: "reduce" });
        const video = page.locator("video.nebula-glass-wallpaper");
        await expect
          .poll(() =>
            video.evaluate((element) => (element as HTMLVideoElement).paused)
          )
          .toBe(true);
        const currentTime = await video.evaluate(
          (element) => (element as HTMLVideoElement).currentTime
        );
        await assertTextContrast(PLUGIN_TEXT);
        expect(
          await video.evaluate(
            (element) => (element as HTMLVideoElement).currentTime
          )
        ).toBe(currentTime);
        for (const time of [0.05, 0.3]) {
          await video.evaluate(async (element, time) => {
            const video = element as HTMLVideoElement;
            const seeked = new Promise<void>((resolve) =>
              video.addEventListener("seeked", () => resolve(), { once: true })
            );
            video.currentTime = time;
            await seeked;
          }, time);
          await assertTextContrast(PLUGIN_TEXT);
        }
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await expect
          .poll(() =>
            video.evaluate((element) => (element as HTMLVideoElement).paused)
          )
          .toBe(false);
      }
    }
  }
  await page.locator("video.nebula-glass-wallpaper").evaluate((video) => {
    video.dispatchEvent(new Event("error"));
  });
  await expect(page.locator("video.nebula-glass-wallpaper")).toHaveCount(0);
  await expect(page.locator(".nebula-glass-aurora")).toBeVisible();
  await expect(page.locator(".nebula-glass-fluid-canvas")).toHaveCount(0);
  await page.reload();
  await expect(page.locator("video.nebula-glass-wallpaper")).toBeVisible();
});

function luminance(rgb: number[]) {
  return rgb.slice(0, 3).reduce((sum, value, i) => {
    const channel = value / 255;
    return (
      sum +
      (channel <= 0.040_45
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4) *
        [0.2126, 0.7152, 0.0722][i]
    );
  }, 0);
}

async function assertControlBoundary() {
  const layout = page.getByRole("combobox", { name: "Material mode" });
  const bounds = await layout.boundingBox();
  if (!bounds) {
    throw new Error("Missing layout control");
  }
  const { data, info } = await sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const x = Math.floor(bounds.x + bounds.width / 2);
  const read = (y: number) => {
    const offset = (Math.floor(y) * info.width + x) * info.channels;
    return luminance([...data.subarray(offset, offset + 3)]);
  };
  const border = read(bounds.y);
  const surrounding = read(bounds.y - 3);
  expect(
    (Math.max(border, surrounding) + 0.05) /
      (Math.min(border, surrounding) + 0.05)
  ).toBeGreaterThanOrEqual(3);
}

async function waitForPane() {
  await expect(page.locator(PLUGIN_PANEL)).toBeVisible();
  await page.locator(PLUGIN_PANEL).evaluate(async (element) => {
    const entrance = element.closest(".animate-page-enter");
    await Promise.all(
      entrance?.getAnimations().map((animation) => animation.finished) ?? []
    );
  });
}

async function assertWallpaperIsBlurred() {
  const bounds = await page.locator(PLUGIN_PANEL).boundingBox();
  if (!bounds) {
    throw new Error("Missing glass pane");
  }
  const clip = {
    x: Math.round(bounds.x + 35),
    y: Math.round(bounds.y + 4),
    width: 144,
    height: 6,
  };
  const measure = async () => {
    const screenshot = await page.screenshot({ clip });
    const { stdev } = (await sharp(screenshot).stats()).channels[0];
    return stdev;
  };
  const blurred = await measure();
  const unfiltered = await page.addStyleTag({
    content: `${PLUGIN_PANEL} { backdrop-filter: none !important; }`,
  });
  try {
    const unblurred = await measure();
    expect(unblurred).toBeGreaterThan(12);
    expect(blurred).toBeLessThan(unblurred * 0.35);
  } finally {
    await unfiltered.evaluate((element) =>
      element.parentNode?.removeChild(element)
    );
  }
}

test("keeps the gallery, settings and overlays inside the full material matrix", async () => {
  const materials = new Map<string, string>();
  const html = page.locator("html");
  for (const theme of ["dark", "light"] as const) {
    await resize(1280, 800);
    await applyTheme(theme);
    await navigate("/settings/plugins");
    for (const [label, mode] of MODES) {
      await chooseSetting("Material mode", label);
      await expect(html).toHaveAttribute("data-nebula-mode", mode);
      for (const [background, source] of [
        ["Aurora fluid", "aurora"],
        ["Image", "image"],
        ["Video", "video"],
      ]) {
        await chooseSetting("Backdrop", background);
        await expect(html).toHaveAttribute("data-nebula-backdrop", source);
        for (const [width, height] of SIZES) {
          await resize(width, height);
          await waitForPane();
          await assertBounds();
          const fill = await page
            .locator(PLUGIN_PANEL)
            .evaluate((element) => getComputedStyle(element).background);
          const reference = materials.get(theme);
          if (reference) {
            expect(fill).toBe(reference);
          } else {
            materials.set(theme, fill);
          }
          const layout = page.getByRole("combobox", { name: "Material mode" });
          await layout.focus();
          await layout.press("ArrowDown");
          await expect(page.getByRole("listbox")).toBeVisible();
          await assertBounds();
          await layout.press("Escape");
          await expect(page.getByRole("listbox")).not.toBeVisible();
          await page.screenshot({
            path: test
              .info()
              .outputPath(`${theme}-${mode}-${source}-${width}x${height}.png`),
          });
          await navigate("/");
          await assertBounds();
          const photo = page.locator('[data-photo-id="1"]').first();
          await photo.click();
          const inspector = page.locator('[data-surface="inspector"]');
          const shell = page.locator('[data-surface="inspector-shell"]');
          await expect(inspector).toBeVisible();
          await expect(shell).toHaveCSS("backdrop-filter", "none");
          await assertBounds();
          if (width <= 1120) {
            await expect(shell).toHaveAttribute("role", "dialog");
            await expect(inspector).not.toHaveCSS("backdrop-filter", "none");
          } else {
            await expect(inspector).toHaveCSS("backdrop-filter", "none");
          }
          await page.keyboard.press("Escape");
          await expect(shell).not.toBeVisible();
          await navigate("/settings/plugins");
        }
      }
    }
  }
});
