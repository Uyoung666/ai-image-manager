import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { collectFileRecords } from "./checksums.mjs";

const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = async (file, value) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
};
const manifestName = "release-input.json";

export function testsIn(report) {
  const tests = [];
  function visit(suite) {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests) {
        tests.push({
          key: `${spec.id}:${test.projectName}`,
          file: spec.file,
          title: spec.title,
          status: test.status,
          duration: (test.results ?? []).reduce(
            (total, result) => total + result.duration,
            0
          ),
        });
      }
    }
    for (const child of suite.suites ?? []) {
      visit(child);
    }
  }
  visit(report);
  return tests;
}

// These eight cases already require external fixtures in the serial release suite.
const ALLOWED_SKIPS = new Set([
  "japanese-locale.spec.ts:official signed Japanese package installs, upgrades, survives restart and restores a last good version",
  "packaged-quit-cleanup.spec.ts:packaged quit releases the main process and every worker",
  "search-image-transition.spec.ts:partial text results switch to successful image search in every window size",
  "search-semantic-chain.spec.ts:real semantic search records encoding, vector, IPC and gallery paint together",
  "shooting-projects.spec.ts:displays a real camera RAW and copies its original bytes directly",
  "update-upgrade.spec.ts:production startup from 2.1.0, update errors, sizes and second restart",
  "update-upgrade.spec.ts:production startup from 2.2.0, update errors, sizes and second restart",
  "update-upgrade.spec.ts:fresh packaged launch shows onboarding instead of the upgrade welcome",
]);

export function permittedSkip(test) {
  return ALLOWED_SKIPS.has(`${path.basename(test.file)}:${test.title}`);
}

export function validateReports(expected, reports, identity) {
  if (reports.length !== 4) {
    throw new Error("Expected four E2E reports");
  }
  const wanted = new Set(expected.map((test) => test.key));
  if (!wanted.size || wanted.size !== expected.length) {
    throw new Error("Invalid complete test inventory");
  }
  const seen = new Set();
  const shards = new Set();
  for (const report of reports) {
    if (
      report.buildId !== identity.buildId ||
      report.commit !== identity.commit ||
      report.version !== identity.version ||
      ![1, 2, 3, 4].includes(report.shard) ||
      shards.has(report.shard) ||
      report.status !== "passed"
    ) {
      throw new Error("Invalid shard identity or status");
    }
    shards.add(report.shard);
    for (const test of report.tests) {
      if (!wanted.has(test.key) || seen.has(test.key)) {
        throw new Error("Unexpected or duplicate test");
      }
      seen.add(test.key);
      if (
        !["expected", "flaky", "skipped"].includes(test.status) ||
        (test.status === "skipped" && !permittedSkip(test))
      ) {
        throw new Error(`Unexpected test outcome: ${test.title}`);
      }
    }
  }
  if (seen.size !== wanted.size) {
    throw new Error("Missing tests in E2E reports");
  }
  return {
    tests: seen.size,
    shards: reports.map(({ shard, duration }) => ({ shard, duration })),
  };
}

export async function snapshot(directory, identity) {
  const files = (
    await collectFileRecords(directory, { exclude: new Set([manifestName]) })
  ).map(({ relativePath, sha256, size }) => ({ relativePath, sha256, size }));
  if (!files.length) {
    throw new Error("Empty release input");
  }
  await write(path.join(directory, manifestName), { ...identity, files });
}

export async function verifyInput(directory, identity) {
  const saved = await read(path.join(directory, manifestName));
  for (const key of ["commit", "version", "buildId"]) {
    if (saved[key] !== identity[key]) {
      throw new Error(`Release input identity mismatch: ${key}`);
    }
  }
  const actual = (
    await collectFileRecords(directory, { exclude: new Set([manifestName]) })
  ).map(({ relativePath, sha256, size }) => ({ relativePath, sha256, size }));
  if (JSON.stringify(actual) !== JSON.stringify(saved.files)) {
    throw new Error("Release input checksum mismatch");
  }
}

function playwright(app, args, env = process.env, live = false) {
  const result = spawnSync(
    process.execPath,
    [path.join(app, "node_modules/@playwright/test/cli.js"), "test", ...args],
    {
      cwd: app,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: live ? "inherit" : "pipe",
    }
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`Playwright failed: ${result.stderr}\n${result.stdout}`);
  }
  return result.stdout;
}

const SHARD_NAME = /^release-shard-(\d+)-(\d+)-(\d+)$/;

export async function latestReports(directory, identity, runId) {
  const dirs = await fs.readdir(directory);
  const latest = new Map();
  for (const dir of dirs) {
    const match = SHARD_NAME.exec(dir);
    if (!match || match[1] !== runId) {
      continue;
    }
    const report = await read(path.join(directory, dir, "shard.json")).catch(
      () => null
    );
    if (!report || report.buildId !== identity.buildId) {
      continue;
    }
    const previous = latest.get(report.shard);
    if (!previous || Number(match[3]) > previous.attempt) {
      latest.set(report.shard, { attempt: Number(match[3]), report });
    }
  }
  return [...latest.values()].map(({ report }) => report);
}

async function main() {
  const [operation, appArg = ".", shardArg] = process.argv.slice(2);
  const app = path.resolve(appArg);
  const context = await read(process.env.RELEASE_CONTEXT);
  const identity = {
    commit: context.commit,
    version: context.version,
    buildId: process.env.RELEASE_BUILD_ID,
  };
  if (operation === "stage") {
    const expected = testsIn(
      JSON.parse(playwright(app, ["--list", "--reporter=json"]))
    );
    await write(
      path.join(app, ".vite/release-tests.json"),
      expected.map(({ key, file, title }) => ({ key, file, title }))
    );
    await snapshot(path.join(app, ".vite"), identity);
    const inputs = path.join(app, "release-input");
    await fs.cp(path.join(app, "out/make"), path.join(inputs, "make"), {
      recursive: true,
    });
    if (context.localeRequired) {
      await fs.cp(
        path.join(app, "dist/plugins"),
        path.join(inputs, "plugins"),
        { recursive: true }
      );
    }
    await snapshot(inputs, identity);
  } else if (operation === "test") {
    await verifyInput(path.join(app, ".vite"), identity);
    const shard = Number(shardArg);
    if (![1, 2, 3, 4].includes(shard)) {
      throw new Error("Invalid shard");
    }
    const output = path.join(app, "release-shard");
    await fs.mkdir(output, { recursive: true });
    const started = Date.now();
    playwright(
      app,
      ["--workers=1", `--shard=${shard}/4`, "--reporter=line,json,blob"],
      {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_FILE: path.join(output, "results.json"),
        PLAYWRIGHT_BLOB_OUTPUT_DIR: path.join(output, "blob"),
      },
      true
    );
    const report = await read(path.join(output, "results.json"));
    if (report.errors?.length) {
      throw new Error("E2E report contains errors");
    }
    await write(path.join(output, "shard.json"), {
      ...identity,
      shard,
      status: "passed",
      duration: Date.now() - started,
      tests: testsIn(report),
    });
    console.log(`Shard ${shard}: ${Date.now() - started}ms`);
  } else if (operation === "gate") {
    await verifyInput(path.join(app, ".vite"), identity);
    await verifyInput(path.join(app, "release-input"), identity);
    const reports = await latestReports(
      path.join(app, "shards"),
      identity,
      process.env.GITHUB_RUN_ID
    );
    const summary = validateReports(
      await read(path.join(app, ".vite/release-tests.json")),
      reports,
      identity
    );
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `\nE2E coverage: ${summary.tests} tests, 4 shards.\n\n${summary.shards.map(({ shard, duration }) => `- Shard ${shard}: ${(duration / 60_000).toFixed(2)} min`).join("\n")}\n`
      );
    }
    console.log(JSON.stringify(summary));
  } else {
    throw new Error(`Unknown operation: ${operation}`);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
