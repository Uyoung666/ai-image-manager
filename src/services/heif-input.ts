import path from "node:path";
import { app } from "electron";
import { isHeifInput } from "../../scripts/heif-decoder.mjs";
import { createHeifResolver } from "../../scripts/heif-input.mjs";
import { trackChildProcess } from "./tracked-child-processes";

let resolver: ReturnType<typeof createHeifResolver> | undefined;
export async function resolveHeifInput(
  input: string | Buffer
): Promise<string | Buffer> {
  if (!(await isHeifInput(input))) {
    return input;
  }
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
  return resolver.resolveInput(input);
}

export function stopHeifDecoder(): void {
  resolver?.stop();
  resolver = undefined;
}
