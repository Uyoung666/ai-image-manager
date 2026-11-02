import path from "node:path";
import { app } from "electron";
import { getDataPath } from "@/utils/data-path";
import { isHeifInput } from "../../scripts/heif-decoder.mjs";
import { createHeifResolver } from "../../scripts/heif-input.mjs";
import {
  describeHeifModelCache,
  writeHeifModelCache,
} from "../../scripts/heif-model-cache.mjs";
import { getActiveEmbeddingAdapter } from "./ai/model-adapter";
import { trackChildProcess } from "./tracked-child-processes";

let resolver: ReturnType<typeof createHeifResolver> | undefined;
const importMetrics: Record<string, number> = { files: 0 };
export function getHeifImportMetrics() {
  return { ...importMetrics };
}
function getResolver() {
  resolver ??= createHeifResolver({
    workerPath: path.join(
      app.isPackaged
        ? path.join(process.resourcesPath, "app.asar.unpacked")
        : app.getAppPath(),
      "scripts",
      "heif-worker.mjs"
    ),
    track: trackChildProcess,
  });
  return resolver;
}

export async function prepareHeifImport(input: string, thumbnailSize: number) {
  if (!(await isHeifInput(input))) {
    return null;
  }
  const image = getActiveEmbeddingAdapter().embeddingSpace.image;
  const descriptor = await describeHeifModelCache(
    input,
    image,
    path.join(getDataPath(), "thumbnails")
  );
  const result = await getResolver().resolveResult(input, {
    output: "import",
    image,
    thumbnailSize,
  });
  if (!result) {
    return null;
  }
  await writeHeifModelCache(descriptor, result.modelPng);
  importMetrics.files++;
  for (const [key, value] of Object.entries(result.timings)) {
    importMetrics[key] = (importMetrics[key] ?? 0) + value;
  }
  return result;
}
export async function resolveHeifInput(
  input: string | Buffer
): Promise<string | Buffer> {
  if (!(await isHeifInput(input))) {
    return input;
  }
  return getResolver().resolveInput(input);
}

export function stopHeifDecoder(): void {
  resolver?.stop();
  resolver = undefined;
}
