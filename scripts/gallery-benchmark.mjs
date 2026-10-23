/** Isolated gallery benchmark. Run with --experimental-strip-types on Node 22. */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire,
} from "@electron/fuses";
import { _electron as electron } from "@playwright/test";
import electronPath from "electron";
import sharp from "sharp";
import { TestRuntime } from "../src/tests/helpers/test-runtime.ts";

const PHOTO_LABEL = /photo-(\d+)\.webp$/;
const MANAGED_PREVIEW =
  /^(?:[a-f0-9]{32}\.(?:webp|jpg)|g-[a-f0-9]{32}-[a-f0-9]{32}-(?:256|512|1024|2048)\.webp)$/i;

const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const count = Number(option("count", "10000"));
const runs = Number(option("runs", "5"));
const seconds = Number(option("seconds", "15"));
const width = Number(option("width", "1280"));
const height = Number(option("height", "800"));
const dpr = Number(option("dpr", "1"));
const cache = option("cache", "browser-cold");
const label = option("scenario", "gallery");
const appPath = path.resolve(option("app", "."));
const packagedExecutable = option("executable", "");
let executable = packagedExecutable
  ? path.resolve(packagedExecutable)
  : electronPath;
let view = option("view", "home");
const pattern = option("pattern", "scroll");
const trace = option("trace", "0") === "1";
const anchor = Number(option("anchor", "0"));
const gate = option("gate", "");
const measureEntry = option("entry-metric", "0") === "1";
const albumKind = option("album-kind", "ordinary");
if (
  ![count, runs, seconds, width, height, dpr].every(
    (value) => Number.isFinite(value) && value > 0
  ) ||
  count > 100_000 ||
  !Number.isInteger(anchor) ||
  anchor < 0 ||
  anchor > count ||
  !["browser-cold", "warm", "missing", "corrupt"].includes(cache) ||
  !["home", "album", "both"].includes(view) ||
  !["ordinary", "smart"].includes(albumKind) ||
  !["scroll", "deep"].includes(pattern)
) {
  throw new Error("Invalid benchmark options");
}
const reportDir = path.resolve("reports/gallery", `${label}-${Date.now()}`);
fs.mkdirSync(reportDir, { recursive: true });
const runtime = new TestRuntime("gallery-benchmark");
const root = runtime.root;
const profile = path.join(root, "profile");
const env = {
  ...process.env,
  CI: "e2e",
  AIM_GALLERY_PERF: "1",
  AI_IMAGE_MANAGER_E2E_USER_DATA_DIR: profile,
  AI_IMAGE_MANAGER_USER_DATA_DIR: profile,
};
env.ELECTRON_RUN_AS_NODE = undefined;
const isolation = path.join(root, "isolation.cjs");
fs.writeFileSync(
  isolation,
  "const {app}=require('electron');const fs=require('node:fs');const path=require('node:path');for(const [key,part] of Object.entries({appData:'appdata',cache:'cache',userData:'profile',sessionData:'profile',temp:'scratch',logs:'logs',crashDumps:'crashes'})){const p=path.join(__dirname,part);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);}"
);
let active;
let bundleHash;
let sourceCommit;
let sourceDiffHash;
let sourceTreeHash;
let packagedInstrumentation;
let fixtureSource;

function cloneClosedFixture() {
  const requested = option("reuse-fixture", "");
  if (!requested) {
    return false;
  }
  const source = path.resolve(requested);
  if (
    path.dirname(source) !== path.resolve(".test-runtime") ||
    !path.basename(source).startsWith("gallery-benchmark-")
  ) {
    throw new Error("Fixture must be a managed gallery benchmark directory");
  }
  const marker = JSON.parse(
    fs.readFileSync(path.join(source, ".aim-test-runtime.json"), "utf8")
  );
  if (
    marker.owner !== "gallery-benchmark" ||
    marker.launchPending ||
    marker.childPids.length > 0
  ) {
    throw new Error("Fixture is still active or has a different owner");
  }
  const database = path.join(source, "profile/data/ai-image-manager.db");
  if (
    fs.existsSync(`${database}-wal`) &&
    fs.statSync(`${database}-wal`).size > 0
  ) {
    throw new Error("Fixture database has an uncheckpointed WAL");
  }
  fs.copyFileSync(database, path.join(profile, "data/ai-image-manager.db"));
  const thumbnails = path.join(source, "profile/thumbnails");
  fs.cpSync(thumbnails, path.join(profile, "thumbnails"), {
    recursive: true,
    preserveTimestamps: true,
    filter: (file) =>
      file === thumbnails || MANAGED_PREVIEW.test(path.basename(file)),
  });
  fixtureSource = source;
  console.log(`Reused closed synthetic fixture: ${source}`);
  return true;
}

function getBuildKind() {
  if (!packagedExecutable) {
    return "production-bundle";
  }
  return packagedInstrumentation ? "packaged-inspection" : "packaged";
}

function getEntryDefinition() {
  if (!measureEntry) {
    return null;
  }
  return view === "home"
    ? "home toolbar committed to first viewport 80% ready"
    : "album route navigation to first viewport 80% ready";
}

async function preparePackagedInspection() {
  if (!(packagedExecutable && option("instrument-executable", "1") === "1")) {
    return;
  }
  const productionExecutable = executable;
  const directory = path.join(root, "packaged-inspection");
  fs.cpSync(path.dirname(productionExecutable), directory, {
    recursive: true,
    filter: (source) =>
      !(
        ["temp"].includes(path.basename(source).toLowerCase()) ||
        [".csv", ".xlsx"].includes(path.extname(source).toLowerCase())
      ),
  });
  executable = path.join(directory, path.basename(productionExecutable));
  const hash = (file) =>
    crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const productionHash = hash(productionExecutable);
  const before = await getCurrentFuseWire(executable);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
  });
  const after = await getCurrentFuseWire(executable);
  for (const key of Object.keys(before)) {
    if (
      key !== String(FuseV1Options.EnableNodeCliInspectArguments) &&
      before[key] !== after[key]
    ) {
      throw new Error(`Unexpected verification fuse change: ${key}`);
    }
  }
  const archiveHash = hash(
    path.join(path.dirname(productionExecutable), "resources/app.asar")
  );
  if (archiveHash !== hash(path.join(directory, "resources/app.asar"))) {
    throw new Error("Verification archive differs from the production archive");
  }
  packagedInstrumentation = {
    productionExecutable,
    productionHash,
    verificationHash: hash(executable),
    before,
    after,
    archiveHash,
    change: "EnableNodeCliInspectArguments on isolated copy only",
  };
  if (hash(productionExecutable) !== productionHash) {
    throw new Error("Production executable changed during instrumentation");
  }
}
function fingerprintBuild() {
  const buildHash = crypto.createHash("sha256");
  if (packagedExecutable) {
    return buildHash
      .update(
        fs.readFileSync(
          path.join(path.dirname(executable), "resources/app.asar")
        )
      )
      .digest("hex");
  }
  for (const directory of [".vite/build", ".vite/renderer/main_window"]) {
    const base = path.join(appPath, directory);
    if (!fs.existsSync(base)) {
      continue;
    }
    for (const file of fs
      .readdirSync(base, { recursive: true })
      .filter((name) => name.endsWith(".js"))
      .sort()) {
      buildHash.update(file).update(fs.readFileSync(path.join(base, file)));
    }
  }
  return buildHash.digest("hex");
}
async function launch() {
  runtime.setLaunchPending();
  active = await electron.launch({
    executablePath: executable,
    args: [
      "-r",
      isolation,
      `--force-device-scale-factor=${dpr}`,
      "--e2e",
      ...(packagedExecutable ? [] : [appPath]),
    ],
    env,
  });
  runtime.trackProcess(active.process());
  active
    .process()
    .stderr?.on("data", (data) =>
      fs.appendFileSync(path.join(root, "electron.log"), data)
    );
  return active;
}
async function close() {
  const app = active;
  active = undefined;
  if (app) {
    const child = app.process();
    const exited =
      child.exitCode === null
        ? new Promise((resolve) => child.once("exit", resolve))
        : Promise.resolve();
    await app.close();
    await exited;
  }
}
async function seed() {
  const fixture = path.join(root, "images");
  const thumbs = path.join(profile, "thumbnails");
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(thumbs, { recursive: true });
  const rows = [];
  let next = 1;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next <= count) {
        const id = next++;
        const w = [256, 384, 512][id % 3];
        const h = Math.round(w / [0.2, 0.6, 0.8, 1, 1.5, 2.5, 6][id % 7]);
        const color = ((id * 2_654_435_761) % 4_294_967_296)
          .toString(16)
          .padStart(8, "0")
          .slice(0, 6);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g"><stop stop-color="#${color}"/><stop offset="1" stop-color="#${color.split("").reverse().join("")}"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="${id % w}" cy="${(id * 7) % h}" r="${20 + (id % 80)}" fill="white"/><path d="M0 ${id % h}L${w} ${(id * 11) % h}" stroke="black" stroke-width="3"/></svg>`;
        const data = await sharp(Buffer.from(svg))
          .webp({ quality: 85, effort: 1 })
          .toBuffer();
        const source = path.join(fixture, `photo-${id}.webp`);
        const hash = crypto
          .createHash("md5")
          .update(`${source}_md_v4_${Math.ceil(dpr)}`)
          .digest("hex");
        const thumbnail = path.join(thumbs, `${hash}.webp`);
        await fs.promises.writeFile(source, data);
        if (!(cache === "missing" && id % 20 === 0)) {
          await fs.promises.writeFile(
            thumbnail,
            cache === "corrupt" && id % 100 === 0 ? "broken" : data
          );
        }
        rows.push([
          id,
          source,
          thumbnail,
          data.length,
          id % 89 === 0 ? 0 : w,
          id % 89 === 0 ? 0 : h,
        ]);
        if (id % 10_000 === 0) {
          console.log(`Seeded ${id}/${count} unique images`);
        }
      }
    })
  );
  const script = path.join(root, "seed.cjs");
  fs.writeFileSync(
    script,
    `const fs=require('node:fs');const D=require(${JSON.stringify(path.resolve("node_modules/better-sqlite3"))});const input=JSON.parse(fs.readFileSync(0,'utf8'));const d=new D(process.argv[2]);try{d.pragma('foreign_keys=ON');d.transaction(()=>{d.prepare('INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,?,?,?,1)').run(input.folder,'Gallery benchmark',input.rows.length);d.prepare("INSERT INTO albums(id,name,created_at) VALUES(1,'Gallery benchmark',1)").run();const p=d.prepare("INSERT INTO photos(id,path,filename,folder_id,file_size,file_date,width,height,format,thumbnail_path,is_indexed,is_ai_processed,is_face_processed,created_at) VALUES(?,?,?,1,?,?,?,?,'webp',?,1,1,1,1)");const a=d.prepare('INSERT INTO album_photos(album_id,photo_id,sort_order) VALUES(1,?,?)');for(const [id,source,thumb,bytes,w,h] of input.rows){p.run(id,source,'photo-'+id+'.webp',bytes,1800000000000-id*3600000,w,h,thumb);a.run(id,id);}})();}finally{d.close();}`
  );
  execFileSync(
    electronPath,
    [script, path.join(profile, "data/ai-image-manager.db")],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
      input: JSON.stringify({ folder: fixture, rows }),
    }
  );
}
async function sample(run) {
  const diskCacheFilesBefore = fs.readdirSync(
    path.join(profile, "thumbnails")
  ).length;
  const app = await launch();
  const page = await app.firstWindow();
  await app.evaluate(
    ({ BrowserWindow }, size) =>
      BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
    { width, height }
  );
  await page.addInitScript(
    (anchorId) => {
      localStorage.setItem("lang", "en");
      localStorage.setItem("sidebar_collapsed", "true");
      if (anchorId > 0) {
        const timestamp = Date.now();
        sessionStorage.setItem(
          "scroll_position_home-all-date-desc",
          JSON.stringify({
            scrollTop: 1000,
            timestamp,
            anchor: {
              itemId: anchorId,
              estimatedGlobalIndex: anchorId - 1,
              offsetFromTop: 0,
              offsetRatio: 0,
              timestamp,
            },
          })
        );
      }
    },
    view === "home" ? anchor : 0
  );
  if (measureEntry) {
    await page.addInitScript((currentView) => {
      let frame = 0;
      window.__galleryStartEntryMeasure = () => {
        cancelAnimationFrame(frame);
        const startedAt = performance.now();
        window.__galleryEntryMetric = { startedAt };
        const sampleEntry = (now) => {
          if (window.__galleryPerf?.firstViewport80Ms?.count > 0) {
            const elapsed = now - startedAt;
            window.__galleryEntryMetric.elapsedMs = elapsed;
            window.__galleryPerf.entryFirstViewport80Ms = {
              count: 1,
              total: elapsed,
              max: elapsed,
              samples: [elapsed],
            };
          } else {
            frame = requestAnimationFrame(sampleEntry);
          }
        };
        frame = requestAnimationFrame(sampleEntry);
      };
      if (currentView !== "home") {
        return;
      }
      const observer = new MutationObserver(() => {
        if (document.querySelector(".home-gallery-toolbar-layer")) {
          observer.disconnect();
          window.__galleryStartEntryMeasure();
        }
      });
      observer.observe(document, { childList: true, subtree: true });
    }, view);
  }
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  if (cache !== "warm") {
    await cdp.send("Network.clearBrowserCache");
  }
  const cachePrime = await primeBrowserCache(page);
  if (trace && (run === 1 || run === runs + 1)) {
    await app.evaluate(({ contentTracing }) =>
      contentTracing.startRecording({
        included_categories: ["devtools.timeline", "blink.user_timing", "v8"],
      })
    );
  }
  const cpuProfile = await startCpuProfile(app, cdp, run);
  await page.reload();
  if (view === "album") {
    await page.waitForFunction(
      () => typeof window.__e2eNavigate === "function"
    );
    await page.evaluate(async () => {
      window.__galleryPerf = {};
      window.__galleryStartEntryMeasure?.();
      await window.__e2eNavigate("/albums/1");
    });
  }
  await page.waitForSelector("[data-masonry-scroll]", { timeout: 30_000 });
  await page.waitForFunction(
    () => window.__galleryPerf?.firstViewport80Ms?.count > 0
  );
  if (measureEntry) {
    await page.waitForFunction(
      () => window.__galleryPerf?.entryFirstViewport80Ms?.count > 0
    );
  }
  await stopCpuProfile(app, cdp, cpuProfile);
  const memoryBefore = await cdp.send("Runtime.getHeapUsage");
  const processMemoryBefore = await app.evaluate(
    ({ app: host, BrowserWindow }) =>
      host
        .getAppMetrics()
        .find(
          (metric) =>
            metric.pid ===
            BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
        )?.memory ?? null
  );
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await page.locator("[data-masonry-scroll]").evaluate(
      (element, { progress, pattern }) => {
        if (pattern === "deep") {
          const fraction =
            progress < 0.8 ? progress / 0.8 : 1 - (progress - 0.8) / 0.2;
          element.scrollTop =
            Math.max(0, element.scrollHeight - element.clientHeight) * fraction;
        } else {
          element.scrollTop +=
            (progress > 0.8 ? -1 : 1) *
            Math.max(600, element.clientHeight * 1.4);
        }
      },
      { progress: (Date.now() - started) / (seconds * 1000), pattern }
    );
    await page.waitForTimeout(120);
  }
  await page.waitForTimeout(180);
  await page.waitForFunction(
    () => {
      const surface = document.querySelector("[data-masonry-scroll]");
      if (!(surface && window.__galleryPerf?.scrollStop95Ms?.count > 0)) {
        return false;
      }
      const bounds = surface.getBoundingClientRect();
      const cards = [...surface.querySelectorAll("[data-photo-id]")].filter(
        (card) => {
          const rect = card.getBoundingClientRect();
          return (
            !card.querySelector("[data-photo-id]") &&
            rect.width > 0 &&
            rect.bottom > bounds.top &&
            rect.top < bounds.bottom
          );
        }
      );
      return (
        cards.length > 0 &&
        cards.filter((card) => {
          const image = card.querySelector("img");
          return (
            image?.complete &&
            image.naturalWidth > 0 &&
            image.dataset.loadState !== "loading"
          );
        }).length /
          cards.length >=
          0.95
      );
    },
    undefined,
    { timeout: 15_000 }
  );
  const memoryAfter = await cdp.send("Runtime.getHeapUsage");
  const processMemoryAfter = await app.evaluate(
    ({ app: host, BrowserWindow }) =>
      host
        .getAppMetrics()
        .find(
          (metric) =>
            metric.pid ===
            BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
        )?.memory ?? null
  );
  const snapshot = await page.evaluate(() => ({
    galleryPerf: window.__galleryPerf ?? {},
    viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio },
    loaded: document.querySelectorAll(
      '[data-photo-id] img[data-load-state="loaded"]'
    ).length,
  }));
  const workerUrls = page.workers().map((worker) => worker.url());
  if (
    snapshot.galleryPerf.masonryWorkerMs?.count > 0 &&
    workerUrls.length === 0
  ) {
    throw new Error(
      "Large layout has no live dedicated worker; inspect fallback diagnostics"
    );
  }
  if (trace && (run === 1 || run === runs + 1)) {
    await app.evaluate(
      ({ contentTracing }, output) => contentTracing.stopRecording(output),
      path.join(reportDir, `trace-${view}.json`)
    );
  }
  fs.writeFileSync(
    path.join(reportDir, `probe-${run}.json`),
    JSON.stringify(snapshot, null, 2)
  );
  await page.screenshot({ path: path.join(reportDir, `probe-${run}.png`) });
  if (
    !(
      snapshot.loaded &&
      snapshot.galleryPerf.frameIntervalMs?.count &&
      snapshot.galleryPerf.scrollStop95Ms?.count
    )
  ) {
    throw new Error(
      "Invalid gallery sample: missing images, frames, or stopped-scroll readiness"
    );
  }
  const media = await app.evaluate(() => globalThis.__galleryMediaStats ?? {});
  const actual = JSON.parse(
    execFileSync(
      electronPath,
      [
        "-e",
        `const D=require(${JSON.stringify(path.resolve("node_modules/better-sqlite3"))});const d=new D(process.argv[1],{readonly:true});try{console.log(JSON.stringify(d.prepare('select count(*) as total from photos where deleted_at is null').get()))}finally{d.close()}`,
        path.join(profile, "data/ai-image-manager.db"),
      ],
      { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
    )
  );
  if (actual.total !== count) {
    throw new Error(`Dataset mismatch: expected ${count}, got ${actual.total}`);
  }
  const result = {
    ...snapshot,
    galleryMediaStats: media,
    scenario: `${label}-${count}-${cache}`,
    run,
    datasetCount: count,
    sourceCommit,
    sourceDiffHash,
    build: appPath,
    bundleHash,
    buildManifest: fs.existsSync(path.join(appPath, "gallery-build.json"))
      ? JSON.parse(
          fs.readFileSync(path.join(appPath, "gallery-build.json"), "utf8")
        )
      : null,
    view,
    albumKind,
    pattern,
    durationSeconds: seconds,
    anchor: view === "home" ? anchor : 0,
    diskCacheFilesBefore,
    memory: { before: memoryBefore, after: memoryAfter },
    processMemory: {
      unit: "KiB",
      before: processMemoryBefore,
      after: processMemoryAfter,
    },
    workerUrls,
    cache,
    cachePrime,
    entryDefinition: getEntryDefinition(),
    fixtureSource,
    generatedAt: new Date().toISOString(),
    buildKind: getBuildKind(),
    packagedInstrumentation,
    profiling: Boolean(snapshot.galleryPerf.reactRenderMs?.count),
    cpuProfiling: cpuProfile !== null,
    runtime: {
      cpu: os.cpus()[0]?.model,
      platform: process.platform,
      node: process.version,
      cores: os.cpus().length,
      totalMemory: os.totalmem(),
      os: os.release(),
    },
  };
  result.electronVersions = await app.evaluate(() => process.versions);
  result.graphics = await app.evaluate(({ app: host }) => ({
    hardwareAcceleration: host.isHardwareAccelerationEnabled(),
    features: host.getGPUFeatureStatus(),
  }));
  result.sourceTreeHash = sourceTreeHash;
  fs.writeFileSync(
    path.join(reportDir, `run-${run}.json`),
    JSON.stringify(result, null, 2)
  );
  await page.screenshot({ path: path.join(reportDir, `run-${run}.png`) });
  await maybeValidateWindowedNavigation(page, run);
  await close();
  return result;
}

async function startCpuProfile(app, cdp, run) {
  if (option("cpu-profile", "0") !== "1" || run !== 1) {
    return null;
  }
  await app.evaluate(async () => {
    const { Session } = process.getBuiltinModule("inspector");
    const session = new Session();
    session.connect();
    globalThis.__galleryCpuSession = session;
    await new Promise((resolve, reject) => {
      session.post("Profiler.enable", (error) =>
        error ? reject(error) : resolve()
      );
    });
    await new Promise((resolve, reject) => {
      session.post("Profiler.start", (error) =>
        error ? reject(error) : resolve()
      );
    });
  });
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.start");
  return run;
}

async function stopCpuProfile(app, cdp, run) {
  if (!run) {
    return;
  }
  const main = await app.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const session = globalThis.__galleryCpuSession;
        session.post("Profiler.stop", (error, result) => {
          session.disconnect();
          globalThis.__galleryCpuSession = undefined;
          if (error) {
            reject(error);
          } else {
            resolve(result.profile);
          }
        });
      })
  );
  const renderer = await cdp.send("Profiler.stop");
  fs.writeFileSync(
    path.join(reportDir, `cpu-main-first-${run}.json`),
    JSON.stringify(main)
  );
  fs.writeFileSync(
    path.join(reportDir, `cpu-renderer-first-${run}.json`),
    JSON.stringify(renderer.profile)
  );
}

function readReadyViewport() {
  const surface = document.querySelector("[data-masonry-scroll]");
  if (!surface) {
    return false;
  }
  const bounds = surface.getBoundingClientRect();
  const cards = [...surface.querySelectorAll("[data-photo-id]")].filter(
    (card) => {
      const rect = card.getBoundingClientRect();
      return (
        !card.querySelector("[data-photo-id]") &&
        rect.width > 0 &&
        rect.bottom > bounds.top &&
        rect.top < bounds.bottom
      );
    }
  );
  if (
    cards.length === 0 ||
    cards.some((card) => {
      const img = card.querySelector("img");
      return !(
        img?.complete &&
        img.naturalWidth > 0 &&
        img.dataset.loadState !== "loading"
      );
    })
  ) {
    return false;
  }
  return {
    ids: cards.map((card) => Number(card.getAttribute("data-photo-id"))),
    top: surface.scrollTop,
    maximum: surface.scrollHeight - surface.clientHeight,
  };
}

async function primeBrowserCache(page) {
  if (cache !== "warm") {
    return { images: 0, elapsedMs: 0 };
  }
  const started = Date.now();
  await page.waitForFunction(() => typeof window.__e2eNavigate === "function");
  if (view === "album") {
    await page.evaluate(() => window.__e2eNavigate("/albums/1"));
  }
  const surface = page.locator("[data-masonry-scroll]");
  await surface.waitFor();
  await surface.evaluate((element) => {
    element.scrollTop = 0;
  });
  const seen = new Set();
  for (let step = 0; step < count + 20; step++) {
    const handle = await page.waitForFunction(readReadyViewport);
    const state = await handle.jsonValue();
    await handle.dispose();
    for (const id of state.ids) {
      seen.add(id);
    }
    if (seen.size >= count) {
      break;
    }
    await surface.evaluate((element) => {
      element.scrollTop += Math.max(1, element.clientHeight * 0.75);
    });
    await page.waitForTimeout(state.top >= state.maximum - 1 ? 150 : 16);
  }
  if (seen.size !== count) {
    throw new Error(`Browser cache priming incomplete: ${seen.size}/${count}`);
  }
  await surface.evaluate((element) => {
    element.scrollTop = 0;
  });
  const ready = await page.waitForFunction(readReadyViewport);
  await ready.dispose();
  return { images: seen.size, elapsedMs: Date.now() - started };
}

async function maybeValidateWindowedNavigation(page, run) {
  if (option("interactions", "0") !== "1" || (run !== 1 && run !== runs + 1)) {
    return;
  }
  const id = await page.locator("[data-masonry-scroll]").evaluate((surface) => {
    const bounds = surface.getBoundingClientRect();
    const card = [
      ...surface.querySelectorAll('[data-photo-id][role="option"]'),
    ].find((element) => {
      const rect = element.getBoundingClientRect();
      return (
        Number(element.getAttribute("data-photo-id")) > 0 &&
        rect.top > bounds.top + 100 &&
        rect.bottom < bounds.bottom - 8
      );
    });
    return Number(card?.getAttribute("data-photo-id"));
  });
  if (!(id > 0)) {
    throw new Error(
      "No fully visible photo for windowed navigation validation"
    );
  }
  const card = page.locator(
    `[data-masonry-scroll] [data-photo-id="${id}"][role="option"]`
  );
  await card.focus();
  const before = await card.evaluate(
    (element) => element.getBoundingClientRect().top
  );
  await card.press("Enter");
  let modal = page.locator(".lightbox-interactive");
  await modal.waitFor();
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page.waitForFunction(
    (photoId) =>
      document.activeElement?.getAttribute("data-photo-id") === String(photoId),
    id
  );
  const after = await card.evaluate(
    (element) => element.getBoundingClientRect().top
  );
  if (Math.abs(after - before) > 2) {
    throw new Error(`Lightbox return anchor moved ${after - before}px`);
  }
  await card.press("Enter");
  modal = page.locator(".lightbox-interactive");
  await modal.waitFor();
  const toggle = modal.getByRole("button", {
    name: "Show/hide thumbnails (T)",
    exact: true,
  });
  if ((await toggle.getAttribute("aria-pressed")) !== "true") {
    await toggle.click();
  }
  const strip = modal.locator("[data-lightbox-thumbnail-strip]");
  const total = await strip.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
    return Math.round(
      Number.parseFloat(element.firstElementChild.style.width) / 104
    );
  });
  await page.waitForFunction(
    (count) =>
      document
        .querySelector("[data-lightbox-thumbnail-strip] button:last-child")
        ?.getAttribute("aria-label")
        ?.startsWith(`${count}: `),
    total
  );
  const target = strip.getByRole("button").last();
  await target.click();
  await page.waitForFunction(() => {
    const value =
      document
        .querySelector("[data-lightbox-thumbnail-strip] button:last-child")
        ?.getAttribute("aria-label") ?? "";
    return value.includes(": photo-") && value.endsWith(".webp");
  });
  const label = await target.getAttribute("aria-label");
  const targetId = Number(label?.match(PHOTO_LABEL)?.[1]);
  if (!(targetId > 0)) {
    throw new Error("Far lightbox target did not hydrate its record");
  }
  await page.evaluate((photoId) => {
    const events = [];
    let previousCard;
    let previousActive;
    let previousTop;
    const record = (event) => {
      const element = document.querySelector(
        `[data-masonry-scroll] [data-photo-id="${photoId}"][role="option"]`
      );
      const active = document.activeElement;
      const top = document.querySelector("[data-masonry-scroll]")?.scrollTop;
      if (
        event !== "mutation" ||
        element !== previousCard ||
        active !== previousActive ||
        top !== previousTop
      ) {
        events.push({
          time: performance.now(),
          event,
          mounted: Boolean(element),
          replaced: Boolean(previousCard && element !== previousCard),
          active: active?.getAttribute("data-photo-id") ?? active?.tagName,
          inert: Boolean(element?.closest("[inert]")),
          top,
        });
      }
      previousCard = element;
      previousActive = active;
      previousTop = top;
    };
    const observer = new MutationObserver(() => record("mutation"));
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["inert"],
    });
    const focus = () => record("focus");
    const scroll = () => record("scroll");
    document.addEventListener("focusin", focus, true);
    document.addEventListener("scroll", scroll, true);
    window.__galleryNavigationDiagnostic = {
      events,
      stop() {
        observer.disconnect();
        document.removeEventListener("focusin", focus, true);
        document.removeEventListener("scroll", scroll, true);
      },
    };
    record("start");
  }, targetId);
  await modal.getByRole("button", { name: "Close", exact: true }).click();
  await page
    .waitForFunction((photoId) => {
      const element = document.querySelector(
        `[data-masonry-scroll] [data-photo-id="${photoId}"][role="option"]`
      );
      const surface = element?.closest("[data-masonry-scroll]");
      if (!(element && surface && document.activeElement === element)) {
        if (window.__galleryNavigationDiagnostic) {
          window.__galleryNavigationDiagnostic.focusedSince = undefined;
        }
        return false;
      }
      const bounds = surface.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      const visible =
        rect.bottom > bounds.top + 100 && rect.top < bounds.bottom;
      const diagnostic = window.__galleryNavigationDiagnostic;
      if (!(visible && diagnostic)) {
        return false;
      }
      diagnostic.focusedSince ??= performance.now();
      return performance.now() - diagnostic.focusedSince >= 250;
    }, targetId)
    .catch(async (error) => {
      const diagnostic = await page.evaluate((photoId) => {
        const element = document.querySelector(
          `[data-masonry-scroll] [data-photo-id="${photoId}"][role="option"]`
        );
        const surface = document.querySelector("[data-masonry-scroll]");
        return {
          targetId: photoId,
          activeId: document.activeElement?.getAttribute("data-photo-id"),
          activeTag: document.activeElement?.tagName,
          hasFocus: document.hasFocus(),
          recentIds: [
            ...document.querySelectorAll(
              '[data-recently-viewed="true"][data-photo-id]'
            ),
          ].map((card) => card.getAttribute("data-photo-id")),
          targetRect: element?.getBoundingClientRect().toJSON(),
          bounds: surface?.getBoundingClientRect().toJSON(),
          scrollTop: surface?.scrollTop,
          knownCount: window.__galleryPerf?.galleryPagedPhotoCount?.max,
          events: window.__galleryNavigationDiagnostic?.events,
        };
      }, targetId);
      fs.writeFileSync(
        path.join(reportDir, `navigation-failure-${run}.json`),
        JSON.stringify({ ...diagnostic, initialId: id, total, label }, null, 2)
      );
      throw error;
    });
  await page.evaluate(() => window.__galleryNavigationDiagnostic?.stop());
  const cacheState = await page.evaluate(() => ({
    pages: window.__galleryPerf.galleryResidentPages?.max,
    photos: window.__galleryPerf.galleryResidentPhotos?.max,
    bytes: window.__galleryPerf.galleryResidentPhotoBytes?.max,
  }));
  if (
    !(
      cacheState.pages <= 20 &&
      cacheState.photos <= 2000 &&
      cacheState.bytes <= 16 * 1024 * 1024
    )
  ) {
    throw new Error("Lightbox navigation exceeded the photo cache budget");
  }
  fs.writeFileSync(
    path.join(reportDir, `navigation-${run}.json`),
    JSON.stringify(
      {
        view,
        from: id,
        target: targetId,
        knownItems: total,
        anchorErrorCssPx: after - before,
        cacheState,
      },
      null,
      2
    )
  );
}
try {
  await preparePackagedInspection();
  await launch();
  await active.firstWindow();
  await close();
  if (!cloneClosedFixture()) {
    await seed();
  }
  execFileSync(
    electronPath,
    [
      "-e",
      `const D=require(${JSON.stringify(path.resolve("node_modules/better-sqlite3"))});const d=new D(process.argv[1]);try{d.prepare('INSERT OR REPLACE INTO app_settings(key,value,updated_at) VALUES(?,?,?)').run('colors_migrated','true',Date.now());if(process.argv[2]==='smart'){d.prepare('UPDATE albums SET is_smart=1,smart_rules=? WHERE id=1').run(JSON.stringify({rules:[{type:'fileFormat',value:'webp'}]}))}}finally{d.close()}`,
      path.join(profile, "data/ai-image-manager.db"),
      albumKind,
    ],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" } }
  );
  const results = [];
  const pauseFile = path.resolve(".cache/gallery-measurements-paused");
  if (option("ignore-pause", "0") !== "1" && fs.existsSync(pauseFile)) {
    fs.writeFileSync(
      path.join(reportDir, "measurement-paused.json"),
      JSON.stringify({ pid: process.pid, at: new Date().toISOString() })
    );
    const deadline = Date.now() + 60 * 60_000;
    while (fs.existsSync(pauseFile)) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for benchmark build coordination");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (gate) {
    const deadline = Date.now() + 60 * 60_000;
    console.log(`Dataset ready; waiting for measurement gate: ${gate}`);
    while (!fs.existsSync(gate)) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for the measurement gate");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  bundleHash = fingerprintBuild();
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  sourceDiffHash = crypto
    .createHash("sha256")
    .update(
      execFileSync("git", ["diff", "--", "src", "scripts", "drizzle"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
    )
    .digest("hex");
  const sourceRoot = fs.existsSync(path.join(appPath, "src"))
    ? appPath
    : path.resolve(import.meta.dirname, "..");
  const names = execFileSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "src",
      "scripts",
      "drizzle",
      "package.json",
      "package-lock.json",
      "*.mts",
      "tsconfig.json",
    ],
    { cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8" }
  )
    .split("\0")
    .filter(Boolean);
  const sourceFiles = [...new Set(names)].sort().flatMap((name) => {
    const file = path.join(sourceRoot, name);
    return fs.existsSync(file)
      ? [
          {
            path: name,
            sha256: crypto
              .createHash("sha256")
              .update(fs.readFileSync(file))
              .digest("hex"),
          },
        ]
      : [];
  });
  sourceTreeHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(sourceFiles))
    .digest("hex");
  fs.writeFileSync(
    path.join(reportDir, "source-files.json"),
    JSON.stringify({ sourceRoot, sourceTreeHash, files: sourceFiles }, null, 2)
  );
  for (const currentView of view === "both" ? ["home", "album"] : [view]) {
    view = currentView;
    const viewResults = [];
    for (let run = 1; run <= runs; run++) {
      const result = await sample(results.length + 1);
      viewResults.push(result);
      results.push(result);
      console.log(`Gallery sample ${currentView} ${run}/${runs}: ${reportDir}`);
    }
    fs.writeFileSync(
      path.join(reportDir, `summary-${view}.json`),
      JSON.stringify({ count, cache, results: viewResults }, null, 2)
    );
  }
  fs.writeFileSync(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ count, cache, results }, null, 2)
  );
  runtime.saveDiagnostics(path.join(reportDir, "diagnostics"));
  fs.writeFileSync(
    path.join(reportDir, "cleanup.json"),
    JSON.stringify(runtime.cleanup())
  );
  console.log(`Gallery benchmark complete: ${reportDir}`);
} catch (error) {
  if (active) {
    try {
      await active.evaluate(
        ({ contentTracing }, destination) =>
          contentTracing.stopRecording(destination),
        path.join(reportDir, "failure-trace.json")
      );
    } catch {
      /* Recording may not have started. */
    }
    try {
      await active.windows()[0]?.screenshot({
        path: path.join(reportDir, "failure.png"),
        timeout: 5000,
      });
    } catch {
      /* A startup failure may have no surviving renderer. */
    }
  }
  await close();
  runtime.retain();
  runtime.saveDiagnostics(path.join(reportDir, "diagnostics"));
  fs.writeFileSync(
    path.join(reportDir, "failure.json"),
    JSON.stringify({ message: String(error), root }, null, 2)
  );
  throw error;
}
