/** Build an instrumented Git revision without changing the working checkout. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { build } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const revision = execFileSync("git", ["rev-parse", process.argv[2] ?? "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const target = path.join(
  root,
  ".cache",
  `gallery-baseline-${revision.slice(0, 8)}-${Date.now()}`
);
fs.mkdirSync(target, { recursive: true });
const archive = path.join(target, "source.tar");
execFileSync(
  "git",
  ["archive", "--format=tar", `--output=${archive}`, revision],
  { cwd: root }
);
execFileSync("tar", ["-xf", archive, "-C", target]);
fs.symlinkSync(
  path.join(root, "node_modules"),
  path.join(target, "node_modules"),
  "junction"
);
// Preserve packaged native-worker entry points; Vite replaces the referenced app bundles below.
fs.cpSync(path.join(root, ".vite/build"), path.join(target, ".vite/build"), {
  recursive: true,
});
const replace = (file, before, after) => {
  const destination = path.join(target, file);
  const source = fs.readFileSync(destination, "utf8");
  if (!source.includes(before)) {
    throw new Error(`Unsupported baseline instrumentation seam: ${file}`);
  }
  fs.writeFileSync(destination, source.replace(before, after));
};
for (const file of ["src/utils/gallery-perf.ts", "src/renderer.ts"]) {
  fs.copyFileSync(path.join(root, file), path.join(target, file));
}
replace(
  "src/main.ts",
  "additionalArguments: [",
  "additionalArguments: [...(process.env.AIM_GALLERY_PERF === '1' ? ['--gallery-perf'] : []),"
);
replace(
  "src/preload.ts",
  "preloadReady: true,",
  "preloadReady: true, galleryPerfEnabled: process.argv.includes('--gallery-perf'),"
);
replace(
  "src/components/MasonryGrid.tsx",
  'import { recordGalleryPerf } from "@/utils/gallery-perf";',
  'import { recordGalleryPerf,startGalleryPerfProbe } from "@/utils/gallery-perf";'
);
replace(
  "src/components/MasonryGrid.tsx",
  "const scrollRef = useRef<HTMLDivElement>(null);",
  "const scrollRef = useRef<HTMLDivElement>(null); useEffect(()=>scrollRef.current ? startGalleryPerfProbe(scrollRef.current) : undefined,[]);"
);
process.chdir(target);
await build({
  root: target,
  configFile: path.join(target, "vite.main.config.mts"),
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
  root: target,
  configFile: path.join(target, "vite.preload.config.mts"),
  build: {
    outDir: path.join(target, ".vite/build"),
    emptyOutDir: false,
    lib: {
      entry: path.join(target, "src/preload.ts"),
      formats: ["cjs"],
      fileName: () => "preload.js",
    },
  },
});
await build({
  root: target,
  base: "./",
  configFile: path.join(target, "vite.renderer.config.mts"),
  resolve: {
    alias:
      process.env.AIM_GALLERY_PROFILE_BUILD === "1"
        ? { "react-dom/client": "react-dom/profiling" }
        : {},
  },
  build: { outDir: path.join(target, ".vite/renderer/main_window") },
});
fs.writeFileSync(
  path.join(target, "gallery-build.json"),
  JSON.stringify(
    {
      revision,
      kind: "baseline",
      profiling: process.env.AIM_GALLERY_PROFILE_BUILD === "1",
      instrumentation: [
        "src/main.ts",
        "src/preload.ts",
        "src/utils/gallery-perf.ts",
        "src/components/MasonryGrid.tsx",
        "src/renderer.ts",
      ],
      builtAt: new Date().toISOString(),
    },
    null,
    2
  )
);
console.log(`Baseline build: ${target}`);
