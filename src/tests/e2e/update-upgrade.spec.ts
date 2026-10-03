import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import {
  type Browser,
  chromium,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { version as appVersion } from "../../../package.json";

const require = createRequire(import.meta.url);
const executable = process.env.AIM_PACKAGED_E2E_EXECUTABLE;
const previousExecutables = [
  ["2.1.0", process.env.AIM_UPGRADE_FROM_210],
  ["2.2.0", process.env.AIM_UPGRADE_FROM_220],
] as const;
const SIZES = [
  { width: 720, height: 480 },
  { width: 900, height: 600 },
  { width: 1280, height: 800 },
];
const CONTINUE = /^(继续使用|Continue)$/;
const RETRY = /^(重试|Retry)$/;
const MANUAL =
  /^(手动下载|Download Manually|Manual Download|Download manually)$/;
const TLS = /无法建立安全连接|A secure connection could not be established/;
const GENERIC = /更新失败，请重试或手动下载|Update failed\. Please retry/;
test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as net.AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );
  return address.port;
}

async function launch(binary: string, profile: string) {
  const port = await unusedPort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
    CI: undefined,
    ELECTRON_RUN_AS_NODE: undefined,
    AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: undefined,
  };
  // Production fuses disable Node inspection; Chromium CDP leaves the release
  // binary intact and does not enable the application's E2E startup bypasses.
  const child = spawn(
    binary,
    [`--remote-debugging-port=${port}`, "--remote-debugging-address=127.0.0.1"],
    { env, stdio: "ignore", windowsHide: true }
  );
  let browser: Browser | undefined;
  try {
    await expect
      .poll(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${port}/json/version`)).ok;
          } catch {
            return false;
          }
        },
        { timeout: 45_000 }
      )
      .toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    const page = context.pages()[0] ?? (await context.waitForEvent("page"));
    return { child, browser, page };
  } catch (error) {
    await stop({ child, browser });
    throw error;
  }
}

async function stop({
  child,
  browser,
}: {
  child: ChildProcess;
  browser?: Browser;
}) {
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null && child.pid) {
    execFileSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    await expect.poll(() => child.exitCode, { timeout: 10_000 }).not.toBeNull();
  }
}

async function navigate(page: Page, route: string) {
  await page.evaluate((to) => window.__e2eNavigate?.(to), route);
  await expect(page.locator("main").first()).toBeVisible();
  await expect(
    page.getByText(
      "useBrowseSession must be used within <BrowseSessionProvider>",
      { exact: true }
    )
  ).toHaveCount(0);
}

function profileDirectory(label: string) {
  const root = path.resolve("out", "verify-221-profiles");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, `${label}-`));
}

function resizeWindow(child: ChildProcess, width: number, height: number) {
  if (!child.pid) {
    throw new Error("Packaged process has no PID");
  }
  // Electron's Chromium CDP omits Browser.setWindowBounds. Resize the actual
  // isolated native window without changing production fuses or IPC routes.
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `
    Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public static class UpdateTestWindow {
      public delegate bool Visitor(IntPtr window, IntPtr data);
      [DllImport("user32.dll")] public static extern bool EnumWindows(Visitor visitor, IntPtr data);
      [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
      [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int length);
      [DllImport("user32.dll", SetLastError=true)] public static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int cx, int cy, uint flags);
      public static IntPtr Find(uint pid) { IntPtr result=IntPtr.Zero; EnumWindows((window,data) => { uint owner; GetWindowThreadProcessId(window,out owner); var name=new StringBuilder(256); GetClassName(window,name,256); if(owner==pid && name.ToString()=="Chrome_WidgetWin_1") { result=window; return false; } return true; },IntPtr.Zero); return result; }
    }';
    $windowHandle = [UpdateTestWindow]::Find(${child.pid});
    if ($windowHandle -eq 0) { throw 'Isolated application window is missing' };
    if (-not [UpdateTestWindow]::SetWindowPos($windowHandle, [IntPtr]::Zero, 0, 0, ${width}, ${height}, 6)) { throw 'Window resize failed' };
  `,
    ],
    { windowsHide: true, stdio: "pipe", timeout: 15_000 }
  );
}

for (const [version, previous] of previousExecutables) {
  test(`production startup from ${version}, update errors, sizes and second restart`, async () => {
    const testInfo = test.info();
    test.skip(
      !(executable && previous),
      "requires current and previous packaged executables"
    );
    if (!(executable && previous)) {
      return;
    }
    const profile = profileDirectory(version);
    execFileSync(
      require("electron"),
      [
        "scripts/e2e-seed-update-profile.mjs",
        profile,
        path.join(path.dirname(previous), "resources", "drizzle"),
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        windowsHide: true,
      }
    );
    const old = await launch(previous, profile);
    try {
      await expect(old.page.locator('[data-surface="gallery"]')).toBeVisible({
        timeout: 45_000,
      });
      await expect
        .poll(
          () =>
            JSON.parse(
              fs.readFileSync(path.join(profile, "update-welcome.json"), "utf8")
            ).lastLaunchedVersion
        )
        .toBe(version);
    } finally {
      await stop(old);
    }
    fs.writeFileSync(
      path.join(profile, "update-state.json"),
      JSON.stringify({
        state: {
          phase: "error",
          message:
            "Command failed: 4294967295 System.Net.WebException: ���� System.Net.TlsStream.EndWrite",
        },
      })
    );
    const current = await launch(executable, profile);
    const errors: string[] = [];
    current.page.on("pageerror", (error) => errors.push(error.message));
    try {
      await expect(current.page.locator(".whats-new-title")).toBeVisible({
        timeout: 45_000,
      });
      await expect(
        current.page.locator(".whats-new-release-visual-version")
      ).toHaveText(`v${appVersion}`);
      expect(
        await current.page.evaluate(() => window.electronAPI?.isE2E)
      ).toBeFalsy();
      await current.page.getByRole("button", { name: CONTINUE }).click();
      await expect(
        current.page.locator('[data-surface="gallery"]')
      ).toBeVisible();
      for (const route of [
        "/people",
        "/albums",
        "/albums/1",
        "/dashboard",
        "/trash",
        "/",
        "/settings/update",
      ]) {
        await navigate(current.page, route);
      }
      await expect(current.page.getByText(TLS)).toBeVisible();
      for (const size of SIZES) {
        resizeWindow(current.child, size.width, size.height);
        await expect
          .poll(() =>
            current.page.evaluate(
              (requested) =>
                Math.max(
                  Math.abs(window.outerWidth - requested.width),
                  Math.abs(window.outerHeight - requested.height)
                ),
              size
            )
          )
          .toBeLessThanOrEqual(2); // Windows DPI conversion can round by one pixel.
        await current.page
          .getByRole("button", { name: MANUAL })
          .scrollIntoViewIfNeeded();
        await expect(
          current.page.getByRole("button", { name: MANUAL })
        ).toBeInViewport();
        expect(
          await current.page.evaluate(() =>
            [
              document.documentElement,
              document.body,
              ...document.querySelectorAll("main"),
            ].every((el) => el.scrollWidth <= el.clientWidth + 2)
          )
        ).toBe(true);
        await current.page.screenshot({
          path: testInfo.outputPath(`update-${size.width}x${size.height}.png`),
        });
      }
      await current.page.getByRole("button", { name: RETRY }).click();
      await expect(current.page.getByText(TLS)).toHaveCount(0);
      await current.page.evaluate(() =>
        window.postMessage(
          { channel: "update:status", phase: "error", message: "unknown ����" },
          "*"
        )
      );
      await expect(current.page.getByText(GENERIC)).toBeVisible();
      await current.page.evaluate(() =>
        window.postMessage(
          { channel: "update:status", phase: "up-to-date" },
          "*"
        )
      );
      await expect(current.page.getByText(GENERIC)).toHaveCount(0);
      expect(errors).toEqual([]);
      const diagnosticLog = fs.readFileSync(
        path.join(profile, "logs", "app.log"),
        "utf8"
      );
      expect(diagnosticLog).not.toContain(
        "useBrowseSession must be used within"
      );
    } finally {
      await stop(current);
    }
    const restarted = await launch(executable, profile);
    try {
      await expect(
        restarted.page.locator('[data-surface="gallery"]')
      ).toBeVisible({ timeout: 45_000 });
      await expect(restarted.page.locator(".whats-new-title")).toHaveCount(0);
    } finally {
      await stop(restarted);
    }
  });
}

test("fresh packaged launch shows onboarding instead of the upgrade welcome", async () => {
  test.skip(!executable, "requires a packaged executable");
  if (!executable) {
    return;
  }
  const current = await launch(executable, profileDirectory("fresh"));
  try {
    await expect(current.page.locator(".onboarding-overlay")).toBeVisible({
      timeout: 45_000,
    });
    await expect(current.page.locator(".whats-new-title")).toHaveCount(0);
    expect(
      await current.page.evaluate(() => window.electronAPI?.isE2E)
    ).toBeFalsy();
  } finally {
    await stop(current);
  }
});
