import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const NODE_22_VERSION_RE = /^v22\./u;
const CHECKED_FILES_RE = /Checked (\d+) files/u;
const CHECK_DIAGNOSTIC_RE = /^[^\s].*?\s+(format|lint\/[^\s]+)/u;
const DIAGNOSTICS_NOT_SHOWN_RE = /Diagnostics not shown: (\d+)/u;
const ERROR_COUNT_RE = /Found (\d+) errors?/u;
const HELP_ARGS = new Set(["--help", "-h"]);
const LINE_SPLIT_RE = /\r?\n/gu;
const WARNING_COUNT_RE = /Found (\d+) warnings?/u;
const phase2Entries = [
  "package.json",
  "scripts/bench-embedding.mjs",
  "scripts/evaluate-semantic-quality.mjs",
  "scripts/run-ai-index-stress.mjs",
  "scripts/run-phase2-isolated-validation.mjs",
  "scripts/run-siglip-v1-baseline.mjs",
  "scripts/run-worker-smoke.mjs",
  "scripts/siglip-v1-baseline",
  "scripts/summarize-siglip-v1-baseline.mjs",
  "src/services/ai/embedder.ts",
  "src/services/ai/health.ts",
  "src/services/ai/model-fingerprint.ts",
  "src/services/ai/search.ts",
  "src/services/ai/text-worker-client.ts",
  "src/services/ai/vector-db.ts",
  "src/services/embed-worker-pool.ts",
  "src/tests/integration/ai-vector-store-compatibility.test.ts",
  "src/tests/integration/ai-worker-pool-recovery.test.ts",
  "src/tests/integration/siglip-worker-smoke.test.ts",
  "src/tests/unit/ai-index-stress.test.mjs",
  "src/tests/unit/embed-worker-pool.test.ts",
  "src/tests/unit/text-worker-client.test.ts",
  "src/tests/unit/vector-compatibility-guards.test.ts",
  "src/tests/unit/vector-fingerprint-compatibility.test.ts",
  "vitest.ai-integration.config.ts",
  "vitest.worker-smoke.config.ts",
];
const validationCommands = {
  check: ["run", "check"],
  package: ["run", "package"],
  test: ["test"],
  "worker-smoke": ["run", "test:worker-smoke"],
  "worker-smoke:packaged": ["run", "test:worker-smoke:packaged"],
};

function parseArgs() {
  const args = process.argv.slice(2);
  const help = args.some((arg) => HELP_ARGS.has(arg));
  const validationArgs = args.filter((arg) => !HELP_ARGS.has(arg));
  let commandList = "test,check,package,worker-smoke:packaged";
  let nodePath = process.env.AIM_NODE22;
  let outputRoot;
  for (let index = 0; index < validationArgs.length; index += 1) {
    const arg = validationArgs[index];
    if (arg === "--node" || arg === "--commands" || arg === "--output") {
      const value = validationArgs[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      if (arg === "--node") {
        nodePath = value;
      } else if (arg === "--commands") {
        commandList = value;
      } else {
        outputRoot = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  const requestedCommands = commandList
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const command of requestedCommands) {
    if (!(command in validationCommands)) {
      throw new Error(`Unknown validation command: ${command}`);
    }
  }
  return {
    commands: requestedCommands,
    help,
    nodePath,
    outputRoot,
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-phase2-isolated-validation.mjs [options]

Options:
  --node <path>       Node 22 executable (or set AIM_NODE22)
  --commands <list>   Comma-separated: test,check,package,worker-smoke,worker-smoke:packaged
  --output <path>     New directory for the isolated clone and JSON report
  -h, --help          Show this help without creating or running anything

Default commands: test,check,package,worker-smoke:packaged`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? projectRoot,
    encoding: options.encoding,
    env: options.env ?? process.env,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
  });
  if (result.error) {
    throw result.error;
  }
  if (options.allowFailure !== true && result.status !== 0) {
    const details = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${String(result.status)}${details ? `\n${details}` : ""}`
    );
  }
  return result;
}

function findNode22(requestedPath) {
  const candidates = [
    requestedPath,
    path.join(
      projectRoot,
      "reports",
      ".tools",
      "node-v22.23.2-win-x64",
      "node.exe"
    ),
  ].filter(Boolean);
  for (const candidate of candidates) {
    const nodePath = path.resolve(candidate);
    if (!fs.existsSync(nodePath)) {
      continue;
    }
    const versionResult = run(nodePath, ["--version"], {
      allowFailure: true,
      encoding: "utf8",
    });
    const version = versionResult.stdout?.trim() ?? "";
    if (versionResult.status === 0 && NODE_22_VERSION_RE.test(version)) {
      return { nodePath, version };
    }
  }
  throw new Error(
    "Node 22 was not found. Set AIM_NODE22 or pass --node <absolute-node.exe>."
  );
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function copyPhase2Entry(relativePath, repositoryPath) {
  const sourcePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Required phase-2 path is missing: ${relativePath}`);
  }
  const destinationPath = path.join(repositoryPath, relativePath);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, destinationPath, { recursive: true });
  } else {
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function linkSharedDirectory(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    throw new Error(`Shared validation dependency is missing: ${sourcePath}`);
  }
  if (fs.existsSync(destinationPath)) {
    throw new Error(
      `Refusing to replace existing validation path: ${destinationPath}`
    );
  }
  fs.symlinkSync(
    sourcePath,
    destinationPath,
    process.platform === "win32" ? "junction" : "dir"
  );
}

function isAllowedPhase2Path(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/");
  return phase2Entries.some((entry) => {
    const allowed = entry.replaceAll("\\", "/");
    return normalized === allowed || normalized.startsWith(`${allowed}/`);
  });
}

function getChangedPaths(repositoryPath) {
  const result = run(
    "git",
    ["-C", repositoryPath, "status", "--porcelain=v1", "-z"],
    { encoding: "utf8" }
  );
  return (result.stdout ?? "")
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3))
    .map((entry) => entry.split(" -> ").at(-1));
}

function createIsolatedRepository(runRoot, runtimeLogPath) {
  const repositoryPath = path.join(runRoot, "repo");
  const commit = run("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).stdout.trim();
  run(
    "git",
    [
      "-c",
      `safe.directory=${projectRoot}`,
      "-c",
      `safe.directory=${path.join(projectRoot, ".git")}`,
      "-c",
      "core.autocrlf=false",
      "clone",
      "--no-hardlinks",
      "--no-checkout",
      "--quiet",
      projectRoot,
      repositoryPath,
    ],
    { stdio: "inherit" }
  );
  run("git", ["-C", repositoryPath, "config", "core.autocrlf", "false"]);
  run(
    "git",
    ["-C", repositoryPath, "checkout", "--detach", "--quiet", commit],
    { stdio: "inherit" }
  );
  for (const entry of phase2Entries) {
    copyPhase2Entry(entry, repositoryPath);
  }
  linkSharedDirectory(
    path.join(projectRoot, "node_modules"),
    path.join(repositoryPath, "node_modules")
  );
  linkSharedDirectory(
    path.join(projectRoot, "models"),
    path.join(repositoryPath, "models")
  );
  linkSharedDirectory(runtimeLogPath, path.join(repositoryPath, "logs"));
  const changedPaths = getChangedPaths(repositoryPath);
  const unexpectedPaths = changedPaths.filter(
    (relativePath) => !isAllowedPhase2Path(relativePath)
  );
  if (unexpectedPaths.length > 0) {
    throw new Error(
      `Isolation copied non-phase-2 changes:\n${unexpectedPaths.join("\n")}`
    );
  }
  return { changedPaths, commit, repositoryPath };
}

function parseCheckDiagnostics(stdout, stderr) {
  const findCount = (pattern) => {
    const match = stdout.match(pattern);
    return match ? Number.parseInt(match[1], 10) : null;
  };
  const visibleRules = {};
  for (const line of stderr.split(LINE_SPLIT_RE)) {
    const match = line.match(CHECK_DIAGNOSTIC_RE);
    if (match) {
      visibleRules[match[1]] = (visibleRules[match[1]] ?? 0) + 1;
    }
  }
  return {
    checkedFiles: findCount(CHECKED_FILES_RE),
    diagnosticsNotShown: findCount(DIAGNOSTICS_NOT_SHOWN_RE),
    errors: findCount(ERROR_COUNT_RE),
    visibleRules,
    warnings: findCount(WARNING_COUNT_RE),
  };
}

function runValidationCommand(
  name,
  nodePath,
  npmCliPath,
  repositoryPath,
  environment,
  runRoot
) {
  const startedAt = Date.now();
  console.log(
    `\n[phase2-validation] npm ${validationCommands[name].join(" ")}`
  );
  const result = run(nodePath, [npmCliPath, ...validationCommands[name]], {
    allowFailure: true,
    cwd: repositoryPath,
    encoding: "utf8",
    env: environment,
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const outputPath = path.join(runRoot, `${name.replaceAll(":", "-")}.log`);
  fs.writeFileSync(
    outputPath,
    `[stdout]\n${stdout}\n[stderr]\n${stderr}`,
    "utf8"
  );
  const summarize = (value) => {
    const lines = value.split(/\r?\n/gu).filter(Boolean);
    return {
      lineCount: lines.length,
      tail: lines.slice(-20),
    };
  };
  const exitCode = result.status ?? 1;
  console.log(
    `[phase2-validation] ${name}: exit ${String(exitCode)}, log ${outputPath}`
  );
  return {
    diagnostics:
      name === "check" ? parseCheckDiagnostics(stdout, stderr) : undefined,
    durationMs: Date.now() - startedAt,
    exitCode,
    name,
    output: {
      logPath: outputPath,
      stderr: summarize(stderr),
      stdout: summarize(stdout),
    },
  };
}

function main() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }
  const { nodePath, version } = findNode22(options.nodePath);
  const npmCliPath = path.join(
    path.dirname(nodePath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js"
  );
  if (!fs.existsSync(npmCliPath)) {
    throw new Error(`Node 22 npm CLI is missing: ${npmCliPath}`);
  }

  const timestamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runRoot = path.resolve(
    options.outputRoot ??
      path.join(projectRoot, "reports", "phase2-validation", timestamp)
  );
  if (fs.existsSync(runRoot)) {
    throw new Error(
      `Refusing to overwrite existing validation run: ${runRoot}`
    );
  }
  fs.mkdirSync(runRoot, { recursive: true });

  const runtimeLogPath = path.join(
    projectRoot,
    "logs",
    "phase2-validation",
    timestamp
  );
  if (fs.existsSync(runtimeLogPath)) {
    throw new Error(
      `Refusing to reuse existing validation logs: ${runtimeLogPath}`
    );
  }
  fs.mkdirSync(runtimeLogPath, { recursive: true });
  const { changedPaths, commit, repositoryPath } = createIsolatedRepository(
    runRoot,
    runtimeLogPath
  );
  const diffCheck = run("git", ["-C", repositoryPath, "diff", "--check"], {
    allowFailure: true,
    encoding: "utf8",
  });
  const environment = {
    ...process.env,
    AIM_NODE22: nodePath,
    PATH: `${path.dirname(nodePath)}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const results = options.commands.map((name) =>
    runValidationCommand(
      name,
      nodePath,
      npmCliPath,
      repositoryPath,
      environment,
      runRoot
    )
  );
  const report = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    source: {
      commit,
      projectRoot,
      phase2Paths: changedPaths,
    },
    isolation: {
      repositoryPath,
      runtimeLogPath,
      sharedModels: path.join(projectRoot, "models"),
      sharedNodeModules: path.join(projectRoot, "node_modules"),
    },
    runtime: {
      launcherNode: process.version,
      nodePath,
      nodeSha256: sha256File(nodePath),
      nodeVersion: version,
      npmCliPath,
      testRuntimeNote:
        "npm test intentionally delegates Vitest to Electron RUN_AS_NODE for native-module ABI compatibility.",
    },
    checks: {
      diffCheck: {
        exitCode: diffCheck.status ?? 1,
        stderr: diffCheck.stderr?.trim() ?? "",
        stdout: diffCheck.stdout?.trim() ?? "",
      },
      commands: results,
    },
  };
  const reportPath = path.join(runRoot, "validation-report.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`\n[phase2-validation] report: ${reportPath}`);
  console.log(`[phase2-validation] isolated repo: ${repositoryPath}`);

  if (
    diffCheck.status !== 0 ||
    results.some((result) => result.exitCode !== 0)
  ) {
    process.exitCode = 1;
  }
}

main();
