import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import electronPath from "electron";
import { waitForHomeWindow } from "./helpers/home-window";
import { preparePackagedExecutable } from "./helpers/packaged-inspection";
import {
  closeTestApp,
  createTestRuntime,
  launchTestApp,
  test,
} from "./helpers/test-runtime";

const STORAGE_ROUTE = "/settings/storage";
const CONFIRM = /^(确定|Confirm|確認)$/;
const CLEANUP =
  /^(迁移成功后清理旧位置中的图库数据|Remove old library data after successful migration)$/;
const CREATE = "library-directory-create";
const OPEN = "library-directory-open";
const MIGRATE = "library-directory-migrate";
const ACTIONS = "library-directory-actions";
const OCEAN = /ASCII Ocean|字符海洋/;
const TEST_ENTRY = path.resolve(process.env.AIM_DIRECTORY_E2E_ENTRY ?? ".");
const WINDOW_SIZES = [
  { width: 720, height: 480, zoom: 1 },
  { width: 900, height: 600, zoom: 1 },
  { width: 1280, height: 800, zoom: 1 },
  { width: 720, height: 480, zoom: 1.25 },
] as const;

async function resize(
  app: ElectronApplication,
  size: (typeof WINDOW_SIZES)[number]
) {
  await app.evaluate(({ BrowserWindow }, requested) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.unmaximize();
    window.setSize(requested.width, requested.height);
    window.webContents.setZoomFactor(requested.zoom);
  }, size);
}

async function expectInsideViewport(locator: ReturnType<Page["getByRole"]>) {
  await expect
    .poll(() =>
      locator.evaluate((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect();
        return (
          left >= -1 &&
          top >= -1 &&
          right <= innerWidth + 1 &&
          bottom <= innerHeight + 1
        );
      })
    )
    .toBe(true);
}

function readAndMarkLibrary(database: string, marker?: string) {
  return JSON.parse(
    execFileSync(
      electronPath as unknown as string,
      [
        "-e",
        `const Database = require('better-sqlite3');
const db = new Database(process.argv[1], {fileMustExist: true});
try {
  db.pragma('busy_timeout = 5000');
  const photoCount = db.prepare('SELECT COUNT(*) AS count FROM photos').get().count;
  const key = 'e2e.directory.profile';
  const previous = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key)?.value ?? null;
  if (process.argv[2]) db.prepare('INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)').run(key, process.argv[2], Date.now());
  console.log(JSON.stringify({photoCount, previous}));
} finally { db.close(); }`,
        database,
        ...(marker ? [marker] : []),
      ],
      { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
    )
  );
}

function isolationHook(root: string) {
  const hook = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    hook,
    `const {app}=require('electron');
const fs=require('node:fs');const path=require('node:path');
for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',temp:'scratch',logs:'logs',crashDumps:'crashes'})){
const dir=path.join(__dirname,part);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir);}`
  );
  return hook;
}

function appEnv(root: string, overrides: NodeJS.ProcessEnv = {}) {
  return Object.fromEntries(
    Object.entries({
      ...process.env,
      APPDATA: path.join(root, "appdata"),
      LOCALAPPDATA: path.join(root, "local"),
      ELECTRON_RUN_AS_NODE: undefined,
      CI: undefined,
      AI_IMAGE_MANAGER_USER_DATA_DIR: undefined,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: undefined,
      ...overrides,
    }).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string"
    )
  );
}

async function visitStorage(page: Page) {
  await expect
    .poll(() => page.evaluate(() => typeof window.__e2eNavigate))
    .toBe("function");
  await page.evaluate((route) => window.__e2eNavigate?.(route), STORAGE_ROUTE);
  await expect(page.getByTestId(ACTIONS)).toBeEnabled();
}

async function selectDirectory(
  app: ElectronApplication,
  page: Page,
  button: string,
  target: string
) {
  await app.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, target);
  await page.getByTestId(ACTIONS).click();
  await expectInsideViewport(
    page
      .locator('[data-slot="popover-content"]')
      .filter({ has: page.getByTestId(button) })
  );
  await page.getByTestId(button).click();
  const confirmation = page.getByRole("dialog").filter({
    has: page.getByText(target, { exact: true }),
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation.getByText(target, { exact: true })).toBeVisible();
  return confirmation;
}

test("switches libraries in Storage and keeps controls and dialogs inside the window", async () => {
  test.setTimeout(180_000);
  const root = createTestRuntime("library-directory-settings");
  const profile = path.join(root, "profile");
  const empty = path.join(root, "empty");
  const migrated = path.join(root, "migrated");
  const launch = () =>
    launchTestApp(root, {
      args: ["-r", isolationHook(root), "--e2e", TEST_ENTRY],
      env: appEnv(root, { AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile }),
    });
  let app = await launch();
  try {
    const page = await waitForHomeWindow(app);
    await visitStorage(page);
    for (const size of WINDOW_SIZES) {
      await resize(app, size);
      const dialog = await selectDirectory(app, page, MIGRATE, migrated);
      await expect(
        dialog.getByRole("checkbox", { name: CLEANUP })
      ).not.toBeChecked();
      await expectInsideViewport(dialog);
      expect(
        await page.evaluate(() =>
          [
            document.documentElement,
            ...document.querySelectorAll("main"),
          ].every((el) => el.scrollWidth <= el.clientWidth + 2)
        )
      ).toBe(true);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      if (size.width === 900) {
        await page
          .getByTestId(ACTIONS)
          .locator("xpath=ancestor::section[1]")
          .screenshot({
            path: test.info().outputPath("storage-directory.png"),
          });
      }
    }
    const database = (library: string) =>
      path.join(library, "data", "ai-image-manager.db");
    const selectAndConfirm = async (
      action: string,
      target: string,
      clean = false
    ) => {
      const dialog = await selectDirectory(app, page, action, target);
      if (clean) {
        const cleanup = dialog.getByRole("checkbox", { name: CLEANUP });
        await cleanup.locator("..").click();
        await expect(cleanup).toBeChecked();
      }
      await dialog.getByRole("button", { name: CONFIRM }).click();
      await expect
        .poll(
          async () => {
            try {
              const error = dialog.getByRole("alert");
              if (await error.isVisible()) {
                return error.textContent();
              }
              return (await dialog.isVisible())
                ? await dialog.innerText()
                : "closed";
            } catch {
              return "navigating";
            }
          },
          { timeout: 60_000 }
        )
        .toBe("closed");
      await visitStorage(page);
      await expect(
        page.getByTestId("library-directory-current-path")
      ).toHaveText(target);
    };
    await selectAndConfirm(CREATE, empty);
    expect(fs.existsSync(database(profile))).toBe(true);
    expect(fs.existsSync(database(empty))).toBe(true);
    await selectAndConfirm(OPEN, profile);
    await page.evaluate(() => window.__e2eNavigate?.("/settings/plugins"));
    const themeToggle = page.getByRole("checkbox", { name: OCEAN });
    await themeToggle.locator("..").click();
    await expect(themeToggle).toBeChecked();
    await visitStorage(page);
    await selectAndConfirm(MIGRATE, migrated, true);
    expect(fs.existsSync(database(migrated))).toBe(true);
    expect(fs.existsSync(database(profile))).toBe(false);
    await page.evaluate(() => window.__e2eNavigate?.("/settings/plugins"));
    await expect(themeToggle).toBeChecked();
    await themeToggle.locator("..").click();
    await expect(themeToggle).not.toBeChecked();
    await themeToggle.locator("..").click();
    await expect(themeToggle).toBeChecked();

    await closeTestApp(app);
    app = await launch();
    const restarted = await waitForHomeWindow(app);
    await restarted.evaluate(() => window.__e2eNavigate?.("/settings/plugins"));
    await expect(
      restarted.getByRole("checkbox", { name: OCEAN })
    ).toBeChecked();
  } finally {
    await closeTestApp(app);
  }
});

test("keeps the onboarding library picker compact and inside the window", async () => {
  test.setTimeout(90_000);
  const root = createTestRuntime("library-directory-onboarding");
  const app = await launchTestApp(root, {
    args: ["-r", isolationHook(root), "--e2e", TEST_ENTRY],
    env: appEnv(root, {
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: path.join(root, "profile"),
    }),
  });
  try {
    const page = await waitForHomeWindow(app);
    await page.evaluate(() =>
      localStorage.setItem("DEV_FORCE_ONBOARDING", "true")
    );
    await page.reload();
    await expect(page.locator(".onboarding-overlay")).toBeVisible();
    for (const size of WINDOW_SIZES) {
      await resize(app, size);
      await expect(page.getByTestId(ACTIONS)).toBeEnabled();
      const dialog = await selectDirectory(
        app,
        page,
        OPEN,
        path.join(root, "other-library")
      );
      await expectInsideViewport(dialog);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.getByTestId(ACTIONS)).toBeFocused();
      if (size.width === 900) {
        await page.locator(".onboarding-overlay").screenshot({
          path: test.info().outputPath("onboarding-directory.png"),
        });
      }
      expect(
        await page
          .locator(".onboarding-overlay")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 2)
      ).toBe(true);
    }
  } finally {
    await closeTestApp(app);
  }
});

test("starts a fresh development profile alongside a release profile and reuses both", {
  tag: "@packaged-library",
}, async () => {
  test.setTimeout(240_000);
  test.skip(
    !process.env.AIM_PACKAGED_E2E_EXECUTABLE,
    "Requires the new Windows package"
  );
  const root = createTestRuntime("library-directory-isolation");
  fs.mkdirSync(test.info().outputDir, { recursive: true });
  const executablePath = await preparePackagedExecutable(
    root,
    test.info().outputDir
  );
  const checkout = path.join(root, "checkout");
  const development = `${checkout}-dev-data`;
  const release = path.join(root, "release-profile");
  fs.mkdirSync(path.join(checkout, "assets"), { recursive: true });
  fs.copyFileSync(
    path.resolve("assets/icon.ico"),
    path.join(checkout, "assets/icon.ico")
  );
  fs.writeFileSync(
    path.join(checkout, "package.json"),
    JSON.stringify({
      name: "ai-image-manager",
      version: "2.2.10",
      type: "module",
      main: path.resolve(".vite/build/bootstrap.js"),
    })
  );
  const hook = isolationHook(root);
  const launchDevelopment = () =>
    launchTestApp(root, { args: ["-r", hook, checkout], env: appEnv(root) });
  const launchRelease = () =>
    launchTestApp(root, {
      executablePath,
      args: ["--e2e"],
      env: appEnv(root, { AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: release }),
    });
  for (let launch = 0; launch < 2; launch++) {
    const installedApp = await launchRelease();
    try {
      const devApp = await launchDevelopment();
      try {
        for (const [app, profile, packaged] of [
          [devApp, development, false],
          [installedApp, release, true],
        ] as const) {
          if (packaged) {
            await waitForHomeWindow(app);
          } else {
            const page = await app.firstWindow();
            await expect(page.locator(".onboarding-overlay")).toBeVisible();
          }
          expect(
            await app.evaluate(({ app }) => ({
              packaged: app.isPackaged,
              userData: app.getPath("userData"),
              sessionData: app.getPath("sessionData"),
            }))
          ).toEqual({ packaged, userData: profile, sessionData: profile });
          const db = path.join(profile, "data", "ai-image-manager.db");
          await expect.poll(() => fs.existsSync(db)).toBe(true);
          expect(
            readAndMarkLibrary(db, launch === 0 ? profile : undefined)
          ).toEqual({
            photoCount: 0,
            previous: launch === 0 ? null : profile,
          });
        }
      } finally {
        await closeTestApp(devApp);
      }
    } finally {
      await closeTestApp(installedApp);
    }
  }
});
