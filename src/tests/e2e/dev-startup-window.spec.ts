import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { expect } from "@playwright/test";
import { build } from "vite";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

let server: http.Server;
let bundle: string;
let url: string;
let mode: "delayed" | "error" = "delayed";
const MARK = "aim:dev-renderer-first-frame";

test.setTimeout(90_000);
test.beforeAll(async () => {
  server = http.createServer((request, response) => {
    if (request.url === "/entry.js") {
      const failed = mode === "error";
      setTimeout(
        () => {
          response.writeHead(200, { "content-type": "text/javascript" });
          response.end(
            `document.querySelector('#app').innerHTML=${JSON.stringify(failed ? '<main role="alert">Controlled error surface</main>' : "<main>Ready workspace</main>")};requestAnimationFrame(()=>requestAnimationFrame(()=>performance.mark('${MARK}')));`
          );
        },
        failed ? 2000 : 10_000
      );
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      '<!doctype html><html><head><style>html,body,#app,main{height:100%;margin:0;background:#fbfbfc;color:#17181a}</style></head><body><div id="app"></div><script type="module" src="/entry.js"></script></body></html>'
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("No dev fixture port");
  }
  url = `http://127.0.0.1:${address.port}`;
  bundle = path.join(createTestRuntime("dev-startup-build"), "bundle");
  await build({
    configFile: path.resolve("vite.main.config.mts"),
    mode: "development",
    resolve: {
      conditions: ["node"],
      mainFields: ["module", "jsnext:main", "jsnext"],
    },
    define: {
      MAIN_WINDOW_VITE_DEV_SERVER_URL: JSON.stringify(url),
      MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
    },
    build: { outDir: bundle, emptyOutDir: false, minify: false },
    logLevel: "warn",
  });
  await build({
    configFile: path.resolve("vite.preload.config.mts"),
    mode: "development",
    build: {
      outDir: bundle,
      emptyOutDir: false,
      lib: {
        entry: path.resolve("src/preload.ts"),
        formats: ["cjs"],
        fileName: () => "preload.js",
      },
    },
    logLevel: "warn",
  });
});
test.afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function fixture() {
  const root = createTestRuntime("dev-startup-window");
  const fixturePath = path.join(root, "app");
  fs.mkdirSync(fixturePath);
  fs.mkdirSync(path.join(fixturePath, "assets"));
  fs.copyFileSync(
    path.resolve("assets/icon.ico"),
    path.join(fixturePath, "assets/icon.ico")
  );
  fs.writeFileSync(
    path.join(fixturePath, "package.json"),
    JSON.stringify({
      name: "ai-image-manager",
      version: "2.2.3",
      type: "module",
      main: path.join(bundle, "bootstrap.js"),
    })
  );
  const hook = path.join(root, "isolate.cjs");
  fs.writeFileSync(
    hook,
    `const electron=require('electron');const {app}=electron;const fs=require('node:fs');const path=require('node:path');
app.setAppPath(${JSON.stringify(path.resolve("."))});
for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const dir=path.join(__dirname,part);fs.mkdirSync(dir,{recursive:true});app.setPath(key,dir);}
const setMenu=electron.Tray.prototype.setContextMenu;electron.Tray.prototype.setContextMenu=function(...args){globalThis.__devTestTray=this;return setMenu.apply(this,args);};
const stages=[];globalThis.__devTestStages=stages;app.on('browser-window-created',(_e,win)=>{stages.push({type:'created',id:win.id,at:Date.now()});win.on('show',()=>stages.push({type:'show',id:win.id,at:Date.now()}));});
globalThis.__devTestAppDetails=[];const setDetails=electron.BrowserWindow.prototype.setAppDetails;electron.BrowserWindow.prototype.setAppDetails=function(details){globalThis.__devTestAppDetails.push(details);return setDetails.call(this,details);};`
  );
  return { root, fixturePath, hook, profile: path.join(root, "profile") };
}

async function launch(scale = "1.5") {
  const f = fixture();
  const app = await launchTestApp(f.root, {
    args: [
      "-r",
      f.hook,
      `--force-device-scale-factor=${scale}`,
      "--e2e",
      "--e2e-locale-smoke",
      f.fixturePath,
    ],
    env: {
      ...process.env,
      CI: "e2e",
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: f.profile,
    },
    timeout: 60_000,
  });
  const loading = await app.firstWindow();
  await expect(loading.locator("[data-dev-startup]")).toBeVisible();
  return { ...f, app, loading };
}

test("automatically shows the loader, routes tray requests and hands off without blank content", async () => {
  mode = "delayed";
  const { app, loading, fixturePath } = await launch();
  try {
    await expect
      .poll(() =>
        app.evaluate(() =>
          Boolean(
            (globalThis as unknown as { __devTestTray?: unknown }).__devTestTray
          )
        )
      )
      .toBe(true);
    // Creating the tray precedes assigning the main window's URL. Wait for
    // that window, then still require it to stay hidden during the handoff.
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const windows = BrowserWindow.getAllWindows();
          const target = windows.find((window) =>
            window.webContents.getURL().startsWith("http")
          );
          return target?.isVisible();
        })
      )
      .toBe(false);
    if (process.platform === "win32") {
      const details = await app.evaluate(
        () =>
          (
            globalThis as unknown as {
              __devTestAppDetails: { appId: string; appIconPath: string }[];
            }
          ).__devTestAppDetails
      );
      expect(details).toHaveLength(2);
      for (const item of details) {
        expect(item.appId).toBe(
          "com.squirrel.ai-image-manager.ai-image-manager.development"
        );
        expect(item.appIconPath).toBe(
          path.join(fixturePath, "assets/icon.ico")
        );
      }
    }
    await app.evaluate(() => {
      (
        globalThis as unknown as { __devTestTray: { emit(name: string): void } }
      ).__devTestTray.emit("double-click");
    });
    await expect(loading.locator("[data-dev-startup]")).toBeVisible();
    await loading.emulateMedia({ reducedMotion: "reduce" });
    expect(
      await loading
        .locator(".spinner")
        .evaluate((element) => getComputedStyle(element).animationName)
    ).toBe("none");
    const loadingBounds = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows().find((item) =>
        item.webContents.getURL().startsWith("data:")
      );
      if (!window) {
        throw new Error("No loading window");
      }
      return {
        bounds: window.getBounds(),
        area: screen.getDisplayMatching(window.getBounds()).workArea,
      };
    });
    expect(loadingBounds.bounds.x).toBeGreaterThanOrEqual(loadingBounds.area.x);
    expect(loadingBounds.bounds.y).toBeGreaterThanOrEqual(loadingBounds.area.y);
    expect(
      loadingBounds.bounds.x + loadingBounds.bounds.width
    ).toBeLessThanOrEqual(loadingBounds.area.x + loadingBounds.area.width);
    expect(
      loadingBounds.bounds.y + loadingBounds.bounds.height
    ).toBeLessThanOrEqual(loadingBounds.area.y + loadingBounds.area.height);
    await loading.screenshot({
      path: test.info().outputPath("dev-loading.png"),
    });
    await expect
      .poll(() =>
        app
          .windows()
          .find((page) => page.url().startsWith(url))
          ?.url()
      )
      .not.toBeUndefined();
    const page = (await app.windows()).find((item) =>
      item.url().startsWith(url)
    );
    if (!page) {
      throw new Error("Main page missing");
    }
    await expect(page.locator("main")).toHaveText("Ready workspace", {
      timeout: 30_000,
    });
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1);
    const result = await app.evaluate(({ BrowserWindow, screen }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return {
        visible: window.isVisible(),
        stages: (
          globalThis as unknown as {
            __devTestStages: { type: string; id: number; at: number }[];
          }
        ).__devTestStages,
        area: screen.getPrimaryDisplay().workArea,
      };
    });
    expect(result.visible).toBe(true);
    const firstFrameAt = await page.evaluate(
      (mark) =>
        performance.timeOrigin +
        performance.getEntriesByName(mark)[0].startTime,
      MARK
    );
    const targetShown = result.stages.find(
      (stage) => stage.type === "show" && stage.id !== result.stages[0].id
    );
    expect(targetShown).toBeDefined();
    expect((targetShown?.at ?? 0) - firstFrameAt).toBeLessThan(500);
    const created = result.stages[0];
    const shown = result.stages.find(
      (stage) => stage.type === "show" && stage.id === created.id
    );
    expect(shown).toBeDefined();
    expect((shown?.at ?? 0) - created.at).toBeLessThan(2000);
    for (const [width, height] of [
      [720, 480],
      [900, 600],
      [1280, 800],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]),
        [width, height]
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true);
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].hide()
    );
    await app.evaluate(() => {
      (
        globalThis as unknown as { __devTestTray: { emit(name: string): void } }
      ).__devTestTray.emit("double-click");
    });
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible()
      )
    ).toBe(true);
  } finally {
    await app.close();
  }
});

test("closing the loading window exits while frontend entry is delayed", async () => {
  mode = "delayed";
  const { app } = await launch("1");
  const exited = new Promise<void>((resolve) =>
    app.process().once("exit", () => resolve())
  );
  await app.evaluate(({ BrowserWindow }) => {
    const loading = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().startsWith("data:")
    );
    if (!loading) {
      throw new Error("Loading window missing before close");
    }
    loading.close();
  });
  await exited;
});

test("an error surface can complete the handoff instead of leaving the loader forever", async () => {
  mode = "error";
  const { app } = await launch();
  try {
    await expect
      .poll(() =>
        app
          .windows()
          .find((page) => page.url().startsWith(url))
          ?.url()
      )
      .not.toBeUndefined();
    const page = app.windows().find((item) => item.url().startsWith(url));
    if (!page) {
      throw new Error("Main page missing");
    }
    await expect(page.getByRole("alert")).toHaveText(
      "Controlled error surface"
    );
    await expect
      .poll(() =>
        app.evaluate(
          ({ BrowserWindow }) => BrowserWindow.getAllWindows().length
        )
      )
      .toBe(1);
  } finally {
    await app.close();
  }
});
