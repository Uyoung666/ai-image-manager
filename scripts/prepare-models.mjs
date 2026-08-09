import path from "node:path";
import process from "node:process";
import { downloadAllModels } from "../src/services/model-downloader.ts";

const modelsDir = path.resolve(
  process.env.AIM_MODELS_DIR || path.join(import.meta.dirname, "..", "models")
);
const mirror = process.env.AIM_MODEL_MIRROR || "https://huggingface.co";
const scope = process.env.AIM_MODEL_SCOPE
  ? process.env.AIM_MODEL_SCOPE.split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  : undefined;
const result = await downloadAllModels(
  modelsDir,
  mirror,
  undefined,
  undefined,
  scope ? { subPaths: scope } : undefined
);

if (!result.success) {
  console.error(result.warnings.join("\n"));
  process.exitCode = 1;
}
