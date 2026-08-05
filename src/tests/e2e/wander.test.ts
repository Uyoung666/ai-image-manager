import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  expect,
  type Page,
  test,
} from "@playwright/test";
import {
  forceWanderEligible,
  launchWanderApp,
  seedWanderLibrary,
  setWanderOverrides,
} from "./helpers/wander";

test.setTimeout(90_000);

function round(page: Page, n: number) {
  return page.getByText(`Round ${n}`).first();
}

const SAVED_AS_ALBUM = /Saved as album/;

test.describe("wander — manual entry", () => {
  let app: ElectronApplication | undefined;
  const userDataDir = path.join(
    os.tmpdir(),
    `ai-image-manager-e2e-wander-manual-${process.pid}`
  );

  function requireApp(): ElectronApplication {
    if (!app) {
      throw new Error("app was not launched");
    }
    return app;
  }

  test.beforeAll(async () => {
    seedWanderLibrary(userDataDir, { enabled: false, photoCount: 14 });
    app = await launchWanderApp(userDataDir);
    app.on("window", (page) => {
      page.on("pageerror", (error) =>
        console.error("pageerror:", error.message)
      );
    });
    const page = await app.firstWindow();
    await setWanderOverrides(page, {
      idleMs: 60_000,
      intervalMs: 2000,
      roundSize: 3,
    });
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("starts wandering and keeps playing through rounds", async () => {
    const page: Page = await requireApp().firstWindow();
    const wanderButton = page.getByRole("button", { name: "Wander" });
    await expect(wanderButton).toBeVisible({ timeout: 15_000 });
    await wanderButton.click();

    await expect(round(page, 1)).toBeVisible({ timeout: 10_000 });
    // A round of three 2s photos (~7.2s incl. the intro card) then the next round.
    await expect(round(page, 2)).toBeVisible({ timeout: 20_000 });

    await page.keyboard.press("Escape");
    await expect(round(page, 1)).not.toBeVisible();
  });

  test("saves the current round as an album and keeps wandering", async () => {
    const page: Page = await requireApp().firstWindow();
    await page.getByRole("button", { name: "Wander" }).click();
    await expect(round(page, 1)).toBeVisible({ timeout: 10_000 });

    // Reveal the auto-hiding controls, then save the current round.
    await page.mouse.move(600, 400);
    await page.getByRole("button", { name: "Save round as album" }).click();

    await expect(page.getByText(SAVED_AS_ALBUM)).toBeVisible({
      timeout: 10_000,
    });
    // The overlay is still mounted after saving.
    await expect(round(page, 1)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(round(page, 1)).not.toBeVisible();
  });

  test("exits wander and restores the gallery context", async () => {
    const page: Page = await requireApp().firstWindow();
    await page.getByRole("button", { name: "Wander" }).click();
    await expect(round(page, 1)).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("Escape");
    await expect(round(page, 1)).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Wander" })).toBeVisible();
  });
});

test.describe("wander — auto idle", () => {
  let app: ElectronApplication | undefined;
  const userDataDir = path.join(
    os.tmpdir(),
    `ai-image-manager-e2e-wander-auto-${process.pid}`
  );

  function requireApp(): ElectronApplication {
    if (!app) {
      throw new Error("app was not launched");
    }
    return app;
  }

  test.beforeAll(async () => {
    seedWanderLibrary(userDataDir, { enabled: true, photoCount: 14 });
    app = await launchWanderApp(userDataDir);
    app.on("window", (page) => {
      page.on("pageerror", (error) =>
        console.error("pageerror:", error.message)
      );
    });
    const page = await app.firstWindow();
    await setWanderOverrides(page, {
      idleMs: 4000,
      intervalMs: 1000,
      roundSize: 3,
    });
    await forceWanderEligible(page);
  });

  test.afterAll(async () => {
    await app?.close();
  });

  test("auto-starts after a short idle period on the home page", async () => {
    const page: Page = await requireApp().firstWindow();
    // No user activity beyond the initial load; the idle window fires on its own.
    await expect(round(page, 1)).toBeVisible({ timeout: 12_000 });
    await page.keyboard.press("Escape");
    await expect(round(page, 1)).not.toBeVisible();
  });

  test("re-timers the full idle delay after blur and refocus", async () => {
    const page: Page = await requireApp().firstWindow();
    await page.keyboard.press("Escape"); // clear any wander left from the prior test

    // While the window is blurred the app is ineligible and must not auto-start.
    await requireApp().evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.blur()
    );
    await page.waitForTimeout(6000);
    await expect(round(page, 1)).not.toBeVisible();

    // Refocusing re-arms the full idle window; a partial wait must not fire.
    await requireApp().evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]?.focus()
    );
    await forceWanderEligible(page);
    await page.waitForTimeout(3000);
    await expect(round(page, 1)).not.toBeVisible();

    await page.waitForTimeout(4000);
    await expect(round(page, 1)).toBeVisible({ timeout: 5000 });
  });
});
