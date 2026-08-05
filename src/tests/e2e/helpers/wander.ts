import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import {
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";

const require = createRequire(import.meta.url);

export interface WanderSeedOptions {
  enabled?: boolean;
  photoCount?: number;
}

export interface WanderOverrides {
  idleMs?: number;
  intervalMs?: number;
  roundSize?: number;
}

/**
 * Seeds a fresh library for the app at userDataDir. Runs the standalone seed
 * script through the Electron binary (ELECTRON_RUN_AS_NODE) so better-sqlite3's
 * Electron ABI matches — never import it from the Playwright (system Node) side.
 */
export function seedWanderLibrary(
  userDataDir: string,
  opts: WanderSeedOptions = {}
): void {
  const electronPath = require("electron") as string;
  execFileSync(
    electronPath,
    [
      path.resolve("scripts/e2e-seed-wander.mjs"),
      userDataDir,
      String(opts.enabled ?? false),
      String(opts.photoCount ?? 14),
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: "pipe",
      timeout: 120_000,
    }
  );
}

/** Launches the app the same way example.test.ts does. */
export async function launchWanderApp(
  userDataDir: string
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: [
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--use-angle=swiftshader",
      `--user-data-dir=${userDataDir}`,
      path.resolve("."),
    ],
    env: {
      ...process.env,
      AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: userDataDir,
      CI: "e2e",
    },
    timeout: 30_000,
  });
  return app;
}

/**
 * Injects the wander E2E overrides (and a forced language) into localStorage,
 * then reloads so the freshly mounted provider picks them up. The overrides
 * live only in localStorage; production defaults are used when absent.
 */
export async function setWanderOverrides(
  page: Page,
  overrides: WanderOverrides = {},
  language = "en"
): Promise<void> {
  const entries: Record<string, string> = { lang: language };
  for (const [key, value] of Object.entries(overrides)) {
    entries[`wander.${key}`] = String(value);
  }
  const script = Object.entries(entries)
    .map(
      ([key, value]) =>
        `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});`
    )
    .join("");
  await page.addInitScript(script);
  await page.reload();
}

/** The Playwright window focus is unreliable; force the lifecycle eligible. */
export async function forceWanderEligible(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.postMessage(
      { channel: "wander:lifecycle", eligible: true, reason: "window-focus" },
      "*"
    );
  });
}
