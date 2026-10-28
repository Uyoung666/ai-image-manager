import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

declare global {
  interface Window {
    tooltipFocusEvents: string[];
  }
}

let app: ElectronApplication;
let page: Page;
let mainId: number;

test.describe.configure({ mode: "serial" });
test.setTimeout(90_000);

test.beforeAll(async () => {
  const root = createTestRuntime("tooltip-window-focus");
  const profile = path.join(root, "profile");
  const scratch = path.join(root, "scratch");
  fs.mkdirSync(scratch);
  const isolation = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    isolation,
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
  );
  const env = Object.fromEntries(
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
    args: ["-r", isolation, "--e2e", path.resolve(".")],
    env,
  });
  app.process().stderr?.on("data", (data) => {
    fs.appendFileSync(path.join(root, "electron.log"), data);
  });
  page = await waitForHomeWindow(app);
  const folders = ["styled", "test"].map((name) => path.join(root, name));
  for (const folder of folders) {
    fs.mkdirSync(folder);
  }
  await app.evaluate(({ app: instance }, paths) => {
    const require = process
      .getBuiltinModule("module")
      .createRequire(`${instance.getAppPath()}/package.json`);
    const Database = require("better-sqlite3");
    const database = new Database(
      require("node:path").join(
        instance.getPath("userData"),
        "data/ai-image-manager.db"
      )
    );
    try {
      const insert = database.prepare(
        "INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(?,?,?,0,?,0)"
      );
      for (const [index, folder] of paths.entries()) {
        insert.run(
          index + 1,
          folder,
          index === 0 ? "1 风格化" : "2 测试",
          Date.now()
        );
      }
    } finally {
      database.close();
    }
  }, folders);
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("sidebar_collapsed", "false");
    localStorage.setItem("ui.reduceMotion", "true");
    window.tooltipFocusEvents = [];
    for (const event of ["blur", "focus"]) {
      window.addEventListener(event, () => {
        window.tooltipFocusEvents.push(event);
      });
    }
  });
  await page.reload();
  await expect(page.locator('[data-folder-id="1"]')).toBeVisible();
  mainId = await (await app.browserWindow(page)).evaluate(
    (window) => window.id
  );
  // Playwright otherwise reports a focused document while the native window is inactive.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: false });
});

test.afterAll(async () => {
  await app?.close();
});

for (const size of [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
]) {
  test(`${size.width}x${size.height} dismisses folder tooltips across native window switches`, async () => {
    await app.evaluate(
      ({ BrowserWindow }, requested) => {
        const main = BrowserWindow.fromId(requested.id);
        main?.setSize(requested.width, requested.height);
        main?.focus();
      },
      { id: mainId, ...size }
    );
    const otherReady = app.waitForEvent("window");
    const otherId = await app.evaluate(async ({ BrowserWindow }) => {
      const other = new BrowserWindow({ show: false, width: 240, height: 180 });
      await other.loadURL("about:blank");
      return other.id;
    });
    await otherReady;
    const ids = { main: mainId, other: otherId };
    const folder = page.locator('[data-folder-id="1"]');
    const nextFolder = page.locator('[data-folder-id="2"]');
    const tooltip = page.locator('[data-slot="tooltip-content"]');
    const openFolderTree = async () => {
      if (
        !(await page.locator('[data-surface="sidebar-resources"]').isVisible())
      ) {
        await page
          .getByRole("button", { name: "Expand sidebar", exact: true })
          .click();
      }
      await expect(folder).toBeVisible();
    };
    const moveAway = async () => {
      const width = await page.evaluate(() => window.innerWidth);
      await page.mouse.move(width - 16, 80);
      await expect(tooltip).not.toBeVisible();
    };
    const assertClosedAfterSwitch = async () => {
      await page.evaluate(() => {
        window.tooltipFocusEvents = [];
      });
      await app.evaluate(({ BrowserWindow }, windows) => {
        BrowserWindow.fromId(windows.other)?.show();
        BrowserWindow.fromId(windows.main)?.blur();
        BrowserWindow.fromId(windows.other)?.focus();
      }, ids);
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, windows) => ({
              main: BrowserWindow.fromId(windows.main)?.isFocused(),
              other: BrowserWindow.fromId(windows.other)?.isFocused(),
            }),
            ids
          )
        )
        .toEqual({ main: false, other: true });
      await expect
        .poll(() => page.evaluate(() => document.hasFocus()))
        .toBe(false);
      await expect
        .poll(() => page.evaluate(() => window.tooltipFocusEvents))
        .toContain("blur");
      // Wait beyond the hover delay to catch requests left over from the foreground.
      await page.waitForTimeout(550);
      await expect(tooltip).not.toBeVisible();
      await app.evaluate(({ BrowserWindow }, windows) => {
        BrowserWindow.fromId(windows.other)?.hide();
        BrowserWindow.fromId(windows.main)?.focus();
      }, ids);
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isFocused(),
            mainId
          )
        )
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => document.hasFocus()))
        .toBe(true);
      await expect
        .poll(() => page.evaluate(() => window.tooltipFocusEvents))
        .toContain("focus");
      await page.waitForTimeout(550);
      await expect(tooltip).not.toBeVisible();
    };
    try {
      await openFolderTree();
      await folder.click();
      // Compact windows close the folder drawer on selection; reopen it for hover checks.
      await openFolderTree();
      await folder.focus();
      await expect(folder).toHaveAttribute("aria-selected", "true");
      await assertClosedAfterSwitch();

      await moveAway();
      await folder.hover();
      await assertClosedAfterSwitch();

      await moveAway();
      await folder.hover();
      await expect(tooltip).toBeVisible();
      await assertClosedAfterSwitch();

      await moveAway();
      await folder.hover();
      await expect(tooltip).toBeVisible();
      await app.evaluate(({ BrowserWindow }, id) => {
        BrowserWindow.fromId(id)?.minimize();
      }, mainId);
      await expect
        .poll(() =>
          app.evaluate(
            ({ BrowserWindow }, id) => BrowserWindow.fromId(id)?.isMinimized(),
            mainId
          )
        )
        .toBe(true);
      await expect(tooltip).not.toBeVisible();
      await app.evaluate(({ BrowserWindow }, id) => {
        const main = BrowserWindow.fromId(id);
        main?.restore();
        main?.focus();
      }, mainId);
      await expect
        .poll(() => page.evaluate(() => document.hasFocus()))
        .toBe(true);
      await page.waitForTimeout(550);
      await expect(tooltip).not.toBeVisible();

      await moveAway();
      await folder.press("ArrowDown");
      await expect(nextFolder).toBeFocused();
      await expect(tooltip).toBeVisible();
      await expect(tooltip.getByRole("tooltip")).toHaveText(
        (await nextFolder.getAttribute("aria-label")) ?? ""
      );
      await expect(folder).toHaveAttribute("aria-selected", "true");
      const bounds = await tooltip.boundingBox();
      const viewport = await page.evaluate(() => ({
        width: innerWidth,
        height: innerHeight,
      }));
      expect(bounds).not.toBeNull();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect(bounds?.y).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
        viewport.width + 1
      );
      expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
        viewport.height + 1
      );
      expect(
        await page.evaluate(() =>
          [
            document.documentElement,
            document.body,
            ...document.querySelectorAll("main"),
          ].some((element) => element.scrollWidth > element.clientWidth + 2)
        )
      ).toBe(false);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`tooltip-${size.width}x${size.height}.png`),
      });
      await page.keyboard.press("Escape");
      await expect(tooltip).not.toBeVisible();
    } finally {
      await app.evaluate(({ BrowserWindow }, windows) => {
        BrowserWindow.fromId(windows.other)?.destroy();
        const main = BrowserWindow.fromId(windows.main);
        main?.restore();
        main?.focus();
      }, ids);
    }
  });
}
