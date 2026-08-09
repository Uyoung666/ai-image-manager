import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const ROUTES = [
  "/",
  "/albums",
  "/duplicates",
  "/trash",
  "/people",
  "/dashboard",
  "/cull",
  "/settings/appearance",
  "/settings/storage",
  "/settings/watermark",
  "/whats-new",
] as const;

const WINDOW_SIZES = [
  { height: 480, width: 720 },
  { height: 600, width: 900 },
  { height: 800, width: 1280 },
] as const;

const OVERFLOW_TOLERANCE_PX = 2;

interface OverflowMeasurement {
  clientWidth: number;
  name: string;
  overflow: number;
  scrollWidth: number;
}

let electronApp: ElectronApplication | undefined;
let page: Page | undefined;

const userDataDir = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-responsive-${process.pid}-${Date.now()}`
);

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

function requireApp(): ElectronApplication {
  if (!electronApp) {
    throw new Error("Electron application failed to launch");
  }
  return electronApp;
}

function requirePage(): Page {
  if (!page) {
    throw new Error("Electron window was not created");
  }
  return page;
}

async function resizeWindow(width: number, height: number): Promise<void> {
  const contentBounds = await requireApp().evaluate(
    async ({ BrowserWindow }, requestedSize) => {
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) {
        throw new Error("Main BrowserWindow was not found");
      }

      window.setSize(requestedSize.width, requestedSize.height);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return window.getContentBounds();
    },
    { height, width }
  );

  await expect
    .poll(() => {
      const currentPage = requirePage();
      return currentPage.evaluate(() => ({
        height: window.innerHeight,
        width: window.innerWidth,
      }));
    })
    .toEqual({ height: contentBounds.height, width: contentBounds.width });
}

async function navigateTo(route: string): Promise<void> {
  const currentPage = requirePage();
  await currentPage.evaluate((nextRoute) => {
    window.history.pushState({}, "", nextRoute);
    window.dispatchEvent(
      new PopStateEvent("popstate", { state: window.history.state })
    );
  }, route);

  await currentPage.waitForFunction(
    (expectedPath) => window.location.pathname === expectedPath,
    route
  );
  await currentPage.locator("main").first().waitFor({ state: "visible" });
  await currentPage.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
  await currentPage.waitForTimeout(250);
}

function measureHorizontalOverflow(): Promise<OverflowMeasurement[]> {
  return requirePage().evaluate((tolerance) => {
    const measurements: OverflowMeasurement[] = [];
    const addMeasurement = (name: string, element: Element) => {
      const target = element as HTMLElement;
      const overflow = target.scrollWidth - target.clientWidth;
      if (overflow > tolerance) {
        measurements.push({
          clientWidth: target.clientWidth,
          name,
          overflow,
          scrollWidth: target.scrollWidth,
        });
      }
    };

    addMeasurement("documentElement", document.documentElement);
    addMeasurement("body", document.body);
    for (const [index, main] of [
      ...document.querySelectorAll("main"),
    ].entries()) {
      if (main.getClientRects().length > 0) {
        addMeasurement(`main[${index}]`, main);
      }
    }

    return measurements;
  }, OVERFLOW_TOLERANCE_PX);
}

async function expectShortcutDialogInsideViewport(): Promise<void> {
  const currentPage = requirePage();
  await navigateTo("/");
  await currentPage.locator("body").press("Shift+/");

  const dialog = currentPage.locator('[data-slot="dialog-content"]').last();
  await expect(dialog).toBeVisible();

  const bounds = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      height: rect.height,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      width: rect.width,
    };
  });

  expect(bounds.width).toBeGreaterThan(0);
  expect(bounds.height).toBeGreaterThan(0);
  expect(bounds.left).toBeGreaterThanOrEqual(-OVERFLOW_TOLERANCE_PX);
  expect(bounds.top).toBeGreaterThanOrEqual(-OVERFLOW_TOLERANCE_PX);
  expect(bounds.right).toBeLessThanOrEqual(
    bounds.viewportWidth + OVERFLOW_TOLERANCE_PX
  );
  expect(bounds.bottom).toBeLessThanOrEqual(
    bounds.viewportHeight + OVERFLOW_TOLERANCE_PX
  );

  await currentPage.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
}

test.beforeAll(async () => {
  process.env.CI = "e2e";
  electronApp = await electron.launch({
    args: [
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
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
  await page.addInitScript(() => {
    window.localStorage.setItem("lang", "en");
  });
  await page.reload();
  await page.locator("main").first().waitFor({ state: "visible" });
});

test.afterAll(async () => {
  await electronApp?.close();
});

for (const { width, height } of WINDOW_SIZES) {
  test(`${width}x${height} keeps primary routes within the viewport`, async () => {
    await resizeWindow(width, height);

    for (const route of ROUTES) {
      await test.step(route, async () => {
        await navigateTo(route);
        const overflow = await measureHorizontalOverflow();
        expect(
          overflow,
          `${route} has unexpected horizontal overflow at ${width}x${height}`
        ).toEqual([]);
      });
    }

    if (width === 720 && height === 480) {
      await test.step("global shortcuts dialog", async () => {
        await expectShortcutDialogInsideViewport();
      });
    }
  });
}
