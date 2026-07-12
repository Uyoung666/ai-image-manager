/**
 * Launch the Electron app, auto-scroll the gallery, collect runtime counters,
 * and generate a gallery performance report.
 *
 * Usage:
 *   npm run perf:gallery:auto
 *   npm run perf:gallery:auto -- --seconds=60 --scenario=10k-fast-scroll
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "@playwright/test";
import { findLatestBuild, parseElectronApp } from "electron-playwright-helpers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const reportDir = path.join(projectRoot, "reports");

function readOption(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function autoScroll(page, seconds) {
  const scrollHandle = await page.$("[data-masonry-scroll]");
  if (!scrollHandle) {
    return "Gallery scroll container was not found; collected counters without auto-scroll.";
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < seconds * 1000) {
    await page.evaluate(() => {
      const el = document.querySelector("[data-masonry-scroll]");
      if (el instanceof HTMLElement) {
        el.scrollTop += Math.max(600, el.clientHeight * 0.85);
      }
    });
    await delay(120);
  }
  return `Auto-scrolled gallery for ${seconds} seconds.`;
}

async function main() {
  const seconds = Math.max(1, Number(readOption("seconds", "30")));
  const scenario = readOption("scenario", `auto-gallery-${seconds}s`);
  fs.mkdirSync(reportDir, { recursive: true });

  let electronApp;
  const notes = [];
  try {
    const latestBuild = findLatestBuild();
    const appInfo = parseElectronApp(latestBuild);
    electronApp = await electron.launch({
      args: [appInfo.main],
      env: {
        ...process.env,
        NODE_ENV: "development",
      },
    });

    const page = await electronApp.firstWindow();
    await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    try {
      await page.waitForSelector("[data-masonry-scroll]", { timeout: 20_000 });
    } catch {
      notes.push(
        "Gallery scroll container did not appear before timeout. The app may have opened onboarding, an empty library, or a non-gallery route."
      );
    }
    notes.push(await autoScroll(page, seconds));

    const galleryPerf = await page.evaluate(() => window.__galleryPerf ?? {});
    const galleryMediaStats = await electronApp.evaluate(
      () => globalThis.__galleryMediaStats ?? {}
    );

    const generatedAt = new Date().toISOString();
    const stamp = generatedAt.replace(/[:.]/g, "-");
    const snapshotPath = path.join(reportDir, `gallery-snapshot-${stamp}.json`);
    fs.writeFileSync(
      snapshotPath,
      `${JSON.stringify(
        {
          galleryMediaStats,
          galleryPerf,
          notes,
          scenario,
        },
        null,
        2
      )}\n`
    );

    console.log(`Wrote ${path.relative(projectRoot, snapshotPath)}`);
    execFileSync(process.execPath, ["scripts/gallery-perf-report.mjs", snapshotPath], {
      cwd: projectRoot,
      stdio: "inherit",
    });
  } finally {
    await electronApp?.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
