import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import electronPath from "electron";

const vitestPath = path.resolve("node_modules", "vitest", "vitest.mjs");
const result = spawnSync(electronPath, [vitestPath, ...process.argv.slice(2)], {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
  },
  stdio: "inherit",
});

if (result.error) {
  throw result.error;
}

process.exitCode = result.status ?? 1;
