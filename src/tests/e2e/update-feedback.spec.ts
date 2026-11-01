import fs from "node:fs/promises";
import path from "node:path";
import { type ElectronApplication, expect, type Page } from "@playwright/test";
import type { UpdateStatus } from "@/types/update";
import {
  closeTestApp,
  createTestRuntime,
  launchTestApp,
  test,
} from "./helpers/test-runtime";

const LOCALES = ["zh", "en", "ja-JP"] as const;
const WINDOWS = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
  { width: 576, height: 384 },
];
const INSTALL = /^(安装并重启|Install and restart|インストールして再起動)$/;
const SETTINGS = /^(查看更新设置|Open update settings|更新設定を開く)$/;
const FULL = /^(改用完整包|Use full package|完全パッケージを使用)$/;
const RETRY_SPACE =
  /^(释放空间后重试|Retry after freeing space|空き容量を確保して再試行)$/;
const VIEW = /^(查看更新|View update|更新を確認)$/;
const ACTIVE_TOAST = '[data-sonner-toast]:not([data-removed="true"])';
const CHECKED_AT = "2026-10-03T10:45:06.000Z";
let activeApp: ElectronApplication | undefined;

test.afterEach(async () => {
  if (activeApp) {
    await closeTestApp(activeApp);
    activeApp = undefined;
  }
});

declare global {
  interface Window {
    updateUiRequests: string[];
  }
}

async function emit(page: Page, status: UpdateStatus) {
  await page.evaluate(
    (value) => window.postMessage({ channel: "update:status", ...value }, "*"),
    status
  );
}

async function screenshot(app: ElectronApplication, name: string) {
  // CDP screenshots crop incorrectly after changing Electron's zoom factor.
  // Capture the actual native window content, including the 125% zoom case.
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const image =
      await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return image.toPNG().toString("base64");
  });
  await fs.writeFile(test.info().outputPath(name), Buffer.from(png, "base64"));
}

async function assertBounds(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const elements = [
          ...document.querySelectorAll(
            "main, [data-testid='update-details'], [data-testid='update-header-control']"
          ),
        ];
        return (
          elements.every((element) => {
            const rect = element.getBoundingClientRect();
            return (
              element.scrollWidth <= element.clientWidth + 2 &&
              rect.left >= -2 &&
              rect.right <= innerWidth + 2 &&
              rect.top >= -2 &&
              rect.bottom <= innerHeight + 2
            );
          }) && document.documentElement.scrollWidth <= innerWidth + 2
        );
      })
    )
    .toBe(true);
}

for (const locale of LOCALES) {
  test(`update title bar, details and actions remain usable in ${locale}`, async () => {
    test.setTimeout(180_000);
    const profile = createTestRuntime(`update-ui-${locale.toLowerCase()}`);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && typeof entry[1] === "string"
      )
    );
    const app = await launchTestApp(profile, {
      args: [
        "--no-sandbox",
        "--disable-gpu-sandbox",
        "--e2e",
        path.resolve("."),
      ],
      env: { ...env, CI: "e2e", AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile },
    });
    activeApp = app;
    const page = await app.firstWindow();
    await page.waitForLoadState("load");
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    const japanese = JSON.parse(
      await fs.readFile(
        path.resolve(
          "external-plugins/japanese-locale/locales/ja-JP/renderer.json"
        ),
        "utf8"
      )
    );
    // Only localization transport is supplied by the fixture. Update commands
    // still reach the real app IPC (development mode refuses installation).
    await page.addInitScript(
      ({ language, words }) => {
        localStorage.setItem("lang", language);
        window.updateUiRequests = [];
        const localeRequests = new Set<unknown>();
        const send = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function (message, transfer) {
          const request =
            typeof message === "string" ? JSON.parse(message) : message;
          if (
            request?.p?.u?.includes("localization") &&
            request.p.u.includes("initialize")
          ) {
            localeRequests.add(request.i);
          }
          if (typeof request?.p?.u === "string") {
            window.updateUiRequests.push(request.p.u);
          }
          if (Array.isArray(transfer)) {
            send.call(this, message, { transfer });
          } else {
            send.call(this, message, transfer ?? {});
          }
        };
        const listen = MessagePort.prototype.addEventListener;
        MessagePort.prototype.addEventListener = function (
          type: string,
          listener: EventListenerOrEventListenerObject | null,
          options?: boolean | AddEventListenerOptions
        ) {
          if (!listener) {
            return;
          }
          if (type !== "message" || typeof listener !== "function") {
            return listen.call(this, type, listener, options);
          }
          return listen.call(
            this,
            type,
            (event) => {
              const raw = (event as MessageEvent).data;
              const response = typeof raw === "string" ? JSON.parse(raw) : raw;
              if (localeRequests.delete(response?.i)) {
                const selected = {
                  available: [],
                  direction: "ltr",
                  providerPluginId:
                    language === "ja-JP" ? "fixture.japanese" : null,
                  renderer: language === "ja-JP" ? words : null,
                  selectedLocale: language,
                };
                const replaced = {
                  ...response,
                  p: { ...response.p, s: 200, b: { json: selected } },
                };
                listener.call(
                  this,
                  new MessageEvent("message", {
                    data:
                      typeof raw === "string"
                        ? JSON.stringify(replaced)
                        : replaced,
                  })
                );
              } else {
                listener.call(this, event);
              }
            },
            options
          );
        };
      },
      { language: locale, words: japanese }
    );
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__e2eNavigate));
    await expect(page.locator("html")).toHaveAttribute("lang", locale);
    const checkedTime = await page.evaluate(
      ({ value, language }) => new Date(value).toLocaleString(language),
      { value: CHECKED_AT, language: locale }
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].focus()
    );

    for (const size of WINDOWS) {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        const win = BrowserWindow.getAllWindows()[0];
        const zoom = bounds.width === 576 ? 1.25 : 1;
        win.webContents.setZoomFactor(zoom);
        win.setContentSize(
          Math.round(bounds.width * zoom),
          Math.round(bounds.height * zoom)
        );
      }, size);
      await expect
        .poll(() =>
          page.evaluate(
            (bounds) =>
              Math.max(
                Math.abs(innerWidth - bounds.width),
                Math.abs(innerHeight - bounds.height)
              ),
            size
          )
        )
        .toBeLessThanOrEqual(1);
      for (const theme of ["light", "dark"]) {
        await page.evaluate((value) => {
          document.documentElement.classList.remove("light", "dark");
          document.documentElement.classList.add(value);
        }, theme);
        await page.evaluate(() => window.__e2eNavigate?.("/"));
        await emit(page, {
          phase: "downloading",
          version: "2.2.4",
          percent: 42,
          transferred: 28 * 1024 ** 2,
          total: 67 * 1024 ** 2,
          bytesPerSecond: 2.1 * 1024 ** 2,
          lastCheckedAt: CHECKED_AT,
          phaseStartedAt: new Date().toISOString(),
        });
        const trigger = page.getByTestId("update-header-control");
        await expect(trigger).toBeVisible();
        await expect(page.locator(ACTIVE_TOAST)).toHaveCount(0);
        await expect(trigger).toContainText("42%");
        await trigger.focus();
        await page.keyboard.press("Enter");
        const details = page.getByTestId("update-details");
        await expect(details).toBeVisible();
        await expect(details).toHaveCSS("opacity", "1");
        await expect(details).toContainText(checkedTime);
        await expect(details).not.toContainText("&#x2F;");
        await expect(details.getByRole("progressbar")).toHaveAttribute(
          "aria-valuenow",
          "42"
        );
        await assertBounds(page);
        await screenshot(app, `${locale}-${size.width}-${theme}-download.png`);
        for (const phase of [
          "retry-wait",
          "recovering",
          "installing",
          "restarting",
        ] as const) {
          await emit(page, {
            phase,
            operation: "install",
            version: "2.2.4",
            recoveryReason:
              phase === "recovering" ? "cache-corrupt" : undefined,
            percent: 100,
            retryAfter: new Date(Date.now() + 60_000).toISOString(),
            installStartedAt: new Date().toISOString(),
          });
          await expect(details).toBeVisible();
          await assertBounds(page);
          if (phase !== "retry-wait") {
            await expect(details.getByRole("progressbar")).toHaveCount(0);
          }
        }
        await emit(page, {
          phase: "error",
          message: "UPDATE_DISK_SPACE",
          operation: "download",
          canResume: true,
          canUseFull: true,
          version: "2.2.4",
          lastCheckedAt: CHECKED_AT,
        });
        await expect(
          details.getByRole("button", { name: RETRY_SPACE })
        ).toBeVisible();
        await expect(details.getByRole("button", { name: FULL })).toHaveCount(
          0
        );
        await assertBounds(page);
        await screenshot(app, `${locale}-${size.width}-${theme}-space.png`);
        await page.keyboard.press("Escape");
        await expect(details).toBeHidden();
        await expect(trigger).toBeFocused();
        await trigger.click();
        await details.getByRole("button", { name: SETTINGS }).click();
        await expect(details).toBeHidden();
        const task = page.getByTestId("update-task-card");
        await expect(task).toContainText(checkedTime);
        await expect(task).not.toContainText("&#x2F;");
        await expect(
          task.getByRole("button", { name: RETRY_SPACE })
        ).toBeVisible();
        await expect(page.locator("main")).toHaveCount(1);
        await assertBounds(page);
        await emit(page, { phase: "idle" });
        await expect(trigger).toBeHidden();
      }
    }

    await app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.webContents.setZoomFactor(1);
      win.setContentSize(900, 600);
    });
    await page.evaluate(() => window.__e2eNavigate?.("/whats-new"));
    await emit(page, { phase: "downloading", version: "2.2.4", percent: 42 });
    await page.getByTestId("update-header-control").click();
    await expect(page.getByTestId("update-details")).toBeVisible();
    await page.evaluate(() => window.__e2eNavigate?.("/settings/update"));
    await expect(page.getByTestId("update-header-control")).toContainText(
      "42%"
    );
    await expect(page.getByTestId("update-details")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("update-details")).toBeHidden();
    await emit(page, { phase: "downloaded", version: "2.2.99" });
    const toast = page.locator(ACTIVE_TOAST);
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: VIEW, exact: true }).click();
    const details = page.getByTestId("update-details");
    await expect(details).toBeVisible();
    const before = await page.evaluate(
      () =>
        window.updateUiRequests.filter((entry) =>
          entry.includes("installDownloadedUpdate")
        ).length
    );
    await details.getByRole("button", { name: INSTALL }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.updateUiRequests.filter((entry) =>
              entry.includes("installDownloadedUpdate")
            ).length
        )
      )
      .toBe(before + 1);
    // A real DEV_MODE rejection remains localized and actionable in the panel.
    await expect(details.getByRole("alert")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(details).toBeHidden();
    await emit(page, { phase: "downloaded", version: "2.2.100" });
    const task = page.locator("main").getByTestId("update-task-card");
    await task.getByRole("button", { name: INSTALL }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.updateUiRequests.filter((entry) =>
              entry.includes("installDownloadedUpdate")
            ).length
        )
      )
      .toBe(before + 2);
    await expect(task.getByRole("alert")).toBeVisible();
    // The update control is outside the draggable region; the existing drag
    // region still owns double-click maximize and its native app-region style.
    expect(
      await page
        .getByTestId("update-header-control")
        .evaluate((element) =>
          getComputedStyle(
            element.closest(".window-buttons") ?? element
          ).getPropertyValue("-webkit-app-region")
        )
    ).toBe("no-drag");
    expect(
      await page
        .locator(".draglayer")
        .evaluate((element) =>
          getComputedStyle(element).getPropertyValue("-webkit-app-region")
        )
    ).toBe("drag");
    await page.locator(".draglayer").dblclick();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isMaximized()
        )
      )
      .toBe(true);
    await page.locator(".draglayer").dblclick();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isMaximized()
        )
      )
      .toBe(false);
  });
}
