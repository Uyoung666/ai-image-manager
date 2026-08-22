import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

const WINDOW_SIZES = [
  { height: 480, width: 720 },
  { height: 600, width: 900 },
  { height: 800, width: 1280 },
] as const;

let electronApp: ElectronApplication | undefined;
let page: Page | undefined;
const userDataDir = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-nebula-${process.pid}-${Date.now()}`
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
  await requireApp().evaluate(
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

test("Nebula Glass applies one continuous responsive glass system", async () => {
  const currentPage = requirePage();
  await navigateTo("/settings/plugins");
  await currentPage
    .getByRole("checkbox", { name: "Enable plugin Nebula Glass" })
    .locator("..")
    .click();
  await expect(currentPage.locator("html")).toHaveAttribute(
    "data-nebula-glass",
    "active"
  );
  await expect(
    currentPage.getByText("Material mode", { exact: true })
  ).toBeVisible();
  await currentPage.evaluate(() => {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  });
  await currentPage.waitForTimeout(250);

  for (const size of WINDOW_SIZES) {
    await resizeWindow(size.width, size.height);
    await navigateTo("/settings/plugins");
    await expect(
      currentPage.getByText("Material mode", { exact: true })
    ).toBeVisible();
    expect(
      await currentPage.evaluate(
        () =>
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth
      )
    ).toBeLessThanOrEqual(2);
  }

  for (const size of WINDOW_SIZES) {
    await resizeWindow(size.width, size.height);
    await navigateTo("/");
    const measurement = await currentPage.evaluate(() => {
      const rail = document.querySelector<HTMLElement>(
        '[data-surface="sidebar-rail"]'
      );
      const toolbar = document.querySelector<HTMLElement>(
        ".home-gallery-toolbar-layer"
      );
      const sidebar = document.querySelector<HTMLElement>(
        '.home-workspace-content > [data-surface="sidebar"]'
      );
      const gallery = document.querySelector<HTMLElement>(
        '[data-surface="gallery"]'
      );
      const canvas = document.querySelector<HTMLCanvasElement>(
        ".nebula-glass-fluid-canvas"
      );
      if (!(rail && toolbar && sidebar && gallery && canvas)) {
        throw new Error("Nebula home surfaces are incomplete");
      }
      const sidebarBounds = sidebar.getBoundingClientRect();
      const galleryBounds = gallery.getBoundingClientRect();
      return {
        canvasHeight: canvas.height,
        canvasWidth: canvas.width,
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        galleryRight: galleryBounds.right,
        railBackground: getComputedStyle(rail).backgroundColor,
        sidebarLeft: sidebarBounds.left,
        toolbarBackground: getComputedStyle(toolbar).backgroundColor,
        viewportWidth: window.innerWidth,
      };
    });

    expect(measurement.canvasWidth).toBeGreaterThan(0);
    expect(measurement.canvasHeight).toBeGreaterThan(0);
    expect(measurement.documentOverflow).toBeLessThanOrEqual(2);
    expect(measurement.railBackground).toBe("rgba(0, 0, 0, 0)");
    expect(measurement.toolbarBackground).toBe("rgba(0, 0, 0, 0)");
    expect(measurement.sidebarLeft).toBeGreaterThan(0);
    expect(measurement.galleryRight).toBeLessThan(
      measurement.viewportWidth + 1
    );
    await currentPage.screenshot({
      animations: "disabled",
      path: test
        .info()
        .outputPath(`nebula-dark-${size.width}x${size.height}.png`),
    });
  }

  await currentPage.evaluate(() => {
    document.documentElement.classList.remove("dark");
    document.documentElement.classList.add("light");
  });
  await currentPage.waitForTimeout(250);
  await currentPage.screenshot({
    animations: "disabled",
    path: test.info().outputPath("nebula-light-1280x800.png"),
  });
  await navigateTo("/settings/plugins");
  await currentPage.screenshot({
    animations: "disabled",
    path: test.info().outputPath("nebula-light-plugin-settings-1280x800.png"),
  });
  expect(
    await currentPage.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    )
  ).toBeLessThanOrEqual(2);
  await navigateTo("/settings/appearance");
  await expect(
    currentPage.getByText("Material mode", { exact: true })
  ).toHaveCount(0);
  await currentPage.screenshot({
    animations: "disabled",
    path: test.info().outputPath("nebula-light-appearance-1280x800.png"),
  });
  await currentPage.evaluate(() => {
    document.documentElement.classList.remove("light");
    document.documentElement.classList.add("dark");
  });
  await currentPage.waitForTimeout(250);
  await currentPage.screenshot({
    animations: "disabled",
    path: test.info().outputPath("nebula-dark-appearance-1280x800.png"),
  });

  await navigateTo("/cull/999999999");
  const immersiveCull = currentPage.locator(
    '[data-surface="immersive"][data-immersive-kind="cull"]'
  );
  await expect(immersiveCull).toBeVisible();
  await expect(currentPage.locator("html")).toHaveAttribute(
    "data-nebula-glass",
    "active"
  );
  expect(
    await immersiveCull.evaluate(
      (element) => getComputedStyle(element).backgroundColor
    )
  ).toBe("rgb(0, 0, 0)");

  await navigateTo("/dashboard");
  await expect(currentPage.locator('[data-surface="page"]')).toBeVisible();
  await navigateTo("/");
  await currentPage.keyboard.press("?");
  const dialog = currentPage.locator('[data-surface="overlay"]').last();
  await expect(dialog).toBeVisible();
  const dialogMaterial = await dialog.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backdropFilter: style.backdropFilter,
      borderColor: style.borderColor,
    };
  });
  expect(dialogMaterial.backdropFilter).not.toBe("none");
  expect(dialogMaterial.borderColor).toBe("rgba(0, 0, 0, 0)");
  await currentPage.keyboard.press("Escape");
});
