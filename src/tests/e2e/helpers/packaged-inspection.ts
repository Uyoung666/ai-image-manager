import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire,
} from "@electron/fuses";
import { expect } from "@playwright/test";

export async function preparePackagedExecutable(
  root: string,
  evidence: string
) {
  const requested = process.env.AIM_PACKAGED_E2E_EXECUTABLE;
  if (!requested) {
    return undefined;
  }
  const production = path.resolve(requested);
  const destination = path.join(root, "packaged-inspection");
  const hash = (file: string) =>
    createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const productionHash = hash(production);
  fs.cpSync(path.dirname(production), destination, {
    recursive: true,
    filter: (source) =>
      path.basename(source).toLowerCase() !== "temp" &&
      ![".csv", ".xlsx"].includes(path.extname(source).toLowerCase()),
  });
  const executable = path.join(destination, path.basename(production));
  const before = await getCurrentFuseWire(executable);
  await flipFuses(executable, {
    version: FuseVersion.V1,
    [FuseV1Options.EnableNodeCliInspectArguments]: true,
  });
  const after = await getCurrentFuseWire(executable);
  for (const key of Object.keys(before)) {
    if (key !== String(FuseV1Options.EnableNodeCliInspectArguments)) {
      expect(after[key as keyof typeof after]).toBe(
        before[key as keyof typeof before]
      );
    }
  }
  const archiveHash = hash(
    path.join(path.dirname(production), "resources/app.asar")
  );
  expect(hash(path.join(destination, "resources/app.asar"))).toBe(archiveHash);
  expect(hash(production)).toBe(productionHash);
  fs.writeFileSync(
    path.join(evidence, "packaged-inspection.json"),
    JSON.stringify({ production, productionHash, archiveHash, before, after })
  );
  return executable;
}
