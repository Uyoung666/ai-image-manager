// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import electron from "electron";
import { expect, it, vi } from "vitest";
import { waitForProductPage } from "../../../scripts/release/update-product-gate.mjs";
import { TestRuntime } from "../helpers/test-runtime";

vi.unmock("electron");

it.skipIf(process.platform !== "win32")(
  "waits for a real Electron window and its router after CDP connects, and propagates startup failures",
  async () => {
    const runtime = new TestRuntime("product-cdp-startup");
    const fixture = path.join(runtime.root, "main.cjs");
    const create = path.join(runtime.root, "create-window");
    const load = path.join(runtime.root, "load-renderer");
    const quit = path.join(runtime.root, "quit");
    const reservation = net.createServer();
    await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    await fs.writeFile(
      fixture,
      `const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
app.setPath('userData',${JSON.stringify(path.join(runtime.root, "profile"))});
app.on('window-all-closed',()=>{});
app.whenReady().then(()=>{
  let window,loading=false;
  setInterval(()=>{
    if(fs.existsSync(${JSON.stringify(quit)})) return app.quit();
    if(!window && fs.existsSync(${JSON.stringify(create)})) {
      window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
      window.loadURL('data:text/html,<p>loading</p>');
    }
    if(window && !loading && fs.existsSync(${JSON.stringify(load)})) {
      loading=true;
      window.loadURL('data:text/html,'+encodeURIComponent('<p>ready</p><script>window.__e2eNavigate=async()=>"ready"</script>'));
    }
  },20);
});`
    );
    let child;
    let closed;
    let browser;
    let stderr = "";
    try {
      const registration = runtime.registerLaunch();
      child = spawn(electron, [fixture, `--remote-debugging-port=${port}`], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      runtime.trackProcess(child, registration);
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      closed = new Promise((resolve) => child.once("close", resolve));
      await vi.waitFor(
        async () => {
          expect(child.exitCode, stderr).toBeNull();
          expect(
            (await fetch(`http://127.0.0.1:${port}/json/version`)).ok
          ).toBe(true);
        },
        { timeout: 15_000 }
      );
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0];
      // This is the exact state that crashed the release's old pages()[0].
      expect(context.pages()).toHaveLength(0);
      const waiting = waitForProductPage(browser, 5000);
      waiting.catch(() => undefined);
      const created = context.waitForEvent("page", { timeout: 5000 });
      await fs.writeFile(create, "create");
      const page = await created;
      expect(await page.evaluate(() => Boolean(window.__e2eNavigate))).toBe(
        false
      );
      expect(
        await Promise.race([waiting.then(() => "ready"), delay(50, "waiting")])
      ).toBe("waiting");
      await fs.writeFile(load, "load");
      expect(await waiting).toBe(page);
      expect(await page.locator("p").innerText()).toBe("ready");
      // Reconnection may also find an existing page instead of a new event.
      expect(await waitForProductPage(browser, 1000)).toBe(page);
      await page.evaluate(() => {
        window.electronAPI = { isE2E: true };
      });
      await expect(waitForProductPage(browser, 1000)).rejects.toThrow(
        "startup bypass"
      );
      await page.evaluate(() => {
        window.electronAPI = undefined;
        window.__e2eNavigate = undefined;
      });
      await expect(waitForProductPage(browser, 100)).rejects.toThrow("Timeout");
      await page.close();
      await expect(waitForProductPage(browser, 100)).rejects.toThrow("Timeout");
      const disconnected = expect(
        waitForProductPage(browser, 5000)
      ).rejects.toThrow("closed");
      await browser.close();
      await disconnected;
    } finally {
      await browser?.close().catch(() => undefined);
      if (child && child.exitCode === null && child.signalCode === null) {
        await fs.writeFile(quit, "quit");
        if (
          (await Promise.race([
            closed.then(() => true),
            delay(5000, false),
          ])) === false
        ) {
          child.kill();
          await closed;
        }
      }
      runtime.cleanup();
    }
  },
  30_000
);
