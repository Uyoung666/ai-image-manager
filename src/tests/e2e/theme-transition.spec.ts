import os from "node:os";
import path from "node:path";
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from "@playwright/test";

interface RevealSample {
  accent: string | undefined;
  clip: string;
  controlX: number;
  controlY: number;
  duration: string;
  easing: string;
  filter: string;
  name: string;
  oldAnimation: string;
  oldTransform: string;
  radius: number;
  theme: string;
  viewportHeight: number;
  viewportWidth: number;
  x: number;
  y: number;
}

declare global {
  interface Window {
    __themeRevealSamples: RevealSample[];
  }
}

let app: ElectronApplication;
let page: Page;
const userDataDir = path.join(
  os.tmpdir(),
  `aim-theme-reveal-${process.pid}-${Date.now()}`
);
const sizes = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];

test.setTimeout(120_000);
test.describe.configure({ mode: "serial" });

async function appearance() {
  await page.evaluate(() => window.__e2eNavigate?.("/settings/appearance"));
  await page.locator(".theme-toggle-switch").waitFor();
  await page.locator(".theme-toggle-switch").scrollIntoViewIfNeeded();
}

test.beforeAll(async () => {
  app = await electron.launch({
    args: [
      "--no-sandbox",
      "--disable-gpu-sandbox",
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
    recordVideo: {
      dir: "test-results/theme-reveal-video",
      size: { width: 1280, height: 800 },
    },
  });
  page = await app.firstWindow();
  await page.addInitScript(() => {
    localStorage.setItem("lang", "en");
    localStorage.setItem("theme", "dark");
    localStorage.setItem("ui.reduceMotion", "false");
  });
  await page.reload();
  await page.locator("main").first().waitFor();
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.evaluate(() => {
    window.__themeRevealSamples = [];
    const nativeStart = document.startViewTransition.bind(document);
    document.startViewTransition = (update: ViewTransitionUpdateCallback) => {
      const rect = document
        .querySelector(".theme-toggle-switch")
        ?.getBoundingClientRect();
      const controlX = rect ? rect.left + rect.width / 2 : 0;
      const controlY = rect ? rect.top + rect.height / 2 : 0;
      const viewportWidth = innerWidth;
      const viewportHeight = innerHeight;
      const transition = nativeStart(update);
      transition.ready
        .then(() => {
          const root = document.documentElement;
          if (root.dataset.themeTransition !== "circle") {
            return;
          }
          const next = getComputedStyle(root, "::view-transition-new(root)");
          const previous = getComputedStyle(
            root,
            "::view-transition-old(root)"
          );
          window.__themeRevealSamples.push({
            accent: root.dataset.accentColor,
            clip: next.clipPath,
            controlX,
            controlY,
            duration: next.animationDuration,
            easing: next.animationTimingFunction,
            filter: next.filter,
            name: next.animationName,
            oldAnimation: previous.animationName,
            oldTransform: previous.transform,
            radius: Number.parseFloat(
              root.style.getPropertyValue("--theme-reveal-radius")
            ),
            theme: root.classList.contains("dark") ? "dark" : "light",
            viewportHeight,
            viewportWidth,
            x: Number.parseFloat(
              root.style.getPropertyValue("--theme-reveal-x")
            ),
            y: Number.parseFloat(
              root.style.getPropertyValue("--theme-reveal-y")
            ),
          });
        })
        .catch(() => undefined);
      return transition;
    };
  });
});

test.afterAll(async () => {
  const video = page?.video();
  await app?.close();
  await video?.saveAs("test-results/theme-reveal-video/theme-reveal.webm");
});

test("reveals both themes from the control across window sizes and zoom", async () => {
  for (const size of sizes) {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    for (const zoom of [1, 1.25]) {
      await app.evaluate(
        ({ BrowserWindow }, factor) =>
          BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor),
        zoom
      );
      await appearance();
      for (const keyboard of [false, true]) {
        const control = page.locator(".theme-toggle-switch");
        const input = page.getByRole("checkbox", {
          name: "Theme",
          exact: true,
        });
        const before = await input.isChecked();
        if (keyboard) {
          await input.focus();
        }
        if (size.width === 1280 && zoom === 1 && keyboard) {
          await page.screenshot({
            path: test.info().outputPath("theme-reveal-before-dark.png"),
          });
        }
        const count = await page.evaluate(
          () => window.__themeRevealSamples.length
        );
        if (keyboard) {
          await input.press("Space");
        } else {
          await control.click();
        }
        await expect
          .poll(() => page.evaluate(() => window.__themeRevealSamples.length))
          .toBe(count + 1);
        const sample = await page.evaluate(() =>
          window.__themeRevealSamples.at(-1)
        );
        if (!sample) {
          throw new Error("Theme snapshot was not captured");
        }
        expect(sample.x).toBeCloseTo(sample.controlX, 1);
        expect(sample.y).toBeCloseTo(sample.controlY, 1);
        expect(sample?.radius).toBeCloseTo(
          Math.hypot(
            Math.max(sample.controlX, sample.viewportWidth - sample.controlX),
            Math.max(sample.controlY, sample.viewportHeight - sample.controlY)
          ),
          1
        );
        expect(sample?.name).toBe("theme-circle-reveal");
        expect(sample?.duration).toBe("0.7s");
        expect(sample?.easing).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
        expect(sample?.filter).toBe("none");
        expect(sample?.oldAnimation).toBe("none");
        expect(sample?.oldTransform).toBe("none");
        expect(sample?.clip).toContain("circle(");
        expect(sample?.theme).toBe(before ? "light" : "dark");
        if (size.width === 1280 && zoom === 1) {
          await page.screenshot({
            path: test.info().outputPath(`theme-reveal-${sample.theme}.png`),
          });
        }
        await expect(input).toBeEnabled();
        if (keyboard) {
          await expect(input).toBeFocused();
        }
        expect(await input.isChecked()).toBe(!before);
        await expect(page.locator("html")).not.toHaveAttribute(
          "data-theme-transition",
          "circle"
        );
        // Wait for the compositor to release the snapshots before recording
        // the next resting frame or changing the window scale.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve())
              );
            })
        );
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth + 2
          )
        ).toBe(true);
      }
    }
  }
});

test("synchronizes accent, cancels on navigation, and restores route styles", async () => {
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1)
  );
  await appearance();
  const input = page.getByRole("checkbox", { name: "Theme", exact: true });
  if (!(await input.isChecked())) {
    await page.locator(".theme-toggle-switch").click();
    await expect(input).toBeEnabled();
  }
  await page
    .getByRole("combobox", { name: "Accent color", exact: true })
    .click();
  await page.getByRole("option", { name: "Gray", exact: true }).click();
  await page.locator(".theme-toggle-switch").click();
  await expect
    .poll(() => page.evaluate(() => window.__themeRevealSamples.at(-1)?.theme))
    .toBe("light");
  expect(
    await page.evaluate(() => window.__themeRevealSamples.at(-1)?.accent)
  ).toBe("default");
  await page.evaluate(() => window.__e2eNavigate?.("/albums"));
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-theme-transition",
    "circle"
  );
  expect(
    await page.evaluate(
      () =>
        getComputedStyle(
          document.documentElement,
          "::view-transition-new(root)"
        ).animationName
    )
  ).toBe("vt-slide-in");
  await appearance();
});

test("switches without snapshots for both reduced motion preferences", async () => {
  for (const source of ["system", "application"]) {
    await appearance();
    await page.emulateMedia({
      reducedMotion: source === "system" ? "reduce" : "no-preference",
    });
    await page.evaluate((value) => {
      document.documentElement.dataset.reducedMotion = String(value);
    }, source === "application");
    const count = await page.evaluate(() => window.__themeRevealSamples.length);
    const input = page.getByRole("checkbox", { name: "Theme", exact: true });
    const before = await input.isChecked();
    await page.locator(".theme-toggle-switch").click();
    await expect(input).toBeEnabled();
    expect(await input.isChecked()).toBe(!before);
    expect(await page.evaluate(() => window.__themeRevealSamples.length)).toBe(
      count
    );
  }
});
