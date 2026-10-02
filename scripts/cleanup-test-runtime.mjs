import path from "node:path";

process.chdir(path.resolve(import.meta.dirname, ".."));
const { cleanupStaleRuntimes } = await import(
  "../src/tests/helpers/test-runtime.ts"
);
const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply")) {
  throw new Error("Usage: npm run test:runtime:cleanup -- [--apply]");
}
const apply = args.includes("--apply");
const results = cleanupStaleRuntimes(apply);
console.log(
  JSON.stringify({ mode: apply ? "apply" : "preview", results }, null, 2)
);
process.exitCode = results.some((result) => result.status === "failed") ? 1 : 0;
