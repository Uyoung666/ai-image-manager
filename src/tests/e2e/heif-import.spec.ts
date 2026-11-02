import fs from "node:fs";
import path from "node:path";
import { expect } from "@playwright/test";
import { waitForHomeWindow } from "./helpers/home-window";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

test("HEIC import, thumbnail and full preview at three window sizes", async () => {
  test.setTimeout(180_000);
  const root = createTestRuntime("heif-import");
  const fixture = path.join(root, "照片");
  fs.mkdirSync(fixture);
  fs.copyFileSync(
    path.resolve("src/tests/fixtures/heif/example.heic"),
    path.join(fixture, "主图.heic")
  );
  fs.copyFileSync(
    path.resolve("src/tests/fixtures/heif/rgb-10bit.heif"),
    path.join(fixture, "十位.heif")
  );
  const profile = path.join(root, "profile");
  const preload = path.join(root, "isolation.cjs");
  fs.writeFileSync(
    preload,
    `const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}`
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
    executablePath: process.env.AIM_E2E_EXECUTABLE,
    args: [
      "-r",
      preload,
      "--e2e",
      "--lang=zh-CN",
      process.env.AIM_E2E_APP_PATH ?? path.resolve("."),
    ],
    env,
  });
  try {
    const page = await waitForHomeWindow(app);
    await app.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [folder],
      });
    }, fixture);
    await page
      .getByRole("button", { name: "添加文件夹", exact: true })
      .first()
      .click();
    const cards = page.locator('main [data-photo-id][role="option"]');
    await expect(cards).toHaveCount(2, { timeout: 60_000 });
    for (const size of [
      { width: 720, height: 480 },
      { width: 900, height: 600 },
      { width: 1280, height: 800 },
    ]) {
      await app.evaluate(({ BrowserWindow }, requested) => {
        const window =
          BrowserWindow.getAllWindows().find((candidate) =>
            candidate.webContents.getURL().includes("index")
          ) ?? BrowserWindow.getAllWindows()[0];
        window.setContentSize(requested.width, requested.height);
        window.webContents.setZoomFactor(1);
      }, size);
      for (const card of await cards.all()) {
        const thumbnail = card.locator('img[data-load-state="loaded"]');
        await expect(thumbnail).toBeVisible();
        const src = await thumbnail.getAttribute("src");
        expect(src).toBeTruthy();
        const pathValue = await card.getAttribute("data-photo-id");
        expect(pathValue).toBeTruthy();
      }
      const fullPreview = await page.evaluate(
        async (folder) => {
          const thumbnail = document.querySelector<HTMLImageElement>(
            'main img[data-load-state="loaded"]'
          );
          if (!thumbnail) {
            throw new Error("No loaded thumbnail");
          }
          const url = new URL(thumbnail.src);
          const token = url.searchParams.get("token");
          url.pathname = "/image";
          url.search = "";
          if (token) {
            url.searchParams.set("token", token);
          }
          url.searchParams.set("path", `${folder}/主图.heic`);
          const response = await fetch(url);
          if (!response.ok) {
            return { status: response.status, body: await response.text() };
          }
          const blob = await response.blob();
          const bitmap = await createImageBitmap(blob);
          const result = {
            status: response.status,
            width: bitmap.width,
            height: bitmap.height,
          };
          bitmap.close();
          return result;
        },
        fixture.replaceAll("\\", "/")
      );
      expect(fullPreview).toEqual({ status: 200, width: 1280, height: 854 });
      const protocolPreview = await page.evaluate(
        async (folder) => {
          const encoded = `${folder}/主图.heic`
            .split("/")
            .map((part) => encodeURIComponent(part))
            .join("/");
          const response = await fetch(`local-media://${encoded}`);
          if (!response.ok) {
            return { status: response.status };
          }
          const bitmap = await createImageBitmap(await response.blob());
          const result = {
            status: response.status,
            width: bitmap.width,
            height: bitmap.height,
          };
          bitmap.close();
          return result;
        },
        fixture.replaceAll("\\", "/")
      );
      expect(protocolPreview).toEqual({
        status: 200,
        width: 1280,
        height: 854,
      });
      await cards.first().dblclick();
      const lightbox = page.getByRole("dialog", { name: "照片审阅灯箱" });
      await expect(lightbox).toBeVisible();
      await expect
        .poll(() =>
          lightbox
            .locator("img")
            .evaluateAll((images) =>
              images.some(
                (image) =>
                  image instanceof HTMLImageElement &&
                  image.complete &&
                  image.naturalWidth > 0
              )
            )
        )
        .toBe(true);
      await page.keyboard.press("Escape");
      await expect(lightbox).not.toBeVisible();
      expect(
        await page.evaluate(() =>
          [
            document.documentElement,
            document.body,
            ...document.querySelectorAll("main"),
          ].some((element) => element.scrollWidth > element.clientWidth + 2)
        )
      ).toBe(false);
      await page.screenshot({
        path: test.info().outputPath(`heif-${size.width}.png`),
      });
    }
  } finally {
    await app.close();
  }
});
