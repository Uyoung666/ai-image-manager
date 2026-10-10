import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect, type Locator, type Page } from "@playwright/test";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const WINDOW_SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const REBUILD_BUTTON = /Rebuild AI Index|重建 AI 索引/;
const REBUILD_DESCRIPTION =
  /The current image analysis is incompatible with your existing AI index\.|当前版本的图片分析方式与现有 AI 索引不兼容/;
const REBUILD_TITLE = /AI index needs rebuilding|AI 索引需要重建/;
const START_BUTTON = /Start AI Indexing|开始 AI 索引/;
const AI_INDEX_HEADING = /^(AI Index|AI 索引)$/;
const MANAGE_BUTTON = /^(AI Index Settings|AI 索引设置)$/;
const OPEN_SETTINGS_BUTTON = /Open AI Index Settings|前往 AI 索引设置/;
const electronPath = createRequire(import.meta.url)("electron") as string;

async function navigate(page: Page, to: string) {
  const route = await page.evaluate((next) => {
    if (!window.__e2eNavigate) {
      throw new Error("E2E router bridge is unavailable");
    }
    return window.__e2eNavigate(next);
  }, to);
  expect(route).toBe(to);
}

async function expectActionInBounds(action: Locator) {
  await action.scrollIntoViewIfNeeded();
  await expect(action).toBeVisible();
  const bounds = await action.evaluate((button) => {
    const rect = button.getBoundingClientRect();
    const main = document.querySelector("main");
    return {
      overflow:
        document.documentElement.scrollWidth > innerWidth + 2 ||
        Boolean(main && main.scrollWidth > main.clientWidth + 2),
      actionVisible:
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight + 1,
    };
  });
  expect(bounds).toEqual({ overflow: false, actionVisible: true });
}

async function expectRebuildNoticeContent(scope: Page | Locator) {
  const notice = scope.getByRole("alert", { name: REBUILD_TITLE });
  await expect(notice).toBeVisible({ timeout: 30_000 });
  await expect(scope.locator("[data-ai-index-rebuild-notice]")).toHaveCount(1);
  await expect(notice).toContainText(
    "The current image analysis is incompatible with your existing AI index, so semantic search and image search are paused."
  );
  await expect(notice).toContainText(
    "Go to Settings → AI Index, click “Rebuild AI Index” and wait for it to finish to restore these searches."
  );
  await expect(notice).toContainText(
    "Your original images, manual tags and favorites are preserved."
  );
  const action = notice.getByRole("button", { name: OPEN_SETTINGS_BUTTON });
  return { action, notice };
}

async function expectRebuildNotice(page: Page) {
  const { action, notice } = await expectRebuildNoticeContent(page);
  await expectActionInBounds(action);
  const bounds = await notice.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const main = element.closest("main");
    const mainRect = main?.getBoundingClientRect();
    return {
      overflow: [
        document.documentElement,
        document.body,
        ...document.querySelectorAll("main"),
      ].some((container) => container.scrollWidth > container.clientWidth + 2),
      horizontalEscape:
        !mainRect ||
        rect.left < Math.max(0, mainRect.left) - 1 ||
        rect.right > Math.min(innerWidth, mainRect.right) + 1,
    };
  });
  expect(bounds).toEqual({ overflow: false, horizontalEscape: false });
  return action;
}

async function expectSpotlightRebuildNotice(page: Page) {
  await page.keyboard.press("Control+k");
  const overlay = page.locator(
    '[data-overlay-kind="command-search"][data-surface="overlay"]'
  );
  await expect(overlay).toBeVisible();
  await expect(overlay.locator("[cmdk-input]")).toHaveValue("");
  // The home toolbar also has this alert. Scope all notice queries to the
  // command panel so the recovery action remains unambiguous.
  const { action, notice } = await expectRebuildNoticeContent(overlay);
  await expectActionInBounds(action);
  const bounds = await overlay.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const noticeRect = element
      .querySelector("[data-ai-index-rebuild-notice]")
      ?.getBoundingClientRect();
    return {
      insideViewport:
        rect.left >= -1 &&
        rect.right <= innerWidth + 1 &&
        rect.top >= 0 &&
        rect.bottom <= innerHeight + 1,
      overflow: [
        element,
        ...element.querySelectorAll(
          "[cmdk-list], [data-ai-index-rebuild-notice]"
        ),
      ].some((container) => container.scrollWidth > container.clientWidth + 2),
      noticeInPanel:
        noticeRect !== undefined &&
        noticeRect.left >= rect.left - 1 &&
        noticeRect.right <= rect.right + 1,
    };
  });
  expect(bounds).toEqual({
    insideViewport: true,
    overflow: false,
    noticeInPanel: true,
  });
  await expect(notice).toBeVisible();
  return { action, overlay };
}

async function expectRebuildSettings(page: Page) {
  await expect(
    page.getByRole("heading", { name: AI_INDEX_HEADING })
  ).toBeVisible();
  const description = page.getByText(REBUILD_DESCRIPTION);
  await expect(description).toBeVisible();
  await expect(description).toContainText(
    "restore semantic search and image search"
  );
  await expect(description).toContainText(
    "Your original images, manual tags and favorites are preserved."
  );
  const rebuild = page.getByRole("button", { name: REBUILD_BUTTON });
  await expect(rebuild).toBeEnabled({ timeout: 30_000 });
  await expectActionInBounds(rebuild);
  const fontSizes = await description.evaluate((element) => {
    const notice = element.closest('[role="status"]');
    const title = notice?.querySelector("p");
    const button = notice?.querySelector("button");
    return {
      description: Number.parseFloat(getComputedStyle(element).fontSize),
      title: title ? Number.parseFloat(getComputedStyle(title).fontSize) : 0,
      action: button ? Number.parseFloat(getComputedStyle(button).fontSize) : 0,
    };
  });
  expect(fontSizes.description).toBeGreaterThanOrEqual(12);
  expect(fontSizes.title).toBeGreaterThanOrEqual(13);
  expect(fontSizes.action).toBeGreaterThanOrEqual(12);
  return rebuild;
}

test("incompatible AI index exposes an explicit rebuild action in every window size", async () => {
  test.setTimeout(180_000);
  const root = createTestRuntime("ai-index-migration");
  const profile = path.join(root, "profile");
  const preload = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    preload,
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
      TEMP: path.join(root, "scratch"),
      TMP: path.join(root, "scratch"),
    }).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );
  const launch = () =>
    launchTestApp(root, {
      args: [
        "-r",
        preload,
        "--e2e",
        "--force-device-scale-factor=1",
        path.resolve("."),
      ],
      env,
    });
  const marker = path.join(profile, "vectors", ".model_fingerprint.json");
  const writeIsolatedDatabase = (sql: string) =>
    execFileSync(
      electronPath,
      [
        "-e",
        "const D=require('better-sqlite3');const d=new D(process.argv[1]);try{d.exec(require('node:fs').readFileSync(0,'utf8'))}finally{d.close()}",
        path.join(profile, "data", "ai-image-manager.db"),
      ],
      {
        env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
        encoding: "utf8",
        input: sql,
      }
    );
  // Build only an empty isolated database, then install a previous-version
  // marker. No user photos or user data participate in this test.
  let app = await launch();
  try {
    const firstPage = await app.firstWindow();
    await firstPage.locator("input.home-search-input").waitFor();
    for (const size of WINDOW_SIZES) {
      await app.evaluate(
        ({ BrowserWindow }, bounds) =>
          BrowserWindow.getAllWindows()[0].setContentSize(
            bounds.width,
            bounds.height
          ),
        size
      );
      await expect
        .poll(() =>
          firstPage.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        )
        .toEqual(size);
      await navigate(firstPage, "/settings/acceleration");
      await expect(
        firstPage.getByRole("button", { name: START_BUTTON })
      ).toHaveCount(0);
      await expect(
        firstPage.getByRole("button", { name: REBUILD_BUTTON })
      ).toHaveCount(0);
      await expect(
        firstPage.getByRole("heading", { name: AI_INDEX_HEADING })
      ).toHaveCount(0);
      await navigate(firstPage, "/dashboard");
      const manage = firstPage.getByRole("button", { name: MANAGE_BUTTON });
      await expectActionInBounds(manage);
      await manage.click();
      await expect(
        firstPage.getByRole("heading", { name: AI_INDEX_HEADING })
      ).toBeVisible();
      const start = firstPage.getByRole("button", { name: START_BUTTON });
      await expectActionInBounds(start);
      await expect(
        firstPage.getByRole("button", { name: REBUILD_BUTTON })
      ).toHaveCount(0);
    }
    await expect
      .poll(() => fs.existsSync(marker), { timeout: 30_000 })
      .toBe(true);
  } finally {
    await app.close();
  }
  // A previously processed isolated photo makes the legacy coverage 100%.
  // That number must not imply the incompatible index is usable.
  const photoPath = path.join(root, "previous-index-fixture.png");
  fs.writeFileSync(
    photoPath,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jMpcAAAAASUVORK5CYII=",
      "base64"
    )
  );
  writeIsolatedDatabase(
    `INSERT INTO photos(id,path,filename,file_size,width,height,format,thumbnail_path,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(1,'${photoPath.replaceAll("'", "''")}','previous-index-fixture.png',64,1,1,'png','${photoPath.replaceAll("'", "''")}',1,1,1,1)`
  );
  const previousMarker = {
    adapterId: "previous-image-preprocessing",
    buildState: "ready",
    createdAt: new Date().toISOString(),
    dimensions: 768,
    fingerprint: "e".repeat(64),
    schemaVersion: 1,
    source: "fresh-build",
  };
  fs.writeFileSync(marker, JSON.stringify(previousMarker));
  app = await launch();
  try {
    const page = await app.firstWindow();
    await page.addInitScript(() => localStorage.setItem("lang", "en"));
    await page.reload();
    await page.locator("input.home-search-input").waitFor();
    for (const size of WINDOW_SIZES) {
      await app.evaluate(
        ({ BrowserWindow }, bounds) =>
          BrowserWindow.getAllWindows()[0].setContentSize(
            bounds.width,
            bounds.height
          ),
        size
      );
      await expect
        .poll(() =>
          page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        )
        .toEqual(size);
      await navigate(page, "/");
      const search = page.locator("input.home-search-input");
      await expect(search).toHaveValue("");
      await expect(search).toHaveAttribute(
        "placeholder",
        "AI index needs rebuilding. Open AI Index Settings."
      );
      const homeAction = await expectRebuildNotice(page);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`index-migration-home-${size.width}x${size.height}.png`),
      });
      await homeAction.click();
      await expectRebuildSettings(page);

      await navigate(page, "/");
      const spotlight = await expectSpotlightRebuildNotice(page);
      await page.screenshot({
        path: test
          .info()
          .outputPath(
            `index-migration-spotlight-${size.width}x${size.height}.png`
          ),
      });
      await spotlight.action.focus();
      await expect(spotlight.action).toBeFocused();
      await spotlight.action.press("Enter");
      await expect(spotlight.overlay).toHaveCount(0);
      await expectRebuildSettings(page);

      await navigate(page, "/dashboard");
      const dashboardAction = await expectRebuildNotice(page);
      const coverage = page.locator("[data-ai-index-coverage]");
      await expect(coverage).toContainText(REBUILD_TITLE);
      await expect(coverage).not.toContainText("100%");
      await page.screenshot({
        path: test
          .info()
          .outputPath(
            `index-migration-dashboard-${size.width}x${size.height}.png`
          ),
      });
      await dashboardAction.click();
      await expectRebuildSettings(page);
      // Polling and merely viewing the warning must never reset an old index.
      expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(
        previousMarker
      );
      await page.screenshot({
        path: test
          .info()
          .outputPath(`index-migration-${size.width}x${size.height}.png`),
      });
    }
  } finally {
    await app.close();
  }
  // Exercise the explicitly requested reset on an empty isolated library so
  // this UI regression test never downloads a model or starts photo workers.
  writeIsolatedDatabase("DELETE FROM photos WHERE id = 1");
  app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator("input.home-search-input").waitFor();
    await navigate(page, "/settings/ai-index");
    const rebuild = await expectRebuildSettings(page);
    expect(JSON.parse(fs.readFileSync(marker, "utf8"))).toEqual(previousMarker);
    // Simulate an unrecoverable cleanup on this isolated runtime only. The
    // renderer must keep the error even when its next poll opens an empty DB.
    await app.evaluate(
      (_electron, vectorPath) => {
        const promises = (
          process.getBuiltinModule("fs") as typeof import("node:fs")
        ).promises;
        const remove = promises.rm;
        const rename = promises.rename;
        promises.rm = async (target, options) => {
          if (String(target) === vectorPath) {
            await new Promise((resolve) => setTimeout(resolve, 750));
            throw Object.assign(new Error("isolated test directory lock"), {
              code: "ENOTEMPTY",
            });
          }
          return remove(target, options);
        };
        promises.rename = (source, destination) => {
          if (String(source) === vectorPath) {
            promises.rm = remove;
            promises.rename = rename;
            return Promise.reject(new Error("isolated test rename denied"));
          }
          return rename(source, destination);
        };
      },
      path.join(profile, "vectors")
    );
    await rebuild.click();
    const preparing = page.getByRole("status").filter({
      hasText: "Preparing the indexing task.",
    });
    await expect(preparing).toHaveAttribute("aria-busy", "true");
    await expect(
      preparing.getByRole("button", { name: "Rebuilding index..." })
    ).toBeDisabled();
    const failure = page.getByRole("alert").filter({
      hasText: "AI index rebuilding could not start.",
    });
    await expect(failure).toBeVisible();
    await expect(failure).toContainText(
      "You do not need to import your photos again."
    );
    // The failed attempt removed the photo table; polling creates an empty
    // compatible table. That transition previously hid the failed action.
    await expect
      .poll(() => JSON.parse(fs.readFileSync(marker, "utf8")).fingerprint)
      .not.toBe(previousMarker.fingerprint);
    for (const size of WINDOW_SIZES) {
      await app.evaluate(
        ({ BrowserWindow }, bounds) =>
          BrowserWindow.getAllWindows()[0].setContentSize(
            bounds.width,
            bounds.height
          ),
        size
      );
      await expect
        .poll(() =>
          page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
        )
        .toEqual(size);
      await expect(failure).toBeVisible();
      await expectActionInBounds(
        failure.getByRole("button", { name: REBUILD_BUTTON })
      );
      await page.screenshot({
        path: test
          .info()
          .outputPath(`index-rebuild-failure-${size.width}x${size.height}.png`),
      });
    }
    await failure.getByRole("button", { name: REBUILD_BUTTON }).click();
    await expect
      .poll(
        () => {
          if (!fs.existsSync(marker)) {
            return false;
          }
          const current = JSON.parse(fs.readFileSync(marker, "utf8"));
          return (
            current.fingerprint !== previousMarker.fingerprint &&
            current.buildState === "ready"
          );
        },
        { timeout: 30_000 }
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: REBUILD_BUTTON })
    ).toHaveCount(0);
    await navigate(page, "/");
    await expect(page.locator("[data-ai-index-rebuild-notice]")).toHaveCount(0);
    await expect(page.locator("input.home-search-input")).not.toHaveAttribute(
      "placeholder",
      "AI index needs rebuilding. Open AI Index Settings."
    );
    await navigate(page, "/dashboard");
    await expect(page.locator("[data-ai-index-rebuild-notice]")).toHaveCount(0);
    expect(fs.existsSync(photoPath)).toBe(true);
  } finally {
    await app.close();
  }
});
