// biome-ignore-all lint/performance/useTopLevelRegex: patterns are used once per packaged smoke run.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type Browser,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";
import electronPath from "electron";
import { validatePluginPackage } from "../../../scripts/plugin-cli.mjs";
import english from "../../localization/english-renderer.json" with {
  type: "json",
};
import { TestRuntime } from "../helpers/test-runtime";

const pluginId = "com.aiimagemanager.japanese-locale";
const packagePath = process.env.AIM_LOCALE_PACKAGE;
const baselinePath = process.env.AIM_LOCALE_BASELINE_PACKAGE;
const executable = process.env.AIM_PACKAGED_E2E_EXECUTABLE;
const japanese = JSON.parse(
  fs.readFileSync(
    path.resolve(
      "external-plugins/japanese-locale/locales/ja-JP/renderer.json"
    ),
    "utf8"
  )
) as typeof english;
const WINDOWS = [
  { width: 720, height: 480, scale: 1 },
  { width: 900, height: 600, scale: 1 },
  { width: 1280, height: 800, scale: 1 },
  { width: 576, height: 384, scale: 1.25 },
];
test.setTimeout(240_000);
test.use({ actionTimeout: 15_000 });

const sha256 = (file: string) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");

test("official signed Japanese package installs, upgrades, survives restart and restores a last good version", async ({
  playwright: _playwright,
}, testInfo) => {
  test.skip(
    !(packagePath && baselinePath),
    "Requires signed current and baseline packages; the release gate supplies both."
  );
  if (!(packagePath && baselinePath)) {
    return;
  }
  if (
    process.env.AIM_LOCALE_SMOKE_OUTPUT &&
    !(executable && process.env.AIM_LOCALE_APP_ZIP)
  ) {
    throw new Error(
      "Release evidence requires the packaged executable and its app ZIP"
    );
  }
  const runtime = new TestRuntime("japanese-locale", path.resolve(".cache"));
  const profile = path.join(runtime.root, "profile");
  const baseline = await validatePluginPackage(baselinePath);
  const baselineWords = JSON.parse(
    baseline.files.get("locales/ja-JP/renderer.json")?.toString("utf8") ?? "{}"
  ) as typeof japanese;
  let child: ChildProcess | undefined;
  let browser: Browser | undefined;
  let page: Page | undefined;

  const requirePage = (): Page => {
    if (!page) {
      throw new Error("Locale test page unavailable");
    }
    return page;
  };

  const launch = async (archive: string) => {
    fs.mkdirSync(profile, { recursive: true });
    fs.rmSync(path.join(profile, "DevToolsActivePort"), { force: true });
    const args = [
      "--lang=en-US",
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--e2e",
      "--e2e-locale-smoke",
      `--e2e-locale-package=${path.resolve(archive)}`,
      `--user-data-dir=${profile}`,
    ];
    if (!executable) {
      args.push(path.resolve("."));
    }
    const launchEnvironment: NodeJS.ProcessEnv = {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
      CI: "e2e",
    };
    launchEnvironment.ELECTRON_RUN_AS_NODE = undefined;
    launchEnvironment.AI_IMAGE_MANAGER_USER_DATA_DIR = undefined;
    let debugEndpoint = "";
    const processHandle = spawn(
      executable ?? (electronPath as unknown as string),
      args,
      {
        env: launchEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      }
    );
    child = processHandle;
    runtime.trackProcess(processHandle);
    const captureOutput = (chunk: Buffer) => {
      const output = chunk.toString();
      fs.appendFileSync(path.join(runtime.root, "launch.log"), output);
      debugEndpoint =
        output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1] ??
        debugEndpoint;
    };
    processHandle.stdout?.on("data", captureOutput);
    processHandle.stderr?.on("data", captureOutput);
    await expect
      .poll(
        () => {
          if (processHandle.exitCode !== null) {
            throw new Error(
              `Packaged app exited ${processHandle.exitCode}: ${fs.readFileSync(path.join(runtime.root, "launch.log"), "utf8")}`
            );
          }
          return (
            Boolean(debugEndpoint) ||
            fs.existsSync(path.join(profile, "DevToolsActivePort"))
          );
        },
        {
          timeout: 30_000,
        }
      )
      .toBe(true);
    if (!debugEndpoint) {
      const port = fs
        .readFileSync(path.join(profile, "DevToolsActivePort"), "utf8")
        .split(/\r?\n/)[0];
      debugEndpoint = `http://127.0.0.1:${port}`;
    }
    browser = await chromium.connectOverCDP(debugEndpoint);
    await expect
      .poll(() => browser?.contexts()[0]?.pages().length ?? 0, {
        timeout: 30_000,
      })
      .toBeGreaterThan(0);
    page = browser.contexts()[0].pages()[0];
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await page.evaluate(() => window.__e2eNavigate?.("/settings/plugins"));
    await expect(
      page.getByRole("button", {
        name: /Install plugin|プラグインをインストール|安装插件/,
        exact: true,
      })
    ).toBeVisible();
  };

  const stop = async () => {
    if (page && !page.isClosed()) {
      await page
        .getByRole("button", {
          name: /^(Close|Close window|閉じる|ウィンドウを閉じる|关闭|关闭窗口)$/,
        })
        .click();
    }
    await expect
      .poll(() => child?.exitCode !== null || child?.signalCode !== null, {
        timeout: 20_000,
      })
      .toBe(true);
    await browser?.close();
    page = undefined;
    browser = undefined;
  };

  const preference = () => {
    const db = new DatabaseSync(
      path.join(profile, "data/ai-image-manager.db"),
      { readOnly: true }
    );
    try {
      return db
        .prepare(
          "SELECT selected_version AS selected, last_known_good_version AS good FROM plugin_preferences WHERE plugin_id = ?"
        )
        .get(pluginId) as { selected: string; good: string };
    } finally {
      db.close();
    }
  };

  const install = async (words: typeof english, fullCoverage: boolean) => {
    if (!page) {
      throw new Error("No locale test page");
    }
    await page
      .getByRole("button", { name: words.pluginManagerInstall, exact: true })
      .click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByText("uyoung-locale-release-1", { exact: true })
    ).toBeVisible();
    if (fullCoverage) {
      await expect(dialog.getByText(/100%/)).toBeVisible();
      const inspector = await page.context().newCDPSession(page);
      for (const size of WINDOWS) {
        await inspector.send("Emulation.setDeviceMetricsOverride", {
          width: size.width,
          height: size.height,
          deviceScaleFactor: size.scale,
          mobile: false,
        });
        await expect
          .poll(async () => {
            const box = await dialog.boundingBox();
            return box
              ? Math.max(
                  box.x + box.width - size.width,
                  box.y + box.height - size.height,
                  -box.x,
                  -box.y
                )
              : Number.POSITIVE_INFINITY;
          })
          .toBeLessThanOrEqual(1);
        const bounds = await dialog.boundingBox();
        expect(bounds).not.toBeNull();
        expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
          size.width + 1
        );
        expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
          size.height + 1
        );
        await page.screenshot({
          path: testInfo.outputPath(
            `japanese-install-${size.width}-${size.height}.png`
          ),
        });
      }
      await inspector.send("Emulation.clearDeviceMetricsOverride");
      await inspector.detach();
    }
    await dialog
      .getByRole("button", {
        name: words.pluginManagerInstallConfirm,
        exact: true,
      })
      .click();
    await expect(dialog).not.toBeVisible();
  };

  try {
    await launch(baselinePath);
    await install(english, false);
    await expect(requirePage().locator("html")).toHaveAttribute("lang", "en");
    await requirePage().getByTestId(`plugin-card-${pluginId}`).click();
    await requirePage()
      .getByRole("button", {
        name: `${english.pluginManagerUseLocale}: Japanese`,
        exact: true,
      })
      .click();
    await expect(requirePage().locator("html")).toHaveAttribute(
      "lang",
      "ja-JP"
    );
    await stop();
    const oldVersion = preference().good;

    await launch(packagePath);
    await expect(requirePage().locator("html")).toHaveAttribute(
      "lang",
      "ja-JP"
    );
    await install(baselineWords, true);
    await expect(requirePage().locator("html")).toHaveAttribute(
      "lang",
      "ja-JP"
    );
    const cdp = await requirePage().context().newCDPSession(requirePage());
    for (const size of WINDOWS) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: size.width,
        height: size.height,
        deviceScaleFactor: size.scale,
        mobile: false,
      });
      for (const route of [
        "/settings/plugins",
        "/settings/appearance",
        "/settings/update",
        "/settings/about",
        "/",
      ]) {
        await requirePage().evaluate((to) => window.__e2eNavigate?.(to), route);
        await expect(requirePage().locator("main").first()).toBeVisible();
        if (route === "/settings/appearance") {
          const languageMenu = requirePage().getByRole("combobox", {
            name: japanese.settingsLanguage,
            exact: true,
          });
          await languageMenu.click();
          const menu = requirePage().getByRole("listbox");
          await expect(
            menu.getByRole("option", { name: "日本語 (ja-JP)", exact: true })
          ).toBeVisible();
          const bounds = await menu.boundingBox();
          expect(bounds).not.toBeNull();
          expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
            size.width + 1
          );
          expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(
            size.height + 1
          );
          await requirePage().keyboard.press("Escape");
          await requirePage()
            .getByRole("button", { name: japanese.close, exact: true })
            .hover();
          const tooltip = requirePage().getByRole("tooltip");
          await expect(tooltip).toBeVisible();
          await expect(tooltip).toContainText(japanese.close);
          const tooltipBounds = await tooltip.boundingBox();
          expect(tooltipBounds).not.toBeNull();
          expect(tooltipBounds?.x).toBeGreaterThanOrEqual(0);
          expect(tooltipBounds?.y).toBeGreaterThanOrEqual(0);
          expect(
            (tooltipBounds?.x ?? 0) + (tooltipBounds?.width ?? 0)
          ).toBeLessThanOrEqual(size.width + 1);
          expect(
            (tooltipBounds?.y ?? 0) + (tooltipBounds?.height ?? 0)
          ).toBeLessThanOrEqual(size.height + 1);
          await requirePage().mouse.move(0, 0);
        }
        const overflow = await requirePage().evaluate(() =>
          Math.max(
            document.documentElement.scrollWidth - innerWidth,
            ...[...document.querySelectorAll("main, [role=dialog]")].map(
              (element) => element.scrollWidth - element.clientWidth
            )
          )
        );
        expect(
          overflow,
          `${route} at ${size.width}×${size.height}`
        ).toBeLessThanOrEqual(2);
      }
      await requirePage().screenshot({
        path: testInfo.outputPath(`japanese-${size.width}-${size.height}.png`),
      });
    }
    await stop();
    const newVersion = preference().good;
    expect(newVersion).not.toBe(oldVersion);
    expect(preference().selected).toBe(newVersion);

    await launch(packagePath);
    await expect(requirePage().locator("html")).toHaveAttribute(
      "lang",
      "ja-JP"
    );
    await stop();
    fs.appendFileSync(
      path.join(
        profile,
        "plugins",
        pluginId,
        newVersion,
        "locales/ja-JP/renderer.json"
      ),
      "\n"
    );
    await launch(packagePath);
    await expect(requirePage().locator("html")).toHaveAttribute(
      "lang",
      "ja-JP"
    );
    await stop();
    expect(preference().selected).toBe(oldVersion);

    await launch(packagePath);
    await requirePage().getByTestId(`plugin-card-${pluginId}`).click();
    await requirePage()
      .getByRole("button", {
        name: `${japanese.pluginManagerUninstall}: 日本語`,
        exact: true,
      })
      .click();
    await requirePage()
      .getByRole("alertdialog")
      .getByRole("button", {
        name: japanese.pluginManagerUninstallConfirm,
        exact: true,
      })
      .click();
    await expect(requirePage().locator("html")).not.toHaveAttribute(
      "lang",
      "ja-JP"
    );
    await stop();
    if (process.env.AIM_LOCALE_SMOKE_OUTPUT) {
      fs.writeFileSync(
        process.env.AIM_LOCALE_SMOKE_OUTPUT,
        JSON.stringify(
          {
            localeSmoke: "passed",
            localePackageSha256: sha256(packagePath),
            localeBaselineSha256: sha256(baselinePath),
            localeAppZipSha256: sha256(process.env.AIM_LOCALE_APP_ZIP ?? ""),
            windows: WINDOWS,
          },
          null,
          2
        )
      );
    }
  } finally {
    if (child?.exitCode === null && child.signalCode === null) {
      try {
        await stop();
      } catch {
        if (process.platform === "win32" && child.pid) {
          execFileSync(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true }
          );
        } else {
          child.kill();
        }
        runtime.retain();
      }
    }
    if (testInfo.status !== "passed") {
      runtime.retain();
    }
    const launchLog = path.join(runtime.root, "launch.log");
    if (fs.existsSync(launchLog)) {
      fs.copyFileSync(launchLog, testInfo.outputPath("launch.log"));
    }
    await expect
      .poll(() => {
        try {
          return runtime.cleanup().status;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "pending";
          }
          throw error;
        }
      })
      .not.toMatch(/skipped|pending/);
  }
});
