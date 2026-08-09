import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const playwrightCli = path.join(
  projectRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js"
);

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return false;
  }
  return true;
}

function prepareModels() {
  const modelsDir = path.join(projectRoot, "models");
  const downloader = `
    import { downloadAllModels } from "./src/services/model-downloader.ts";
    const result = await downloadAllModels(
      ${JSON.stringify(modelsDir)},
      ${JSON.stringify(process.env.AIM_MODEL_MIRROR || "https://huggingface.co")}
    );
    if (!result.success) {
      console.error(result.warnings.join("\\n"));
      process.exitCode = 1;
    }
  `;
  return run(process.execPath, [
    "--loader",
    "ts-node/esm",
    "--input-type=module",
    "--eval",
    downloader,
  ]);
}

const args = process.argv.slice(2);
const noBuild = args[0] === "--no-build";
const playwrightArgs = noBuild ? args.slice(1) : args;

if (process.env.AIM_E2E_PREPARE_MODELS === "1" && !prepareModels()) {
  process.exit(process.exitCode ?? 1);
}

if (!(noBuild || run(npmCommand, ["run", "package"]))) {
  process.exit(process.exitCode ?? 1);
}

if (!fs.existsSync(playwrightCli)) {
  throw new Error(`Playwright CLI is missing: ${playwrightCli}`);
}

run(process.execPath, [playwrightCli, "test", ...playwrightArgs]);
