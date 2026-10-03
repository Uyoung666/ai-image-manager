import fs from "node:fs";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Locator,
  type Page,
} from "@playwright/test";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";
import { seedWanderLibrary } from "./helpers/wander";

const WINDOW_SIZES = [
  { width: 720, height: 480, zoom: 1 },
  { width: 900, height: 600, zoom: 1 },
  { width: 1280, height: 800, zoom: 1 },
  { width: 720, height: 480, zoom: 1.5 },
];
let app: ElectronApplication;
let page: Page;

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async () => {
  const root = createTestRuntime("smooth-input");
  const profile = path.join(root, "profile");
  seedWanderLibrary(profile, { enabled: false, photoCount: 4 });
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  app = await launchTestApp(root, {
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      "--e2e",
      path.resolve("."),
    ],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      CI: "e2e",
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "local"),
      TEMP: scratch,
      TMP: scratch,
    },
  });
  page = await app.firstWindow();
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("ui.reduceMotion", "false");
  });
  await page.reload();
  await page.locator("main").waitFor({ state: "visible" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus()
  );
});

test.afterAll(async () => {
  await app?.close();
});

async function navigate(route: string) {
  await page.evaluate((next) => window.__e2eNavigate?.(next), route);
  await page.locator("main").waitFor({ state: "visible" });
}

async function captureWindow(filename: string) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      })
  );
  // Electron's native capture keeps the full viewport at non-default zoom.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image =
      await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  fs.writeFileSync(
    test.info().outputPath(filename),
    Buffer.from(png, "base64")
  );
}

async function expectInsideViewport(locator: Locator) {
  const bounds = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: innerWidth,
      height: innerHeight,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-2);
  expect(bounds.top).toBeGreaterThanOrEqual(-2);
  expect(bounds.right).toBeLessThanOrEqual(bounds.width + 2);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height + 2);
}

async function expectCaretAligned(input: Locator) {
  await expect(input).toHaveAttribute("data-smooth-caret-active", "true");
  await expect
    .poll(() =>
      input.evaluate((element) => {
        const field = element as HTMLInputElement;
        const caret = field.parentElement?.querySelector<HTMLElement>(
          ".smooth-input__caret"
        );
        if (!caret) {
          return Number.POSITIVE_INFINITY;
        }
        const styles = getComputedStyle(field);
        const context = document.createElement("canvas").getContext("2d");
        if (!context) {
          return Number.POSITIVE_INFINITY;
        }
        context.font = styles.font;
        const prefix = field.value.slice(0, field.selectionStart ?? 0);
        const expected =
          field.getBoundingClientRect().left +
          field.clientLeft +
          Number.parseFloat(styles.paddingLeft) +
          context.measureText(prefix).width -
          field.scrollLeft;
        return Math.abs(caret.getBoundingClientRect().left - expected);
      })
    )
    .toBeLessThan(2);
}

for (const size of WINDOW_SIZES) {
  test(`search and naming fit ${size.width}x${size.height} at ${size.zoom} zoom`, async () => {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setContentSize(bounds.width, bounds.height);
      window.webContents.setZoomFactor(bounds.zoom);
    }, size);
    await expect
      .poll(() => page.evaluate(() => innerWidth))
      .toBeGreaterThan(size.width / size.zoom - 2);
    await expect
      .poll(() => page.evaluate(() => innerWidth))
      .toBeLessThan(size.width / size.zoom + 2);
    await navigate("/");
    const search = page.locator("input.home-search-input");
    await search.fill("");
    await search.pressSequentially("abc", { delay: 35 });
    await expectCaretAligned(search);
    await expect(
      search.locator("..").locator(".smooth-input__caret")
    ).toHaveCSS("transition-duration", "0.1s");
    await search.fill("中文 emoji 🐱 ".repeat(40));
    await search.press("End");
    await expectCaretAligned(search);
    expect(
      await search.evaluate((element) => element.scrollLeft)
    ).toBeGreaterThan(0);
    await search.press("Home");
    await expectCaretAligned(search);
    await search.press("Control+a");
    await expect(search).not.toHaveAttribute(
      "data-smooth-caret-active",
      "true"
    );
    await search.press("ArrowRight");
    await expectCaretAligned(search);
    await search.fill("");
    await page.keyboard.press("Control+k");
    const command = page.locator("[cmdk-input]");
    await command.fill("settings");
    await expectCaretAligned(command);
    await expectInsideViewport(page.locator("[cmdk-root]"));
    await page.keyboard.press("Escape");
    await navigate("/albums");
    await page
      .getByRole("button", { name: "New Album", exact: true })
      .last()
      .click();
    const name = page.getByPlaceholder("Album name", { exact: true });
    await name.fill("中文 🐱 album");
    await expectCaretAligned(name);
    await expectInsideViewport(name);
    const overflow = await page.evaluate(() =>
      [
        document.documentElement,
        document.body,
        document.querySelector("main"),
      ].map((element) =>
        element ? element.scrollWidth - element.clientWidth : 0
      )
    );
    expect(overflow.every((value) => value <= 2)).toBe(true);
    await captureWindow(`naming-${size.width}-${size.zoom}.png`);
  });
}

test("IME confirmation, theme changes and accessibility fallbacks preserve editing", async () => {
  await navigate("/");
  const search = page.locator("input.home-search-input");
  await search.fill("中文");
  await expectCaretAligned(search);
  const history = await page.evaluate(() =>
    localStorage.getItem("search_history")
  );
  await search.dispatchEvent("compositionstart", { data: "zhong" });
  await expect(search).not.toHaveAttribute("data-smooth-caret-active", "true");
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(
    await page.evaluate(() => localStorage.getItem("search_history"))
  ).toBe(history);
  await search.dispatchEvent("compositionend", { data: "中" });
  await expectCaretAligned(search);
  for (const theme of ["light", "dark"]) {
    await page.evaluate((next) => {
      document.documentElement.classList.remove("light", "dark");
      document.documentElement.classList.add(next);
    }, theme);
    await search.focus();
    await expectCaretAligned(search);
    await captureWindow(`search-${theme}.png`);
  }
  await navigate("/settings/plugins");
  await page
    .getByRole("checkbox", { name: "Toggle plugin: Nebula Glass" })
    .locator("..")
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-nebula-glass",
    "active"
  );
  await navigate("/");
  await search.fill("中文 🐱 glass");
  await expectCaretAligned(search);
  await captureWindow("search-nebula-glass.png");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(search).not.toHaveAttribute("data-smooth-caret-active", "true");
  await page.emulateMedia({
    reducedMotion: "no-preference",
    forcedColors: "active",
  });
  await expect(search).not.toHaveAttribute("data-smooth-caret-active", "true");
  await page.emulateMedia({ forcedColors: "none" });
  await expectCaretAligned(search);
  await search.fill("שלום");
  await expect(search).not.toHaveAttribute("data-smooth-caret-active", "true");
  await navigate("/settings/appearance");
  await page
    .getByRole("checkbox", { name: "Reduce motion", exact: true })
    .locator("..")
    .click();
  await navigate("/");
  await search.fill("hello");
  await expect(search).not.toHaveAttribute("data-smooth-caret-active", "true");
});
