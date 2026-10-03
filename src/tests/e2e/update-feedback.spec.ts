import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const CHECK_UPDATE = /检查更新|Check for Updates/;
const FULL_UPDATE = /改用完整包|Use full package/;

test("update feedback remains visible across pages and window sizes", async () => {
  const profile = createTestRuntime("update-feedback");
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && typeof entry[1] === "string"
    )
  );
  const app = await launchTestApp(profile, {
    args: ["--no-sandbox", "--disable-gpu-sandbox", "--e2e", path.resolve(".")],
    env: {
      ...environment,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
    },
  });
  const page = await app.firstWindow();
  await page.locator("main").first().waitFor({ state: "visible" });
  for (const size of [
    { width: 720, height: 480 },
    { width: 900, height: 600 },
    { width: 1280, height: 800 },
  ]) {
    await app.evaluate(
      ({ BrowserWindow }, requested) =>
        BrowserWindow.getAllWindows()[0].setSize(
          requested.width,
          requested.height
        ),
      size
    );
    await page.evaluate(() => window.__e2eNavigate?.("/settings/update"));
    await page.getByRole("button", { name: CHECK_UPDATE }).waitFor();
    for (const phase of [
      "retry-wait",
      "installing",
      "restarting",
      "error",
    ] as const) {
      await page.evaluate(
        (next) =>
          window.postMessage(
            {
              channel: "update:status",
              phase: next,
              operation: next === "error" ? "download" : "install",
              version: "2.2.4",
              attempt: 1,
              maxAttempts: 4,
              retryAfter: new Date(Date.now() + 60_000).toISOString(),
              installStartedAt: new Date().toISOString(),
              message: "NETWORK_ERROR",
              canResume: next === "error",
              canUseFull: next === "error",
            },
            "*"
          ),
        phase
      );
      await page.screenshot({
        path: test.info().outputPath(`received-${size.width}-${phase}.png`),
      });
      await fs.writeFile(
        test.info().outputPath(`dom-${size.width}-${phase}.txt`),
        await page.locator("body").innerText()
      );
      if (phase === "error") {
        const full = page.getByRole("button", {
          name: FULL_UPDATE,
        });
        await full.scrollIntoViewIfNeeded();
        await expect(full).toBeInViewport();
      } else {
        await expect(
          page.locator('[data-sonner-toast] [data-testid="update-progress"]')
        ).toBeVisible();
      }
      expect(
        await page.evaluate(() =>
          [
            document.documentElement,
            document.body,
            ...document.querySelectorAll("main"),
          ].every((element) => element.scrollWidth <= element.clientWidth + 2)
        )
      ).toBe(true);
      const toast = page.locator("[data-sonner-toast]").first();
      await expect(toast).toBeVisible();
      await page.screenshot({
        path: test.info().outputPath(`before-${size.width}-${phase}.png`),
      });
      await fs.writeFile(
        test.info().outputPath(`bounds-${size.width}-${phase}.json`),
        JSON.stringify(
          await page.evaluate(() => ({
            viewport: [innerWidth, innerHeight],
            elements: [
              ...document.querySelectorAll("main, [data-sonner-toast]"),
            ].map((el) => ({
              tag: el.tagName,
              text: el.textContent,
              rect: el.getBoundingClientRect().toJSON(),
              scroll: el.scrollWidth,
              client: el.clientWidth,
            })),
          })),
          null,
          2
        )
      );
      await expect
        .poll(async () =>
          toast.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            return (
              rect.left >= -2 &&
              rect.top >= -2 &&
              rect.right <= innerWidth + 2 &&
              rect.bottom <= innerHeight + 2
            );
          })
        )
        .toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`update-${size.width}-${phase}.png`),
      });
    }
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await page.evaluate(() =>
      window.postMessage(
        { channel: "update:status", phase: "installing", operation: "install" },
        "*"
      )
    );
    await expect(
      page.locator('[data-sonner-toast] [data-testid="update-progress"]')
    ).toBeVisible();
    await page.evaluate(() =>
      window.postMessage({ channel: "update:status", phase: "idle" }, "*")
    );
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
  }
});
