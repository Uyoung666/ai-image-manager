import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { expect } from "@playwright/test";
import sharp from "sharp";
import type { SearchResponse } from "@/types/photo";
import type { SearchDiagnostics } from "@/types/search-diagnostics";
// @ts-expect-error The fingerprint helper intentionally remains plain Node ESM.
import { hashRuntimeSourceTree } from "../../../scripts/search-benchmark/source-snapshot.mjs";
import { createTestRuntime, launchTestApp, test } from "./helpers/test-runtime";

const electron = createRequire(import.meta.url)("electron") as string;
const benchmarkProfile = process.env.AIM_SEARCH_BENCHMARK_PROFILE;
const traceWrites = process.env.AIM_SEARCH_TRACE_WRITES === "1";
// Executed as Node in a separate Electron process; it writes only this fixture.
const seedProfileScript = `
const Database = require("better-sqlite3");
const db = new Database(process.argv[1]);
try {
  db.exec(require("node:fs").readFileSync(0, "utf8"));
  if (process.argv[2] === "1") {
    db.exec("CREATE TABLE search_benchmark_writes (table_name TEXT, operation TEXT, at TEXT)");
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND sql NOT LIKE 'CREATE VIRTUAL%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%fts%' AND name != 'search_benchmark_writes'").all();
    for (const table of tables) {
      const name = table.name.replaceAll('"', '""');
      const literal = table.name.replaceAll("'", "''");
      for (const operation of ["INSERT", "UPDATE", "DELETE"]) {
        db.exec('CREATE TRIGGER "benchmark_' + name + '_' + operation + '" AFTER ' + operation + ' ON "' + name + '" BEGIN INSERT INTO search_benchmark_writes VALUES (' + "'" + literal + "','" + operation + "',strftime('%Y-%m-%dT%H:%M:%fZ','now')); END");
      }
    }
  }
} finally {
  db.close();
}
`;
type ChainMeasurement = SearchDiagnostics &
  Pick<SearchResponse, "completion" | "incompleteReason"> & { query: string };

test("real semantic search records encoding, vector, IPC and gallery paint together", async () => {
  test.skip(
    !benchmarkProfile,
    "Requires a completed isolated search benchmark profile"
  );
  test.setTimeout(300_000);
  const source = fs.realpathSync(benchmarkProfile as string);
  expect(
    source.startsWith(path.resolve("reports/search-optimization") + path.sep)
  ).toBe(true);
  const sourceReport = JSON.parse(
    fs.readFileSync(path.join(source, "../report.json"), "utf8")
  );
  expect(sourceReport.scope).toBe("production-api-real-images");
  const root = createTestRuntime("search-semantic-chain");
  const applicationRoot = path.resolve(
    process.env.AIM_SEARCH_APPLICATION_ROOT ?? "."
  );
  const applicationSource = path.resolve(
    process.env.AIM_SEARCH_APPLICATION_SOURCE ?? "src"
  );
  const profile = path.join(root, "profile");
  fs.cpSync(source, profile, { recursive: true });
  const fixture = path.join(root, "images");
  fs.mkdirSync(fixture);
  const thumbnails = path.join(profile, "thumbnails");
  fs.mkdirSync(thumbnails, { recursive: true });
  const thumbnailUpdates: string[] = [];
  const manifest = JSON.parse(
    fs.readFileSync("audit/tag-benchmark-v2/manifest.v2.json", "utf8")
  );
  for (const sample of manifest.samples.filter(
    (row: { split: string }) => row.split === sourceReport.split
  )) {
    const image = path.join(fixture, `${sample.id}.jpg`);
    fs.copyFileSync(sample.filePath, image);
    for (const [size, pixels] of [
      ["md", 512],
      ["sm", 256],
    ] as const) {
      // Match getThumbnailPath's v4 generation at the forced 1x display scale.
      const hash = createHash("md5")
        .update(`${image}_${size}_v4_1`)
        .digest("hex");
      const thumbnail = path.join(thumbnails, `${hash}.webp`);
      await sharp(image)
        .rotate()
        .resize(pixels, pixels, { fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85, effort: 1 })
        .toFile(thumbnail);
      if (size === "md") {
        thumbnailUpdates.push(
          `UPDATE photos SET thumbnail_path='${thumbnail.replaceAll("'", "''")}' WHERE filename='${sample.id}.jpg';`
        );
      }
    }
  }
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
  // Valid preexisting thumbnail paths keep steady-state scenes separate from
  // background work while measuring the steady-state path.
  const fixturePrefix = (fixture + path.sep).replaceAll("'", "''");
  const sql = `INSERT INTO folders(id,path,display_name,photo_count,created_at,is_watching) VALUES(1,'${fixture.replaceAll("'", "''")}','Semantic fixture',160,1,0); UPDATE photos SET folder_id=1,path='${fixturePrefix}' || filename; ${thumbnailUpdates.join("\n")}`;
  execFileSync(
    electron,
    [
      "-e",
      seedProfileScript,
      path.join(profile, "data/ai-image-manager.db"),
      traceWrites ? "1" : "0",
    ],
    { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, input: sql }
  );
  const app = await launchTestApp(root, {
    cwd: applicationRoot,
    args: [
      "-r",
      preload,
      "--e2e",
      "--force-device-scale-factor=1",
      applicationRoot,
    ],
    env,
  });
  try {
    const page = await app.firstWindow();
    const input = page.locator("input.home-search-input");
    await input.waitFor();
    await page.evaluate(() => {
      const measurements: ChainMeasurement[] = [];
      Object.assign(window, { semanticChainMeasurements: measurements });
      window.addEventListener("photo-search-diagnostics", (event) =>
        measurements.push((event as CustomEvent<ChainMeasurement>).detail)
      );
    });
    let peakAppWorkingSetKB = 0;
    const coldStart = [] as ChainMeasurement[];
    await input.fill("海边照片");
    await input.press("Enter");
    const readings = () =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              semanticChainMeasurements: ChainMeasurement[];
            }
          ).semanticChainMeasurements
      );
    await expect
      .poll(async () => (await readings()).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    coldStart.push(...(await readings()));
    const backgroundStarted = performance.now();
    // Startup enriches real files after 5s/8s. Wait for actual completion rather
    // than including those metadata writes in steady-state cache measurements.
    await expect
      .poll(
        () =>
          app.evaluate(({ app: instance }) => {
            const state = globalThis as unknown as {
              searchBenchmarkReadiness?: {
                db: import("better-sqlite3").Database;
                stablePolls: number;
                version: number;
              };
            };
            const require = process
              .getBuiltinModule("module")
              .createRequire(`${instance.getAppPath()}/package.json`);
            const Database = require("better-sqlite3");
            state.searchBenchmarkReadiness ??= {
              db: new Database(
                require("node:path").join(
                  instance.getPath("userData"),
                  "data/ai-image-manager.db"
                ),
                { readonly: true }
              ),
              stablePolls: 0,
              version: -1,
            };
            const readiness = state.searchBenchmarkReadiness;
            const { db } = readiness;
            const version = db.pragma("data_version", {
              simple: true,
            }) as number;
            const exif = db
              .prepare(
                "SELECT COUNT(*) AS count FROM advanced_exif_data WHERE status NOT IN ('pending','processing')"
              )
              .get() as { count: number };
            const colors = db
              .prepare(
                "SELECT value FROM app_settings WHERE key='colors_migrated'"
              )
              .get() as { value: string } | undefined;
            readiness.stablePolls =
              exif.count === 160 &&
              colors?.value === "true" &&
              readiness.version === version
                ? readiness.stablePolls + 1
                : 0;
            readiness.version = version;
            return readiness.stablePolls >= 2;
          }),
        { timeout: 120_000, intervals: [1000] }
      )
      .toBe(true);
    await app.evaluate(() => {
      const state = globalThis as unknown as {
        searchBenchmarkReadiness?: { db: import("better-sqlite3").Database };
      };
      state.searchBenchmarkReadiness?.db.close();
      state.searchBenchmarkReadiness = undefined;
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    );
    const backgroundPreparationMs = performance.now() - backgroundStarted;
    const scenarios: Record<string, ChainMeasurement[]> = {};
    for (const scenario of [
      "warm-new-query",
      "cache-hit",
      "continuous-switch",
    ]) {
      scenarios[scenario] = [];
      if (scenario === "cache-hit") {
        const before = (await readings()).length;
        await input.fill("a flower");
        await input.press("Enter");
        await expect
          .poll(async () => (await readings()).length, { timeout: 15_000 })
          .toBeGreaterThan(before);
      }
      for (let round = 0; round < 3; round++) {
        for (let index = 0; index < 30; index++) {
          const before = (await readings()).length;
          const query =
            scenario === "cache-hit"
              ? "a flower"
              : `${["a photo of", "a detailed photo of", "an image of"][round]} ${["a flower", "a dog", "a tree", "a building", "a person", "food"][index % 6]} ${["near a window", "at night", "under sunlight", "on a street", "on a table"][Math.floor(index / 6)]}${scenario === "continuous-switch" ? " outdoors" : ""}`;
          if (scenario === "continuous-switch") {
            await input.fill(`replaced scene ${round} ${index}`);
            await input.press("Enter");
          }
          await input.fill(query);
          await input.press("Enter");
          await expect
            .poll(
              async () =>
                (await readings())
                  .slice(before)
                  .some((row) => row.query === query),
              { timeout: 15_000 }
            )
            .toBe(true);
          scenarios[scenario].push(
            (await readings())
              .slice(before)
              .find((row) => row.query === query) as ChainMeasurement
          );
          const workingSet = await app.evaluate(({ app: instance }) =>
            instance
              .getAppMetrics()
              .reduce((sum, row) => sum + row.memory.workingSetSize, 0)
          );
          peakAppWorkingSetKB = Math.max(peakAppWorkingSetKB, workingSet);
        }
      }
    }
    const diagnostics = await readings();
    const databaseWrites = traceWrites
      ? JSON.parse(
          execFileSync(
            electron,
            [
              "-e",
              "const D=require('better-sqlite3');const d=new D(process.argv[1],{readonly:true});try{console.log(JSON.stringify(d.prepare('SELECT table_name,operation,COUNT(*) AS count FROM search_benchmark_writes GROUP BY table_name,operation').all()))}finally{d.close()}",
              path.join(profile, "data/ai-image-manager.db"),
            ],
            { env: { ...env, ELECTRON_RUN_AS_NODE: "1" }, encoding: "utf8" }
          )
        )
      : null;
    expect(
      diagnostics.some(
        (row) =>
          row.timings.textEncodingMs !== null &&
          row.timings.vectorMs !== null &&
          row.timings.ipcMs !== null &&
          row.timings.firstPaintMs !== null
      )
    ).toBe(true);
    fs.writeFileSync(
      test.info().outputPath("semantic-chain-report.json"),
      JSON.stringify(
        {
          fixtureSourceHash: sourceReport.sourceHash,
          fixtureRuntimeSourceHash: sourceReport.sourceTreeHash,
          applicationRuntimeSourceHash: hashRuntimeSourceTree(
            path.dirname(applicationSource)
          ),
          applicationSourceHash: createHash("sha256")
            .update(
              [
                "ipc/photos/handlers/search.ts",
                "services/ai/search.ts",
                "services/query-rewrite.ts",
                "services/ai/semantic-query-plan.ts",
                "services/ai/scoring.ts",
                "services/search-control.ts",
                "services/search-revision.ts",
              ]
                .map((file) =>
                  fs.readFileSync(path.join(applicationSource, file), "utf8")
                )
                .join("\n")
            )
            .digest("hex"),
          coldStart,
          backgroundPreparationMs,
          backgroundPreparation:
            "startup color migration and advanced EXIF enrichment completed before steady-state scenes; cold measurement precedes this wait",
          databaseWrites,
          measurementScope: traceWrites
            ? "write-traced diagnostic run; extra triggers, exclude from performance comparisons"
            : "untraced performance run",
          diagnostics,
          scenarios,
          peakAppWorkingSetKB,
          memoryScope:
            "sum of processes reported by Electron app.getAppMetrics sampled after each search; unreported child processes excluded",
          firstPaintDefinition:
            "gallery React commit plus two animation frames; image decode not required",
          thumbnailPreparation:
            "preexisting v4 md/sm WebP thumbnails at forced 1x scale; original source images copied, avoiding thumbnail repair writes during steady-state timing",
        },
        null,
        2
      )
    );
    for (const rows of Object.values(scenarios)) {
      expect(rows.every((row) => row.completion === "complete")).toBe(true);
    }
    expect(scenarios["cache-hit"].every((row) => row.cacheHit)).toBe(true);
  } finally {
    await app.close();
  }
});
