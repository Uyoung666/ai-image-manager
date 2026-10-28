import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const LAST_HISTORY = /^History 59/;
const HISTORY_QUERY = /^History/;
const sizes = [
  { width: 720, height: 480, zoom: 1 },
  { width: 900, height: 600, zoom: 1 },
  { width: 1280, height: 800, zoom: 1 },
  { width: 720, height: 480, zoom: 1.25 },
];
test("mixed history, persisted preferences, keyboard scrolling and responsive boundaries", async ({
  runtimeDiagnostics: _runtimeDiagnostics,
}, testInfo) => {
  test.setTimeout(180_000);
  const root = createTestRuntime("search-history");
  const profile = path.join(root, "profile");
  const preload = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    preload,
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
  );
  const imagePath = path.join(root, "reference.png");
  fs.copyFileSync(path.resolve("assets/icons/icon-64.png"), imagePath);
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
  const options = { args: ["-r", preload, "--e2e", path.resolve(".")], env };
  const app = await launchTestApp(root, options);
  try {
    const page = await waitForHomeWindow(app);
    await page.addInitScript(() => {
      localStorage.setItem("lang", "en");
      const send = MessagePort.prototype.postMessage;
      // Only the AI result is simulated. Source validation, previews and settings use real IPC.
      MessagePort.prototype.postMessage = function (message, transfer) {
        const request =
          typeof message === "string" ? JSON.parse(message) : message;
        if (request?.p?.u?.includes("searchByImage")) {
          queueMicrotask(() =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: {
                  i: request.i,
                  p: { b: { json: { results: [], errorCode: "NO_MATCHES" } } },
                },
              })
            )
          );
          return;
        }
        if (Array.isArray(transfer)) {
          send.call(this, message, { transfer });
        } else {
          send.call(this, message, transfer ?? {});
        }
      };
    });
    await page.reload();
    await page.locator("input.home-search-input").waitFor();
    const navigate = async (route: string) => {
      await page.evaluate((next) => window.__e2eNavigate?.(next), route);
    };
    const capture = async (name: string) => {
      // Electron zoom changes CSS coordinates; capture the full native surface.
      await page.evaluate(async () => {
        await Promise.all(
          document
            .getAnimations()
            .filter(
              (animation) =>
                animation.effect?.getComputedTiming().iterations !==
                Number.POSITIVE_INFINITY
            )
            .map((animation) => animation.finished.catch(() => undefined))
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
      });
      const png = await app.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((window) =>
          window.isVisible()
        );
        if (!win) {
          throw new Error("Window missing");
        }
        return (await win.webContents.capturePage()).toPNG().toString("base64");
      });
      fs.writeFileSync(testInfo.outputPath(name), Buffer.from(png, "base64"));
    };
    await navigate("/settings/appearance");
    const limit = page.getByRole("combobox", { name: "Search history limit" });
    await expect(limit).toBeEnabled();
    await expect(limit).toHaveValue("Last 5 searches");
    // A legacy profile without a saved preference retains its old twenty-entry policy.
    await page.evaluate(() => {
      localStorage.removeItem("search_history_v2");
      localStorage.removeItem("search.history.preferences");
      localStorage.setItem(
        "search_history",
        JSON.stringify(Array.from({ length: 12 }, (_, i) => `Legacy ${i}`))
      );
    });
    await page.reload();
    await page.locator("input.home-search-input").waitFor();
    await navigate("/settings/appearance");
    await expect(limit).toHaveValue("Last 20 searches");
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("search_history_v2") ?? "{}").entries
            .length
      )
    ).toBe(12);
    await limit.click();
    await page
      .getByRole("option", { name: "Last 100 searches", exact: true })
      .click();
    await expect(limit).toHaveValue("Last 100 searches");
    await page.evaluate((source) => {
      localStorage.setItem(
        "search_history_v2",
        JSON.stringify({
          version: 2,
          entries: [
            { kind: "image", imagePath: source, lastUsedAt: 100 },
            ...Array.from({ length: 60 }, (_, i) => ({
              kind: "text",
              query: `History ${String(i).padStart(2, "0")} with a very long search description that should truncate safely across narrow windows`,
              lastUsedAt: 99 - i,
            })),
          ],
        })
      );
      window.dispatchEvent(new Event("search-history-changed"));
    }, imagePath);
    const checkBounds = async () => {
      const issues = await page.evaluate(() => {
        const nodes = [
          document.documentElement,
          ...document.querySelectorAll(
            "main, [data-overlay-kind='search-suggestions'], [data-slot='popover-content'], [role='alertdialog']"
          ),
        ];
        return nodes.flatMap((node) => {
          const el = node as HTMLElement;
          const b = el.getBoundingClientRect();
          if (b.width === 0 || b.height === 0) {
            return [];
          }
          const overflow = el.scrollWidth - el.clientWidth;
          return overflow > 2 ||
            b.left < -2 ||
            b.right > innerWidth + 2 ||
            b.top < -2 ||
            b.bottom > innerHeight + 2
            ? [
                {
                  name: el.tagName,
                  overflow,
                  left: b.left,
                  right: b.right,
                  top: b.top,
                  bottom: b.bottom,
                  viewport: [innerWidth, innerHeight],
                },
              ]
            : [];
        });
      });
      expect(issues).toEqual([]);
    };
    for (const size of sizes) {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        const win = BrowserWindow.getAllWindows().find(
          (w) => !w.isDestroyed() && w.isVisible()
        );
        if (!win) {
          throw new Error("Window missing");
        }
        win.webContents.setZoomFactor(1);
        win.setContentSize(bounds.width, bounds.height);
        win.webContents.setZoomFactor(bounds.zoom);
        win.focus();
      }, size);
      await expect
        .poll(() => page.evaluate(() => innerWidth))
        .toBe(Math.round(size.width / size.zoom));
      await navigate("/settings/appearance");
      await expect(limit).toHaveValue("Last 100 searches");
      await limit.scrollIntoViewIfNeeded();
      await limit.click();
      await expect(
        page.getByRole("option", { name: "Last 100 searches", exact: true })
      ).toBeVisible();
      await checkBounds();
      await page.keyboard.press("Escape");
      await limit.click();
      await page
        .getByRole("option", { name: "Last 5 searches", exact: true })
        .click();
      await expect(page.getByRole("alertdialog")).toBeVisible();
      await checkBounds();
      await capture(`history-reduction-${size.width}-${size.zoom}.png`);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(limit).toHaveValue("Last 100 searches");
      const toggle = page.getByRole("checkbox", {
        name: "Search history",
        exact: true,
      });
      await toggle.locator("..").click();
      await expect(toggle).not.toBeChecked();
      await expect(toggle).toBeEnabled();
      const saved = await page.evaluate(() =>
        localStorage.getItem("search_history_v2")
      );
      await navigate("/");
      const pausedInput = page.locator("input.home-search-input");
      await pausedInput.fill("");
      await pausedInput.click();
      await expect(
        page.getByText("Search history is off", { exact: true })
      ).toBeVisible();
      await expect(page.locator("[data-search-history]")).toHaveCount(0);
      const status = page.locator(
        "[data-search-suggestions-footer] [data-search-history-status]"
      );
      await expect(status).toHaveText("Search history is off");
      await status.scrollIntoViewIfNeeded();
      await checkBounds();
      await capture(`history-disabled-${size.width}-${size.zoom}.png`);
      await pausedInput.fill("History private search");
      await expect(
        page.getByRole("option", { name: HISTORY_QUERY })
      ).toHaveCount(0);
      await pausedInput.press("Enter");
      await page
        .getByRole("button", { name: "Clear search", exact: true })
        .click();
      expect(
        await page.evaluate(() => localStorage.getItem("search_history_v2"))
      ).toBe(saved);
      await navigate("/settings/appearance");
      await toggle.locator("..").click();
      await expect(toggle).toBeChecked();
      await expect(toggle).toBeEnabled();
      await navigate("/");
      const input = page.locator("input.home-search-input");
      await input.click();
      const panel = page.locator("[data-overlay-kind='search-suggestions']");
      await expect(panel).toBeVisible();
      const scroll = panel.locator("[data-search-history-scroll]");
      expect(
        await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)
      ).toBe(true);
      await scroll.evaluate((el) => {
        el.scrollTop = 0;
      });
      await expect(scroll).toHaveAttribute("data-top-fade", "false");
      await expect(scroll).toHaveAttribute("data-bottom-fade", "true");
      expect(
        await scroll.evaluate((el) => getComputedStyle(el).maskImage)
      ).toContain("linear-gradient(");
      expect(
        await scroll.evaluate((el) =>
          getComputedStyle(el)
            .getPropertyValue("--search-fade-direction")
            .trim()
        )
      ).toBe("to bottom");
      await scroll.evaluate((el) => {
        el.scrollTop = (el.scrollHeight - el.clientHeight) / 2;
      });
      await expect(scroll).toHaveAttribute("data-top-fade", "true");
      await expect(scroll).toHaveAttribute("data-bottom-fade", "true");
      await scroll.scrollIntoViewIfNeeded();
      await capture(`history-middle-${size.width}-${size.zoom}.png`);
      const last = panel.getByRole("option", { name: LAST_HISTORY });
      await last.focus();
      await page.keyboard.press("ArrowUp");
      await page.keyboard.press("ArrowDown");
      await expect(last).toBeFocused();
      expect(await scroll.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
      await expect(scroll).toHaveAttribute("data-top-fade", "true");
      await expect(scroll).toHaveAttribute("data-bottom-fade", "false");
      await checkBounds();
      await capture(`history-${size.width}-${size.zoom}.png`);
      await page.keyboard.press("Delete");
      await expect(
        panel.getByRole("option", { name: LAST_HISTORY })
      ).toHaveCount(0);
      // Restore that row for the next viewport without changing settings.
      await page.evaluate(() => {
        const data = JSON.parse(
          localStorage.getItem("search_history_v2") ?? "{}"
        );
        data.entries.push({
          kind: "text",
          query:
            "History 59 with a very long search description that should truncate safely across narrow windows",
          lastUsedAt: 40,
        });
        localStorage.setItem("search_history_v2", JSON.stringify(data));
        window.dispatchEvent(new Event("search-history-changed"));
      });
      await page.keyboard.press("Escape");
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()
        .find((win) => win.isVisible())
        ?.webContents.setZoomFactor(1)
    );
    await navigate("/");
    const input = page.locator("input.home-search-input");
    await input.click();
    const reference = page.getByRole("option", {
      name: "Image search: reference.png",
      exact: true,
    });
    await reference.scrollIntoViewIfNeeded();
    await expect(reference.locator("img")).toBeVisible();
    await reference.click();
    await expect(page.locator(".home-image-search-reference")).toBeVisible();
    await page
      .getByRole("button", { name: "Clear search", exact: true })
      .click();
    await input.click();
    fs.unlinkSync(imagePath);
    await page
      .getByRole("option", { name: "Image search: reference.png", exact: true })
      .click();
    await expect(
      page.getByText(
        "The reference image was moved or deleted. Image search was cleared.",
        { exact: false }
      )
    ).toBeVisible();
    await navigate("/settings/appearance");
    const toggle = page.getByRole("checkbox", {
      name: "Search history",
      exact: true,
    });
    await expect(toggle).toBeEnabled();
    await toggle.locator("..").click();
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    await page.reload();
    await page.locator("input.home-search-input").waitFor();
    await page.locator("input.home-search-input").click();
    await expect(
      page.getByText("Search history is off", { exact: true })
    ).toBeVisible();
    await expect(page.locator("[data-search-history]")).toHaveCount(0);
    await navigate("/settings/appearance");
    await expect(
      page.getByRole("checkbox", { name: "Search history", exact: true })
    ).not.toBeChecked();
    await expect(limit).toHaveValue("Last 100 searches");
  } finally {
    await app.close();
  }
  const restarted = await launchTestApp(root, options);
  try {
    const page = await waitForHomeWindow(restarted);
    await page.locator("input.home-search-input").click();
    await expect(
      page.getByText("Search history is off", { exact: true })
    ).toBeVisible();
    await expect(page.locator("[data-search-history]")).toHaveCount(0);
    await page.evaluate(() => window.__e2eNavigate?.("/settings/appearance"));
    await expect(
      page.getByRole("checkbox", { name: "Search history", exact: true })
    ).not.toBeChecked();
    await expect(
      page.getByRole("combobox", { name: "Search history limit" })
    ).toHaveValue("Last 100 searches");
    await page
      .getByRole("button", { name: "Clear search history", exact: true })
      .click();
    expect(
      await page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("search_history_v2") ?? "{}").entries
      )
    ).toEqual([]);
    const toggle = page.getByRole("checkbox", {
      name: "Search history",
      exact: true,
    });
    await toggle.locator("..").click();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await page.evaluate(() => window.__e2eNavigate?.("/"));
    await page.locator("input.home-search-input").click();
    await expect(
      page.getByText("Search history is off", { exact: true })
    ).toHaveCount(0);
    await expect(page.locator("[data-search-history]")).toHaveCount(0);
  } finally {
    await restarted.close();
  }
});
