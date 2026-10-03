import os from "node:os";
import path from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import {
  launchWanderApp,
  seedWanderLibrary,
  setWanderOverrides,
} from "./helpers/wander";

const GALLERY_LABEL = /Parallax gallery/;
const SAVED_LABEL = /Saved as album/;
test.setTimeout(120_000);
let app: ElectronApplication;
test.beforeEach(async () => {
  const directory = path.join(
    os.tmpdir(),
    `ai-image-manager-wander-gallery-${process.pid}-${Date.now()}`
  );
  seedWanderLibrary(directory, { enabled: false, photoCount: 40 });
  app = await launchWanderApp(directory);
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].focus()
  );
  await page.bringToFront();
  await setWanderOverrides(page, { idleMs: 60_000, roundSize: 12 });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Wander", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "Presentation", exact: true })
  ).toHaveValue(GALLERY_LABEL);
  await page.mouse.move(10, 10);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0, {
    timeout: 15_000,
  });
  await page
    .getByRole("checkbox", { name: "Time capsule", exact: true })
    .locator("..")
    .click();
  await page
    .getByRole("checkbox", { name: "Theme screening", exact: true })
    .locator("..")
    .click();
});
test.afterEach(async () => {
  await app?.close();
});

for (const size of [
  { width: 720, height: 480, columns: 2, zoom: 1 },
  { width: 900, height: 600, columns: 3, zoom: 1 },
  { width: 1280, height: 800, columns: 4, zoom: 1 },
  { width: 720, height: 480, columns: 1, zoom: 1.5 },
]) {
  test(`gallery and inspection fit ${size.width}x${size.height} at ${size.zoom} zoom`, async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe("chromium");
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0].setContentSize(
        bounds.width,
        bounds.height
      );
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(bounds.zoom);
    }, size);
    const width = size.width / size.zoom;
    const height = size.height / size.zoom;
    const preview = page.locator("[data-wander-preview='parallax']");
    await preview.scrollIntoViewIfNeeded();
    const previewFrame = preview.getByRole("img");
    const previewBox = await previewFrame.boundingBox();
    expect(previewBox?.width).toBeLessThanOrEqual(360.1);
    expect(previewBox?.x).toBeGreaterThanOrEqual(0);
    expect((previewBox?.x ?? 0) + (previewBox?.width ?? 0)).toBeLessThanOrEqual(
      width
    );
    expect((previewBox?.width ?? 0) / (previewBox?.height ?? 1)).toBeCloseTo(
      16 / 9,
      1
    );
    await page.getByRole("button", { name: "Replay preview" }).click();
    await expect(previewFrame).toHaveAttribute("data-preview-playing", "true");
    await page.getByRole("button", { name: "Pause preview" }).click();
    const previewProgress = await previewFrame.getAttribute("data-progress");
    await page.waitForTimeout(150);
    await expect(previewFrame).toHaveAttribute(
      "data-progress",
      previewProgress as string
    );
    await page.screenshot({
      path: testInfo.outputPath("settings-preview.png"),
    });
    await page
      .getByRole("combobox", { name: "Presentation", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Classic slideshow", exact: true })
      .click();
    const slideshowPreview = page.locator("[data-wander-preview='slideshow']");
    await slideshowPreview.scrollIntoViewIfNeeded();
    await expect(slideshowPreview.locator("[data-preview-slide]")).toHaveCount(
      3
    );
    expect(
      (await slideshowPreview.getByRole("img").boundingBox())?.width
    ).toBeCloseTo(previewBox?.width ?? 0, 0);
    await page
      .getByRole("combobox", { name: "Presentation", exact: true })
      .click();
    await page
      .getByRole("option", { name: "Parallax gallery", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "Flow speed", exact: true })
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Flow speed", exact: true })
      .click();
    const menu = page.getByRole("listbox");
    await expect(menu).toBeVisible();
    const menuBox = await menu.boundingBox();
    expect(menuBox?.x).toBeGreaterThanOrEqual(0);
    expect((menuBox?.y ?? 0) + (menuBox?.height ?? 0)).toBeLessThanOrEqual(
      height + 2
    );
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Start wandering now" }).click();
    const stage = page.locator("[data-wander-parallax]");
    await expect(stage).toHaveAttribute("data-ready", "true");
    await expect(page.locator("[data-wander-column]")).toHaveCount(
      size.columns
    );
    await expect(page.getByRole("progressbar")).toBeVisible();
    const before = await page
      .locator("[data-wander-column]")
      .evaluateAll((columns) =>
        columns.map(
          (column) =>
            new DOMMatrixReadOnly(getComputedStyle(column).transform).m42
        )
      );
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, 250);
    const progress = await page
      .getByRole("progressbar")
      .getAttribute("aria-valuenow");
    await expect(
      page.getByRole("button", { name: "Resume playback" })
    ).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      progress as string
    );
    const transforms = await page
      .locator("[data-wander-column]")
      .evaluateAll((columns) =>
        columns.map((column) => (column as HTMLElement).style.transform)
      );
    expect(new Set(transforms).size).toBe(size.columns);
    const after = await page
      .locator("[data-wander-column]")
      .evaluateAll((columns) =>
        columns.map(
          (column) =>
            new DOMMatrixReadOnly(getComputedStyle(column).transform).m42
        )
      );
    after.forEach((offset, index) => {
      if (index % 2 === 0) {
        expect(offset).toBeLessThan(before[index]);
      } else {
        expect(offset).toBeGreaterThan(before[index]);
      }
    });
    await page.screenshot({
      path: testInfo.outputPath(`gallery-${size.width}.png`),
    });
    // Pick a card by its visible center, avoiding the header/footer controls.
    await page.mouse.click(width / size.columns / 2, height / 2);
    await expect(
      page.getByRole("button", { name: "Back to gallery" })
    ).toBeVisible();
    const inspectedImage = page.getByRole("dialog").last().locator("img");
    await expect(inspectedImage).toBeVisible();
    await expect
      .poll(() =>
        inspectedImage.evaluate(
          (image) =>
            (image as HTMLImageElement).complete &&
            (image as HTMLImageElement).naturalWidth > 0
        )
      )
      .toBe(true);
    await page.screenshot({
      path: testInfo.outputPath(`inspection-${size.width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(stage).toBeVisible();
    await expect(page.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      progress as string
    );
    await page.mouse.move(width / 2, height - 30);
    await page.getByRole("button", { name: "Save round as album" }).click();
    await expect(page.getByText(SAVED_LABEL)).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth
    );
    expect(overflow).toBeLessThanOrEqual(2);
    await page.keyboard.press("Escape");
    await expect(stage).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Start wandering now" })
    ).toBeVisible();
  });
}

test("keeps gallery resources bounded across ten rounds and supports reduced motion", async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe("chromium");
  const page = await app.firstWindow();
  await page.getByRole("button", { name: "Start wandering now" }).click();
  await expect(page.locator("[data-wander-parallax]")).toHaveAttribute(
    "data-ready",
    "true"
  );
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const heaps: number[] = [];
  for (let round = 1; round <= 10; round++) {
    await expect(
      page.getByText(`Round ${round}`, { exact: true }).first()
    ).toBeVisible();
    await expect(page.locator("[data-wander-parallax] img")).toHaveCount(12);
    await expect(page.getByRole("progressbar")).toBeVisible();
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = await cdp.send("Performance.getMetrics");
    heaps.push(
      metrics.find((item) => item.name === "JSHeapUsedSize")?.value ?? 0
    );
    if (round < 10) {
      await page.mouse.move(450, 550);
      await page.getByRole("button", { name: "Next round" }).click();
    }
  }
  expect(heaps[9]).toBeLessThan(heaps[0] + 20 * 1024 * 1024);
  await testInfo.attach("round-heap-sizes", {
    body: JSON.stringify(heaps),
    contentType: "application/json",
  });
  await page.keyboard.press("Escape");
  await expect(page.locator("[data-wander-column]")).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Start wandering now" }).click();
  await expect(
    page.locator("[data-wander-presentation='slideshow']")
  ).toBeVisible();
  await expect(page.locator("[data-wander-parallax]")).toHaveCount(0);
});

test("preserves all photo sources, classic presentation and the independent hamster wheel", async () => {
  const page = await app.firstWindow();
  let previous = "Hidden gems";
  for (const [label, mode] of [
    ["Time capsule", "timeCapsule"],
    ["Theme screening", "theme"],
    ["Hamster wheel", "hamsterWheel"],
  ]) {
    await page
      .getByRole("checkbox", { name: label, exact: true })
      .locator("..")
      .click();
    await page
      .getByRole("checkbox", { name: previous, exact: true })
      .locator("..")
      .click();
    await page.getByRole("button", { name: "Start wandering now" }).click();
    await expect(page.locator(`[data-wander-mode='${mode}']`)).toBeVisible();
    if (mode === "hamsterWheel") {
      await expect(page.locator("[data-wander-parallax]")).toHaveCount(0);
      await expect(page.locator(".wander-hamster-wheel")).toBeVisible();
    }
    await page.keyboard.press("Escape");
    previous = label;
  }
  await page
    .getByRole("checkbox", { name: "Hidden gems", exact: true })
    .locator("..")
    .click();
  await page
    .getByRole("checkbox", { name: previous, exact: true })
    .locator("..")
    .click();
  await page
    .getByRole("combobox", { name: "Presentation", exact: true })
    .click();
  await page
    .getByRole("option", { name: "Classic slideshow", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "Flow speed", exact: true })
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Start wandering now" }).click();
  await expect(
    page.locator("[data-wander-presentation='slideshow']")
  ).toBeVisible();
  await expect(page.locator("[data-wander-parallax]")).toHaveCount(0);
});
