import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import electronPath from "electron";

const projectRoot = path.resolve(import.meta.dirname, "..");

function findPackagedResources() {
  const outDir = path.join(projectRoot, "out");
  if (!fs.existsSync(outDir)) {
    throw new Error(`Packaged output directory does not exist: ${outDir}`);
  }
  const candidates = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(outDir, entry.name, "resources"))
    .filter((resourcesPath) =>
      fs.existsSync(
        path.join(
          resourcesPath,
          "app.asar.unpacked",
          "scripts",
          "embed-worker.mjs"
        )
      )
    )
    .map((resourcesPath) => ({
      mtimeMs: fs.statSync(resourcesPath).mtimeMs,
      resourcesPath,
    }))
    .sort((left, right) => right.mtimeMs - left.mtimeMs);
  const resourcesPath = candidates[0]?.resourcesPath;
  if (!resourcesPath) {
    throw new Error(
      `No packaged resources with the production worker scripts found under ${outDir}`
    );
  }
  return resourcesPath;
}

function parsePackagedResources() {
  const args = process.argv.slice(2);
  const pathIndex = args.indexOf("--packaged-resources");
  if (pathIndex >= 0) {
    const requestedPath = args[pathIndex + 1];
    if (!requestedPath) {
      throw new Error("--packaged-resources requires a path");
    }
    return path.resolve(requestedPath);
  }
  return args.includes("--packaged") ? findPackagedResources() : undefined;
}

const packagedResources = parsePackagedResources();
const vitestPath = path.join(
  projectRoot,
  "node_modules",
  "vitest",
  "vitest.mjs"
);
const result = spawnSync(
  electronPath,
  [vitestPath, "run", "--config", "vitest.worker-smoke.config.ts"],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      AIM_WORKER_SMOKE_RESOURCES: packagedResources ?? "",
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: "inherit",
  }
);

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
