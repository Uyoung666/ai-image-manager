// Removes the nested @xenova/transformers/node_modules/sharp directory.
//
// Why: @xenova/transformers ships with `sharp ^0.32.0` as a regular dep,
// which npm installs into `@xenova/transformers/node_modules/sharp` because
// our top-level sharp is 0.34.x (incompatible major). The nested copy comes
// with prebuilt native binaries for a stale Node ABI; electron-rebuild only
// rebuilds the top-level sharp, so the nested binary fails to load in
// packaged Electron with "specified module could not be found".
//
// Removing the nested sharp lets `import sharp from 'sharp'` inside
// transformers/src/utils/image.js resolve to the top-level sharp@0.34
// (which IS rebuilt for the Electron Node ABI).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const nestedSharp = path.join(
  repoRoot,
  "node_modules",
  "@xenova",
  "transformers",
  "node_modules",
  "sharp"
);

if (fs.existsSync(nestedSharp)) {
  fs.rmSync(nestedSharp, { recursive: true, force: true });
  console.log(
    "[postinstall-cleanup] Removed nested @xenova/transformers/node_modules/sharp"
  );
} else {
  console.log("[postinstall-cleanup] No nested sharp found, nothing to do");
}
