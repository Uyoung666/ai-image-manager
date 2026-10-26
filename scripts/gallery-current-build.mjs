/** Freeze the current production bundles without a checkout or dependency copy. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const target = path.join(root, ".cache", `gallery-density-build-${Date.now()}`);
fs.mkdirSync(target, { recursive: true });
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const names = execFileSync(
  "git",
  [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    "src",
    "scripts",
    "drizzle",
    "package.json",
    "package-lock.json",
    "*.mts",
    "tsconfig.json",
    "index.html",
  ],
  { cwd: root, encoding: "utf8" }
)
  .split("\0")
  .filter(Boolean);
const files = [...new Set(names)].sort().map((name) => ({
  path: name,
  sha256: createHash("sha256")
    .update(fs.readFileSync(path.join(root, name)))
    .digest("hex"),
}));
const sourceTreeHash = createHash("sha256")
  .update(JSON.stringify(files))
  .digest("hex");
const sourceDiffHash = createHash("sha256")
  .update(
    execFileSync("git", ["diff", "--", "src", "scripts", "drizzle"], {
      cwd: root,
    })
  )
  .digest("hex");
fs.writeFileSync(
  path.join(target, "source-files.json"),
  JSON.stringify(
    { sourceRoot: root, sourceCommit, sourceTreeHash, sourceDiffHash, files },
    null,
    2
  )
);
fs.copyFileSync(
  path.join(root, "package.json"),
  path.join(target, "package.json")
);
for (const name of ["node_modules", "resources"]) {
  fs.symlinkSync(path.join(root, name), path.join(target, name), "junction");
}
fs.cpSync(path.join(root, ".vite/build"), path.join(target, ".vite/build"), {
  recursive: true,
});
await build({
  root,
  configFile: path.join(root, "vite.main.config.mts"),
  resolve: {
    conditions: ["node"],
    mainFields: ["module", "jsnext:main", "jsnext"],
  },
  define: {
    MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
    MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
  },
  build: {
    target: "node22",
    outDir: path.join(target, ".vite/build"),
    emptyOutDir: false,
  },
});
await build({
  root,
  configFile: path.join(root, "vite.preload.config.mts"),
  build: {
    outDir: path.join(target, ".vite/build"),
    emptyOutDir: false,
    lib: {
      entry: path.join(root, "src/preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
  },
});
await build({
  root,
  base: "./",
  configFile: path.join(root, "vite.renderer.config.mts"),
  build: { outDir: path.join(target, ".vite/renderer/main_window") },
});
fs.writeFileSync(
  path.join(target, "gallery-build.json"),
  JSON.stringify(
    {
      revision: sourceCommit,
      sourceTreeHash,
      kind: "working-tree",
      builtAt: new Date().toISOString(),
    },
    null,
    2
  )
);
console.log(`Gallery current build: ${target}`);
