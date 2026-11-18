import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = "https://github.com/Uyoung666/ai-image-manager";
const stableTag = /^v\d+\.\d+\.\d+$/;

export function run(command, args, { cwd, env = process.env, capture } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} exited with ${result.status ?? result.signal}`
    );
  }
  return result.stdout?.trim();
}

function node(...args) {
  run(process.execPath, args);
}

function npm(...args) {
  if (!process.env.npm_execpath) {
    throw new Error("Use npm run ci:verify or npm run verify:push");
  }
  node(process.env.npm_execpath, ...args);
}

export async function resolveLocaleBaseline() {
  const response = await fetch(`${repository}/releases/latest`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
  });
  await response.body?.cancel();
  const location = response.headers.get("location");
  const tag =
    location &&
    new URL(location, repository).href.replace(
      `${repository}/releases/tag/`,
      ""
    );
  if (response.status !== 302 || !tag || !stableTag.test(tag)) {
    throw new Error("Cannot resolve the latest formal GitHub Release tag");
  }
  return tag;
}

const groups = {
  "install-check": () => npm("ci", "--ignore-scripts"),
  "install-runtime": () => npm("ci"),
  static: () => {
    npm("run", "check");
    node("node_modules/typescript/bin/tsc", "--noEmit");
    node(
      "node_modules/vitest/vitest.mjs",
      "run",
      "src/tests/unit/release-workflow.test.mjs",
      "src/tests/unit/update-welcome-decision.test.ts",
      "-t",
      "stable release workflow gates|shows bundled current release notes"
    );
  },
  locale: async () => {
    const baseline =
      process.env.LOCALE_BASELINE_REF || (await resolveLocaleBaseline());
    const tag = run(
      "git",
      ["rev-parse", "--verify", `refs/tags/${baseline}^{commit}`],
      {
        capture: true,
      }
    );
    console.log(`Locale baseline: ${baseline} (${tag})`);
    node("scripts/locale-release.mjs", "check", "--baseline", baseline);
  },
  unit: () => {
    node("--loader", "ts-node/esm", "scripts/prepare-models.mjs");
    npm("test");
    npm("run", "test:ai-integration");
    npm("run", "test:worker");
  },
  face: () => {
    process.env.AIM_MODEL_SCOPE = "face";
    node("--loader", "ts-node/esm", "scripts/prepare-models.mjs");
    process.env.ELECTRON_RUN_AS_NODE = "1";
    run(path.resolve("node_modules/electron/dist/electron.exe"), [
      "--test",
      "src/tests/unit/face-data-migration.test.mjs",
    ]);
  },
  e2e: () => {
    npm(
      "exec",
      "--no",
      "--",
      "playwright",
      "install",
      "chromium",
      "--with-deps"
    );
    process.env.AIM_E2E_PREPARE_MODELS = "1";
    npm("run", "test:e2e");
    node("scripts/release/parallel.mjs", "packaged-library");
  },
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const group = process.argv[2];
  try {
    if (process.platform !== "win32" || !process.version.startsWith("v22.")) {
      throw new Error("CI verification requires Windows and Node 22");
    }
    if (!Object.hasOwn(groups, group)) {
      throw new Error(`Expected a CI group: ${Object.keys(groups).join(", ")}`);
    }
    await groups[group]();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
