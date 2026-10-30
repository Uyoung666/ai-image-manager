import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

declare global {
  interface Window {
    starterLayoutGate: { held: number; release: () => void };
  }
}

test("search starter skeletons, cached rotation and responsive overlay geometry", async () => {
  test.setTimeout(150_000);
  const root = createTestRuntime("search-starters");
  const profile = path.join(root, "profile");
  const preload = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    preload,
    "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
  );
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
  const app = await launchTestApp(root, {
    args: ["-r", preload, "--e2e", path.resolve(".")],
    env,
  });
  try {
    const page = await waitForHomeWindow(app);
    const thumbnailResponses: Array<{ id: string | null; status: number }> = [];
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (url.pathname === "/photo-thumbnail") {
        thumbnailResponses.push({
          id: url.searchParams.get("id"),
          status: response.status(),
        });
      }
    });
    const fixtureDir = path.join(root, "photos");
    fs.mkdirSync(fixtureDir);
    const fixturePaths = Array.from({ length: 12 }, (_, index) => {
      const file = path.join(fixtureDir, `${index + 1}.webp`);
      fs.copyFileSync(
        path.resolve(`src/assets/about/0${(index % 5) + 1}.webp`),
        file
      );
      return file;
    });
    await app.evaluate(({ app: instance }, files) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(`${instance.getAppPath()}/package.json`);
      const Database = require("better-sqlite3");
      const database = new Database(
        require("node:path").join(
          instance.getPath("userData"),
          "data/ai-image-manager.db"
        )
      );
      try {
        const insert = database.prepare(
          "INSERT INTO photos(id,folder_id,path,filename,width,height,format,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(?,1,?,?,?,?,'webp',1,1,1,?)"
        );
        database
          .prepare(
            "INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(1,?,'Gallery fixture',12,?,0)"
          )
          .run(require("node:path").dirname(files[0]), Date.now());
        const exif = database.prepare(
          "INSERT INTO exif_data(photo_id,date_taken,camera_model) VALUES(?,?,'Canon')"
        );
        const tagIds = ["Beach", "Forest"].map((name) => {
          database
            .prepare("INSERT OR IGNORE INTO tags(name,created_at) VALUES(?,?)")
            .run(name, Date.now());
          return database
            .prepare("SELECT id FROM tags WHERE name = ?")
            .get(name).id;
        });
        for (const [index, file] of files.entries()) {
          insert.run(
            index + 1,
            file,
            `${index + 1}.webp`,
            1086,
            1448,
            Date.now()
          );
          exif.run(index + 1, new Date(2023, 1, 12).getTime());
          database
            .prepare(
              "INSERT INTO photo_tags(photo_id,tag_id,origin) VALUES(?,?,'manual')"
            )
            .run(index + 1, tagIds[index < 6 ? 0 : 1]);
        }
      } catch (error) {
        throw new Error(`Gallery fixture: ${String(error)}`);
      } finally {
        database.close();
      }
    }, fixturePaths);
    await page.addInitScript(() => {
      const metadataMode = localStorage.getItem("starter-use-metadata") === "1";
      localStorage.setItem("lang", "en");
      localStorage.removeItem("search_history_v2");
      localStorage.setItem(
        "search_history",
        JSON.stringify([
          "Mountain reflections",
          "A long search with a very long descriptive name that must be safely truncated",
          "Beach",
          "Flowers",
          "City",
        ])
      );
      localStorage.setItem(
        "exif-filter-presets",
        JSON.stringify(
          Array.from({ length: 10 }, (_, index) => ({
            name: `Saved search ${index} with a long preset name`,
            filters: { cameraModel: "Canon" },
            createdAt: index + 1,
          }))
        )
      );
      const held: Array<() => void> = [];
      let holding = true;
      const gate = {
        held: 0,
        release: () => {
          holding = false;
          for (const deliver of held.splice(0)) {
            deliver();
          }
          gate.held = 0;
        },
      };
      window.starterLayoutGate = gate;
      const send = MessagePort.prototype.postMessage;
      // Only AI readiness and starter data are simulated; the app and layout are real.
      MessagePort.prototype.postMessage = function (message, transfer) {
        const request =
          typeof message === "string" ? JSON.parse(message) : message;
        const route = request?.p?.u ?? "";
        if (
          route.includes("getAiStatus") ||
          route.includes("getSearchStarters") ||
          (!metadataMode && route.includes("getSearchStarterFallbacks"))
        ) {
          const readiness = {
            model: "ready",
            vectorDB: "ready",
            hasVectors: !metadataMode,
            vectorCount: 50,
            indexReady: !metadataMode,
            isEmbedding: false,
            coverageState: "ready",
            totalPhotos: 50,
            indexedPhotos: 50,
            embeddingProgress: { processed: 50, total: 50, phase: "idle" },
          };
          const starters = {
            status: "ready",
            revision: "layout-fixture",
            validity: "layout-fixture",
            day: "2026-10-27",
            candidates: Array.from({ length: 12 }, (_, index) => ({
              key: `theme-${index}`,
              text:
                index === 11
                  ? "Lake"
                  : `Library theme ${index} with a long descriptive search phrase that continues beyond two visible lines even when this card expands`,
              topics: [`topic-${index}`],
              kind: "semantic",
              previewPhotoIds: [index + 1],
              source:
                (["interest", "rediscovery"] as const)[index] ?? "library",
            })),
          };
          let data: unknown = readiness;
          if (route.includes("getSearchStarters")) {
            data = starters;
          }
          if (route.includes("getSearchStarterFallbacks")) {
            data = { ...starters, candidates: [], status: "empty" };
          }
          const deliver = () =>
            this.dispatchEvent(
              new MessageEvent("message", {
                data: { i: request.i, p: { b: { json: data } } },
              })
            );
          if (route.includes("getSearchStarters") && holding) {
            held.push(deliver);
            gate.held = held.length;
          } else {
            queueMicrotask(deliver);
          }
          return;
        }
        if (Array.isArray(transfer)) {
          send.call(this, message, { transfer });
        } else {
          send.call(this, message, transfer ?? {});
        }
      };
    });
    for (const size of [
      { width: 720, height: 480 },
      { width: 900, height: 600 },
      { width: 1280, height: 800 },
      { width: 720, height: 480, zoom: 1.25 },
    ]) {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        const window =
          BrowserWindow.getAllWindows().find(
            (item) =>
              !item.isDestroyed() &&
              item.webContents.getURL().includes("index.html")
          ) ?? BrowserWindow.getAllWindows()[0];
        window.webContents.setZoomFactor(bounds.zoom ?? 1);
        window.setContentSize(bounds.width, bounds.height);
      }, size);
      await page.reload();
      const input = page.locator("input.home-search-input");
      await input.waitFor();
      // Startup restores the saved scale after loading, so apply the test scale afterwards.
      if (size.zoom) {
        await app.evaluate(({ BrowserWindow }, factor) => {
          BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor);
        }, size.zoom);
        await expect
          .poll(() => page.evaluate(() => innerWidth))
          .toBe(Math.round(size.width / size.zoom));
      }
      await input.focus();
      const panel = page.locator('[data-overlay-kind="search-suggestions"]');
      await expect(panel).toBeVisible();
      await expect(
        panel.getByText("Search presets (10)", { exact: true })
      ).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => window.starterLayoutGate.held))
        .toBeGreaterThan(0);
      const grid = panel.locator("[data-starter-grid]");
      await expect(grid).toHaveAttribute("data-starter-state", "loading");
      const before = await grid.boundingBox();
      await page.evaluate(() => window.starterLayoutGate.release());
      await expect(grid).toHaveAttribute("data-starter-state", "ready");
      const after = await grid.boundingBox();
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      expect(
        Math.abs((before?.height ?? 0) - (after?.height ?? 0))
      ).toBeLessThanOrEqual(1);
      expect(Math.abs((before?.y ?? 0) - (after?.y ?? 0))).toBeLessThanOrEqual(
        1
      );
      const layout = await panel.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const discovery = element.querySelector(
          "[data-search-discovery-layout]"
        );
        return {
          inside:
            bounds.left >= 0 &&
            bounds.top >= 0 &&
            bounds.right <= innerWidth + 1 &&
            bounds.bottom <= innerHeight + 1,
          overflow: [
            document.documentElement,
            document.body,
            ...document.querySelectorAll("main"),
          ].some((node) => node.scrollWidth > node.clientWidth + 2),
          columns: discovery
            ? getComputedStyle(discovery).gridTemplateColumns.split(" ").length
            : 0,
          width: element.clientWidth,
        };
      });
      expect(layout.inside).toBe(true);
      expect(layout.overflow).toBe(false);
      expect(layout.columns).toBe(layout.width >= 720 ? 2 : 1);
      const footer = panel.locator("[data-search-suggestions-footer]");
      const disclaimer = footer.getByText(
        "AI search results may be inaccurate or incomplete.",
        { exact: true }
      );
      await disclaimer.scrollIntoViewIfNeeded();
      await expect(disclaimer).toBeInViewport();
      const footerLayout = await footer.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hint = element.firstElementChild?.getBoundingClientRect();
        const notice = element.lastElementChild?.getBoundingClientRect();
        return {
          overflow: element.scrollWidth > element.clientWidth + 1,
          contained: [...element.querySelectorAll("span")].every((node) => {
            const rect = node.getBoundingClientRect();
            return (
              rect.left >= bounds.left &&
              rect.right <= bounds.right + 1 &&
              rect.top >= bounds.top &&
              rect.bottom <= bounds.bottom + 1
            );
          }),
          separated: Boolean(
            hint &&
              notice &&
              (notice.left >= hint.right || notice.top >= hint.bottom)
          ),
        };
      });
      expect(footerLayout).toEqual({
        overflow: false,
        contained: true,
        separated: true,
      });
      await panel.evaluate((node) => {
        node.scrollTop = 0;
      });
      const presetStrip = panel.locator("[data-search-preset-strip]");
      await presetStrip.locator("[data-search-preset]").first().hover();
      const panelScroll = await panel.evaluate((node) => node.scrollTop);
      await page.mouse.wheel(0, 160);
      await expect
        .poll(() => presetStrip.evaluate((node) => node.scrollLeft))
        .toBeGreaterThan(0);
      expect(await panel.evaluate((node) => node.scrollTop)).toBe(panelScroll);
      await page.mouse.wheel(0, -160);
      await expect
        .poll(() => presetStrip.evaluate((node) => node.scrollLeft))
        .toBe(0);
      await presetStrip.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      await presetStrip.hover();
      if (
        await panel.evaluate((node) => node.scrollHeight > node.clientHeight)
      ) {
        const edge = await presetStrip.evaluate((node) => ({
          scrollLeft: node.scrollLeft,
          maxScroll: node.scrollWidth - node.clientWidth,
          width: node.getBoundingClientRect().width,
        }));
        await page.mouse.wheel(0, 160);
        await expect
          .poll(() => panel.evaluate((node) => node.scrollTop), {
            message: `Wheel should scroll the panel at the preset edge: ${JSON.stringify(edge)}`,
          })
          .toBeGreaterThan(panelScroll);
      }
      await panel.evaluate((node) => {
        node.scrollTop = 0;
      });
      await presetStrip.evaluate((node) => {
        node.scrollLeft = 0;
      });
      await presetStrip.hover();
      await page.mouse.wheel(160, 0);
      await expect
        .poll(() => presetStrip.evaluate((node) => node.scrollLeft))
        .toBeGreaterThan(0);
      await presetStrip.evaluate((node) => {
        node.scrollLeft = 0;
      });
      const cards = panel.locator("[data-search-starters] [role=option]");
      await expect(cards.first().locator("img"))
        .toBeVisible()
        .catch(async (error) => {
          await page.screenshot({
            path: test.info().outputPath("cover-failure.png"),
          });
          fs.writeFileSync(
            test.info().outputPath("cover-layout.json"),
            JSON.stringify(
              {
                thumbnailResponses,
                layout: await cards.first().evaluate((node) => ({
                  children: [
                    ...(node.querySelector(".search-starter-cover")?.children ??
                      []),
                  ].map((child) => child.tagName),
                  bounds: node.getBoundingClientRect().toJSON(),
                  images: performance
                    .getEntriesByType("resource")
                    .filter((resource) =>
                      resource.name.includes("photo-thumbnail")
                    )
                    .map((resource) => new URL(resource.name).pathname),
                  httpPort: window.electronAPI?.httpPort,
                })),
              },
              null,
              2
            )
          );
          throw error;
        });
      await expect
        .poll(() =>
          cards
            .first()
            .locator("img")
            .evaluate((node) => (node as HTMLImageElement).naturalWidth)
        )
        .toBeGreaterThan(0);
      expect(await cards.first().locator("img").getAttribute("src")).toContain(
        "/photo-thumbnail?"
      );
      const strip = panel.locator(".search-starter-gallery");
      const galleryWidth = await strip.evaluate((node) => node.clientWidth);
      await cards.first().hover();
      if (galleryWidth >= 480) {
        await expect
          .poll(async () => {
            const firstWidth = (await cards.first().boundingBox())?.width ?? 0;
            const nextWidth = (await cards.nth(1).boundingBox())?.width ?? 1;
            return firstWidth / nextWidth;
          })
          .toBeGreaterThan(1.35);
      } else {
        await input.focus();
        await input.press("ArrowDown");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("ArrowRight");
        await expect(cards.last()).toBeFocused();
        await expect(cards.last()).toBeInViewport();
        await expect
          .poll(() => strip.evaluate((node) => node.scrollLeft))
          .toBeGreaterThan(0);
      }
      if (!size.zoom) {
        for (const direction of ["up", "down", "left", "right"]) {
          await input.focus();
          const card = direction === "right" ? cards.last() : cards.first();
          await card.hover();
          await expect(card).toHaveAttribute("data-active", "true");
          // Wait for the flex animation before measuring the exit coordinates.
          await expect
            .poll(() => card.evaluate((node) => node.getAnimations().length))
            .toBe(0);
          const bounds = await card.boundingBox();
          expect(bounds).not.toBeNull();
          if (!bounds) {
            throw new Error("Starter card has no bounds");
          }
          let x = bounds.x + bounds.width / 2;
          let y = bounds.y + bounds.height / 2;
          if (direction === "up") {
            y = bounds.y - 4;
          } else if (direction === "down") {
            y = bounds.y + bounds.height + 4;
          } else if (direction === "left") {
            x = bounds.x - 4;
          } else {
            x = bounds.x + bounds.width + 4;
          }
          await page.mouse.move(x, y);
          await expect(card).toHaveAttribute("data-active", "false");
          await expect(
            panel.locator('[data-search-starters] [data-active="true"]')
          ).toHaveCount(0);
          if (galleryWidth >= 480) {
            await expect
              .poll(() =>
                cards.evaluateAll((nodes) => {
                  const widths = nodes.map(
                    (node) => node.getBoundingClientRect().width
                  );
                  return Math.max(...widths) - Math.min(...widths);
                })
              )
              .toBeLessThan(1);
          }
        }
      }
      const first = await cards.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label"))
      );
      const refresh = panel.getByRole("button", {
        name: "More ideas",
        exact: true,
      });
      expect(await refresh.getAttribute("data-slot")).toBe("tooltip-trigger");
      await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find(
          (item) =>
            !item.isDestroyed() &&
            item.webContents.getURL().includes("index.html")
        );
        win?.focus();
        win?.webContents.focus();
      });
      await expect
        .poll(() => page.evaluate(() => document.hasFocus()))
        .toBe(true);
      await input.focus();
      // Use real keyboard navigation after native window focus restoration.
      // Hover coverage remains below on truncated and untruncated idea cards.
      await page.keyboard.press("Tab");
      await refresh.focus();
      const refreshHint = page.getByRole("tooltip", {
        name: "Explore other themes; ideas refresh daily",
        exact: true,
      });
      await expect(refreshHint).toBeVisible();
      await input.focus();
      await cards.first().hover();
      await expect(refreshHint).not.toBeVisible();
      const seen = new Set(first);
      for (let round = 0; round < 2; round++) {
        const beforeBatch = await cards.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label"))
        );
        await refresh.click();
        await expect
          .poll(async () =>
            JSON.stringify(
              await cards.evaluateAll((nodes) =>
                nodes.map((node) => node.getAttribute("aria-label"))
              )
            )
          )
          .not.toBe(JSON.stringify(beforeBatch));
        const batch = await cards.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label"))
        );
        expect(batch).toHaveLength(4);
        expect(batch.every((text) => !seen.has(text))).toBe(true);
        for (const text of batch) {
          seen.add(text);
        }
      }
      expect(seen.size).toBe(12);
      const rotated = await cards.evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("aria-label"))
      );
      const shortIdea = panel.getByRole("option", {
        name: "Lake",
        exact: true,
      });
      await shortIdea.hover();
      await page.waitForTimeout(500);
      await expect(page.getByRole("tooltip")).not.toBeVisible();
      await cards.first().hover();
      await expect(page.getByRole("tooltip")).toBeVisible();
      await shortIdea.hover();
      await expect(page.getByRole("tooltip")).not.toBeVisible();
      await page.screenshot({
        path: test
          .info()
          .outputPath(
            `starters-${size.width}x${size.height}-${size.zoom ?? 1}.png`
          ),
      });
      await input.press("Escape");
      await expect(panel).not.toBeVisible();
      await input.press("Tab");
      await input.focus();
      await expect(panel).toBeVisible();
      expect(
        await cards.evaluateAll((nodes) =>
          nodes.map((node) => node.getAttribute("aria-label"))
        )
      ).toEqual(rotated);
      await input.press("ArrowDown");
      await expect(cards.first()).toBeFocused();
      await expect(panel.locator('[aria-selected="true"]')).toHaveCount(1);
      await page.keyboard.press("ArrowUp");
      const lastHistory = panel
        .locator("[data-search-history] [role=option]")
        .last();
      await expect(lastHistory).toBeFocused();
      await expect(lastHistory).toBeInViewport();
      if (!size.zoom) {
        await lastHistory.hover();
      }
      await page.waitForTimeout(500);
      const truncated = await lastHistory
        .locator("[data-search-tooltip-text]")
        .evaluate((el) => el.scrollWidth > el.clientWidth);
      if (truncated) {
        await expect(page.getByRole("tooltip")).toBeVisible();
      } else {
        await expect(page.getByRole("tooltip")).not.toBeVisible();
      }
      await page.keyboard.press("Escape");
      await expect(panel).not.toBeVisible();
    }
    await app.evaluate(({ BrowserWindow }) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.setZoomFactor(1);
      }
    });
    // Metadata cards and their real searches remain functional without an AI index.
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() =>
      localStorage.setItem("starter-use-metadata", "1")
    );
    await page.reload();
    const input = page.locator("input.home-search-input");
    await input.waitFor();
    await input.focus();
    const panel = page.locator('[data-overlay-kind="search-suggestions"]');
    const beach = panel
      .locator("[data-search-starters]")
      .getByRole("option", { name: "Beach", exact: true });
    await expect(beach).toBeVisible();
    await expect(beach).toContainText("Explore by tag");
    expect(
      await beach.evaluate((node) => getComputedStyle(node).transitionDuration)
    ).toBe("0s");
    await beach.click();
    await expect(input).toHaveValue('"Beach"');
    await expect(page.locator('[data-photo-id="1"]')).toBeVisible();
    await input.fill("");
    await input.focus();
    await expect(
      panel
        .locator("[data-search-starters]")
        .getByRole("option", { name: "February 2023", exact: true })
    ).toBeVisible();
    await panel
      .locator("[data-search-starters]")
      .getByRole("option", { name: "February 2023", exact: true })
      .click();
    await expect(input).toHaveValue("");
    await expect(page.locator('[data-photo-id="12"]')).toBeVisible();
  } finally {
    await app.close();
  }
});
