import fs from "node:fs";
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
  "/settings/plugins",
  "/settings/storage",
  "/settings/update",
  "/settings/watermark",
  "/whats-new",
] as const;

const WINDOW_SIZES = [
  { height: 480, width: 720 },
  { height: 600, width: 900 },
  { height: 800, width: 1280 },
] as const;

const OVERFLOW_TOLERANCE_PX = 2;
const LANGUAGE_LABEL_PATTERN = /^(Language|语言)$/;

interface OverflowMeasurement {
  clientWidth: number;
  name: string;
  overflow: number;
  scrollWidth: number;
}

interface HomeToolbarMeasurement {
  actionTop: number;
  formTop: number;
  formWidth: number;
  rowHeight: number;
}

let electronApp: ElectronApplication | undefined;
let page: Page | undefined;

const userDataDir = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-responsive-${process.pid}-${Date.now()}`
);
const referenceImagePath = path.join(
  os.tmpdir(),
  `ai-image-manager-e2e-reference-${process.pid}.png`
);
const REFERENCE_IMAGE_ARIA_PATTERN =
  /Reference image: ai-image-manager-e2e-reference-/;
const REFERENCE_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAwMDAxMDAwMAAAAwBAQDJ/pLvAAAAAElFTkSuQmCC";

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
  const navigatedPath = await currentPage.evaluate((nextRoute) => {
    if (!window.__e2eNavigate) {
      throw new Error("E2E router bridge is unavailable");
    }
    return window.__e2eNavigate(nextRoute);
  }, route);
  expect(navigatedPath).toBe(route.split("?")[0]);
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
  await currentPage.keyboard.press("?");

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

async function expectHomeToolbarToShrinkSearchBeforeWrapping(): Promise<void> {
  const currentPage = requirePage();
  await navigateTo("/");

  const measurement = await currentPage
    .locator(".home-toolbar-primary-row")
    .evaluate((row) => {
      const form = row.querySelector<HTMLElement>(".home-search-form");
      const actions = row.querySelector<HTMLElement>(".home-toolbar-actions");
      if (!(form && actions)) {
        throw new Error("Home toolbar search form or actions are missing");
      }
      const rowBounds = row.getBoundingClientRect();
      const formBounds = form.getBoundingClientRect();
      const actionBounds = actions.getBoundingClientRect();
      return {
        actionTop: actionBounds.top,
        formTop: formBounds.top,
        formWidth: formBounds.width,
        rowHeight: rowBounds.height,
      } satisfies HomeToolbarMeasurement;
    });

  expect(measurement.formWidth).toBeGreaterThanOrEqual(178);
  expect(
    Math.abs(measurement.actionTop - measurement.formTop)
  ).toBeLessThanOrEqual(2);
  expect(measurement.rowHeight).toBeLessThanOrEqual(48);
}

async function expectImageSearchReferenceInsideToolbar(
  width: number
): Promise<void> {
  const currentPage = requirePage();
  await navigateTo("/");
  await currentPage
    .locator('input[type="file"][accept="image/*"]')
    .setInputFiles(referenceImagePath);

  const reference = currentPage.locator(".home-image-search-reference");
  await expect(reference).toBeVisible();
  await expect(reference).toHaveAttribute(
    "aria-label",
    REFERENCE_IMAGE_ARIA_PATTERN
  );

  const fileNameDisplay = await reference
    .locator(".home-image-search-reference-name")
    .evaluate((element) => getComputedStyle(element).display);
  expect(fileNameDisplay === "none").toBe(width <= 760);
  expect(await measureHorizontalOverflow()).toEqual([]);

  await currentPage.getByRole("button", { name: "Clear search" }).click();
  await expect(reference).not.toBeVisible();
}

async function expectLanguageDropdownInsideViewport(): Promise<void> {
  const currentPage = requirePage();
  await navigateTo("/settings/appearance");
  const dropdown = currentPage.getByRole("combobox", { name: "Language" });
  await expect(dropdown).toBeVisible();
  await expect(dropdown).not.toBeDisabled();
  await dropdown.click();

  const popover = currentPage.locator('[data-overlay-kind="select"]').last();
  await expect(popover).toBeVisible();
  const bounds = await popover.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
    };
  });
  expect(bounds.left).toBeGreaterThanOrEqual(-OVERFLOW_TOLERANCE_PX);
  expect(bounds.top).toBeGreaterThanOrEqual(-OVERFLOW_TOLERANCE_PX);
  expect(bounds.right).toBeLessThanOrEqual(
    bounds.viewportWidth + OVERFLOW_TOLERANCE_PX
  );
  expect(bounds.bottom).toBeLessThanOrEqual(
    bounds.viewportHeight + OVERFLOW_TOLERANCE_PX
  );
  await currentPage.keyboard.press("Escape");
  await expect(popover).not.toBeVisible();
}

async function expectUpdateHistoryReturnsToSettings(): Promise<void> {
  const currentPage = requirePage();
  await navigateTo("/settings/update");

  const history = currentPage.locator(".update-changelog-history");
  const scrollContainer = history.locator(
    "xpath=ancestor::div[contains(@class, 'overflow-y-auto')][1]"
  );
  await expect(history).toBeVisible();

  for (const version of ["2.2.0", "2.2.1"]) {
    const entry = currentPage
      .locator(".update-changelog-item")
      .filter({ hasText: `v${version}` });
    await entry.scrollIntoViewIfNeeded();
    const expectedScrollTop = await scrollContainer.evaluate(
      (element) => (element as HTMLElement).scrollTop
    );
    await entry.getByRole("button").click();
    await expect(currentPage.locator(".whats-new-page")).toBeVisible();
    await expect(
      currentPage.locator(".whats-new-release-visual-version")
    ).toHaveText(`v${version}`);

    await currentPage.locator(".whats-new-continue").click();
    await expect(history).toBeVisible();
    await expect
      .poll(() =>
        scrollContainer.evaluate(
          (element) => (element as HTMLElement).scrollTop
        )
      )
      .toBeGreaterThanOrEqual(expectedScrollTop - 2);
    await expect
      .poll(() =>
        scrollContainer.evaluate(
          (element) => (element as HTMLElement).scrollTop
        )
      )
      .toBeLessThanOrEqual(expectedScrollTop + 2);
  }
}

test.beforeAll(async () => {
  await fs.promises.writeFile(
    referenceImagePath,
    Buffer.from(REFERENCE_IMAGE_BASE64, "base64")
  );
  process.env.CI = "e2e";
  electronApp = await electron.launch({
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
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
  await page.addInitScript(() => {
    window.localStorage.setItem("lang", "en");
  });
  await page.reload();
  await page.locator("main").first().waitFor({ state: "visible" });
});

test.afterAll(async () => {
  await electronApp?.close();
  await fs.promises.rm(referenceImagePath, { force: true });
});

for (const { width, height } of WINDOW_SIZES) {
  test(`${width}x${height} keeps release notes clear of the continue button`, async () => {
    const currentPage = requirePage();
    await resizeWindow(width, height);

    for (const language of ["zh", "en"]) {
      await navigateTo("/settings/appearance");
      await currentPage
        .getByRole("combobox", { name: LANGUAGE_LABEL_PATTERN })
        .click();
      await currentPage
        .getByRole("option", {
          name: language === "zh" ? "中文 (zh)" : "English (en)",
          exact: true,
        })
        .click();
      await expect(currentPage.locator("html")).toHaveAttribute(
        "lang",
        language
      );

      for (const version of ["2.2.0", "2.2.1"]) {
        await navigateTo(`/whats-new?version=${version}`);
        await expect(
          currentPage.locator(".whats-new-release-visual-version")
        ).toHaveText(`v${version}`);
        const button = currentPage.locator(".whats-new-continue");
        await expect(button).toHaveText(
          language === "zh" ? "继续使用" : "Continue"
        );
        await button.scrollIntoViewIfNeeded();
        // Wait for transient startup notifications before checking hit testing.
        await button.click({ trial: true });
        const bounds = await button.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const main = document.querySelector(".whats-new-main");
          const highlights = document.querySelector(".whats-new-highlights");
          const footer = document.querySelector(".whats-new-actions");
          if (!(main && highlights && footer)) {
            throw new Error("Release notes layout is missing");
          }
          return {
            contentBottom: Math.max(
              main.getBoundingClientRect().bottom,
              highlights.getBoundingClientRect().bottom
            ),
            footerTop: footer.getBoundingClientRect().top,
            buttonTop: rect.top,
            buttonBottom: rect.bottom,
            viewportHeight: window.innerHeight,
            receivesPointer: element.contains(
              document.elementFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2
              )
            ),
          };
        });
        expect(bounds.contentBottom).toBeLessThanOrEqual(bounds.footerTop + 1);
        expect(bounds.buttonTop).toBeGreaterThanOrEqual(-OVERFLOW_TOLERANCE_PX);
        expect(bounds.buttonBottom).toBeLessThanOrEqual(
          bounds.viewportHeight + OVERFLOW_TOLERANCE_PX
        );
        expect(bounds.receivesPointer).toBe(true);
        expect(await measureHorizontalOverflow()).toEqual([]);
        await currentPage.screenshot({
          path: test.info().outputPath(`release-${version}-${language}.png`),
        });
        await button.click();
        await expect(currentPage.locator(".whats-new-page")).toHaveCount(0);
      }
    }
  });

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

    if (width <= 900) {
      await test.step("home toolbar shrinks search before wrapping", async () => {
        await expectHomeToolbarToShrinkSearchBeforeWrapping();
      });
    }

    await test.step("image-search reference stays responsive", async () => {
      await expectImageSearchReferenceInsideToolbar(width);
    });

    await test.step("language dropdown stays inside the viewport", async () => {
      await expectLanguageDropdownInsideViewport();
    });
  });

  test(`${width}x${height} returns release notes to update settings`, async () => {
    await resizeWindow(width, height);
    await expectUpdateHistoryReturnsToSettings();
    expect(await measureHorizontalOverflow()).toEqual([]);
  });
}
