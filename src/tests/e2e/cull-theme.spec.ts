import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

let electronApp: ElectronApplication | undefined;
let page: Page | undefined;
const WINDOW_SIZES = [
  { height: 480, width: 720 },
  { height: 600, width: 900 },
  { height: 800, width: 1280 },
] as const;
const userDataDir = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-cull-theme-${process.pid}-${Date.now()}`
);

test.setTimeout(120_000);

function requirePage(): Page {
  if (!page) {
    throw new Error("Electron window was not created");
  }
  return page;
}

async function navigateTo(route: string): Promise<void> {
  const currentPage = requirePage();
  await currentPage.evaluate((nextRoute) => {
    if (!window.__e2eNavigate) {
      throw new Error("E2E router bridge is unavailable");
    }
    return window.__e2eNavigate(nextRoute);
  }, route);
  await currentPage.locator("main").first().waitFor({ state: "visible" });
  await currentPage.waitForTimeout(180);
}

async function resizeWindow(width: number, height: number): Promise<void> {
  if (!electronApp) {
    throw new Error("Electron application failed to launch");
  }
  await electronApp.evaluate(
    async ({ BrowserWindow }, requestedSize) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setSize(requestedSize.width, requestedSize.height);
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
    { height, width }
  );
}

test.beforeAll(async () => {
  electronApp = await electron.launch({
    args: [
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--no-sandbox",
      "--use-angle=swiftshader",
      "--e2e",
      `--user-data-dir=${userDataDir}`,
      path.resolve("."),
    ],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: userDataDir,
      CI: "e2e",
    },
    timeout: 30_000,
  });
  page = await electronApp.firstWindow();
  await page.addInitScript(() => window.localStorage.setItem("lang", "en"));
  await page.reload();
  await page.locator("main").first().waitFor({ state: "visible" });
});

test.afterAll(async () => {
  await electronApp?.close();
});

test("keeps curate and duel chrome readable across theme changes", async () => {
  const currentPage = requirePage();
  for (const size of WINDOW_SIZES) {
    await resizeWindow(size.width, size.height);
    await navigateTo("/cull/999999999");

    const immersiveCull = currentPage.locator(
      '[data-surface="immersive"][data-immersive-kind="cull"]'
    );
    await expect(immersiveCull).toBeVisible();
    const windowChrome = currentPage.locator(".cull-window-chrome");
    await expect(windowChrome).toBeVisible();

    const themes = await currentPage.evaluate(() => {
      const root = document.documentElement;
      const immersive = document.querySelector<HTMLElement>(
        '[data-surface="immersive"][data-immersive-kind="cull"]'
      );
      const chrome = document.querySelector<HTMLElement>(".cull-window-chrome");
      if (!immersive) {
        throw new Error("Cull immersive surface is missing");
      }
      if (!chrome) {
        throw new Error("Cull window chrome is missing");
      }

      const samples = ["curate", "duel"].map((mode) => {
        const toolbar = document.createElement("div");
        toolbar.dataset.mode = mode;
        toolbar.className = "bg-background/70 text-foreground border-border";
        immersive.append(toolbar);
        return toolbar;
      });

      const readTheme = (theme: "light" | "dark") => {
        root.classList.remove("light", "dark");
        root.classList.add(theme);
        const immersiveStyle = getComputedStyle(immersive);
        return {
          background: immersiveStyle.backgroundColor,
          colorScheme: immersiveStyle.colorScheme,
          foreground: immersiveStyle.getPropertyValue("--foreground").trim(),
          windowChromeBackground: getComputedStyle(chrome).backgroundColor,
          windowChromeForeground: getComputedStyle(chrome)
            .getPropertyValue("--foreground")
            .trim(),
          toolbarBackground: getComputedStyle(samples[0]).backgroundColor,
          toolbarForeground: getComputedStyle(samples[1]).color,
        };
      };

      const result = {
        dark: readTheme("dark"),
        light: readTheme("light"),
        darkAfterSwitch: readTheme("dark"),
        lightAfterSwitch: readTheme("light"),
      };
      for (const sample of samples) {
        sample.remove();
      }
      return result;
    });

    for (const theme of [
      themes.dark,
      themes.light,
      themes.darkAfterSwitch,
      themes.lightAfterSwitch,
    ]) {
      expect(theme.background).toBe("rgb(0, 0, 0)");
      expect(theme.colorScheme).toBe("dark");
      expect(theme.foreground).toBe("#f1f4f8");
      expect(theme.windowChromeBackground).toBe("rgb(0, 0, 0)");
      expect(theme.windowChromeForeground).toBe("#f1f4f8");
      expect(theme.toolbarBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(theme.toolbarForeground).toBe("rgb(241, 244, 248)");
    }
  }
});
