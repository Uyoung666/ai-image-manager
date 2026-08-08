// Backward-compatible entry for the historical embedding benchmark.
//
// Existing positional usage remains valid:
//   node scripts/bench-embedding.mjs [image-or-directory] [count]
//
// New baseline options can also be passed through directly:
//   node scripts/bench-embedding.mjs --dataset-root <dir> --model-root <dir>

import path from "node:path";
import { runSiglipV1Baseline } from "./run-siglip-v1-baseline.mjs";

const argv = process.argv.slice(2);
const usesNamedOptions = argv.length === 0 || argv[0].startsWith("--");
const translatedArguments = usesNamedOptions
  ? argv
  : [
      "--mode",
      "performance",
      "--profile",
      "all",
      "--performance-input",
      path.resolve(argv[0]),
      ...(argv[1] ? ["--sample-limit", argv[1]] : []),
    ];

await runSiglipV1Baseline(translatedArguments);
