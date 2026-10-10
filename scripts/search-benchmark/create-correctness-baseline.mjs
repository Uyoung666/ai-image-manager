/** Same correctness and model inputs; restore full vector and detail reads. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  copyRuntimeSources,
  hashRuntimeSourceTree,
  runtimeSourceFiles,
} from "./source-snapshot.mjs";

const VECTOR_SELECT_RE =
  / {4}if \(vq.select\) \{\s*vq = vq.select\(\["photo_id"\]\);\s*\}/;
const COMBINED_RE =
  /^(\s*)const combined = rerankedList\.flatMap\(\(result\) => \{/m;
const PHOTO_RE = /const photo = scopeById\.get\(result\.photoId\);/;
const BASELINE_NAME_RE = /^[a-z0-9-]+$/i;

function replaceRequired(source, expression, replacement, label) {
  const result = source.replace(expression, replacement);
  if (result === source) {
    throw new Error(`Baseline reconstruction could not locate ${label}`);
  }
  return result;
}

export function reconstructCorrectnessSources(search, handler) {
  const reconstructedSearch = replaceRequired(
    search,
    VECTOR_SELECT_RE,
    "",
    "vector projection"
  );
  const reconstructedHandler = replaceRequired(
    handler,
    COMBINED_RE,
    (
      _match,
      indent
    ) => `${indent}const details = db.select(SEARCH_PHOTO_COLUMNS).from(photos).where(and(isNull(photos.deletedAt), sql\`\${photos.id} IN (SELECT CAST(value AS INTEGER) FROM json_each(\${JSON.stringify(rerankedList.map(row => row.photoId))}))\`)).all();
${indent}const detailsById = new Map(details.map(row => [row.id, row]));
${indent}const combined = rerankedList.flatMap((result) => {`,
    "candidate detail reads"
  );
  return {
    search: reconstructedSearch,
    handler: replaceRequired(
      reconstructedHandler,
      PHOTO_RE,
      "const photo = detailsById.get(result.photoId);",
      "candidate detail lookup"
    ),
  };
}

export function createCorrectnessBaseline(repo, destination, sourceRoot) {
  if (!BASELINE_NAME_RE.test(destination)) {
    throw new Error("Use a simple baseline directory name");
  }
  const runtimeRoot = path.dirname(sourceRoot);
  const targetRoot = path.join(
    repo,
    "reports/search-optimization",
    destination
  );
  fs.mkdirSync(targetRoot, { recursive: false });
  copyRuntimeSources(runtimeRoot, targetRoot);
  const files = ["services/ai/search.ts", "ipc/photos/handlers/search.ts"];
  const read = (file) =>
    fs
      .readFileSync(path.join(targetRoot, "src", file), "utf8")
      .replaceAll("\r\n", "\n");
  const reconstructed = reconstructCorrectnessSources(
    read(files[0]),
    read(files[1])
  );
  fs.writeFileSync(
    path.join(targetRoot, "src", files[0]),
    reconstructed.search
  );
  fs.writeFileSync(
    path.join(targetRoot, "src", files[1]),
    reconstructed.handler
  );
  const metadata = {
    schemaVersion: 2,
    kind: "reconstructed-correctness-only",
    createdAt: new Date().toISOString(),
    sourceTreeHash: hashRuntimeSourceTree(targetRoot),
    sourceTreeBeforeHash: hashRuntimeSourceTree(runtimeRoot),
    comparison:
      "same query planning, single-text encoding, bounded scoring, cancellation and image preprocessing; full ANN vector and candidate detail reads",
    files: files.map((file) => ({
      file,
      sha256: createHash("sha256")
        .update(fs.readFileSync(path.join(targetRoot, "src", file)))
        .digest("hex"),
    })),
    runtimeFiles: runtimeSourceFiles(targetRoot),
  };
  fs.writeFileSync(
    path.join(targetRoot, "baseline.json"),
    JSON.stringify(metadata, null, 2)
  );
  fs.writeFileSync(
    path.join(targetRoot, "source.json"),
    JSON.stringify(metadata, null, 2)
  );
  return path.join(targetRoot, "src");
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const repo = path.resolve(import.meta.dirname, "../..");
  const sourceIndex = process.argv.indexOf("--source");
  const sourceRoot = path.resolve(
    sourceIndex < 0 ? path.join(repo, "src") : process.argv[sourceIndex + 1]
  );
  fs.mkdirSync(path.join(repo, "reports/search-optimization"), {
    recursive: true,
  });
  console.log(
    createCorrectnessBaseline(
      repo,
      process.argv[2] ?? `correctness-baseline-${Date.now()}`,
      sourceRoot
    )
  );
}
