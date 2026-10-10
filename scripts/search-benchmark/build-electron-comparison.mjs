/** Build both main-process variants identically without replacing workspace files. */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { build, loadConfigFromFile, mergeConfig } from "vite";
import {
  assertPlainDirectory,
  copyRendererArtifacts,
  fingerprintRendererArtifacts,
  resolveComparisonRendererSources,
} from "./renderer-artifacts.mjs";
import {
  fingerprintModelArtifacts,
  hashRuntimeSourceTree,
  linkSharedModelArtifacts,
} from "./source-snapshot.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const matrixRoot = path.resolve(process.argv[2]);
if (
  !matrixRoot.startsWith(
    path.join(repo, "reports/search-optimization") + path.sep
  )
) {
  throw new Error(
    "Comparison output must stay inside reports/search-optimization"
  );
}
assertPlainDirectory(matrixRoot);
const rendererSources = resolveComparisonRendererSources(
  process.argv.slice(3),
  path.join(repo, ".vite/renderer")
);
const rendererFingerprints = Object.fromEntries(
  Object.entries(rendererSources).map(([variant, directory]) => [
    variant,
    fingerprintRendererArtifacts(directory),
  ])
);
const matrix = JSON.parse(
  fs.readFileSync(path.join(matrixRoot, "matrix.json"), "utf8")
);
const output = path.join(matrixRoot, `electron-comparison-${Date.now()}`);
const loaded = await loadConfigFromFile(
  { command: "build", mode: "production" },
  path.join(matrix.sources.optimized, "../vite.main.config.mts")
);
if (!loaded) {
  throw new Error("Production main-process Vite configuration is missing");
}
const packageInfo = JSON.parse(
  fs.readFileSync(path.join(repo, "package.json"), "utf8")
);
const require = createRequire(import.meta.url);
const { getConfig } = require(
  path.join(
    path.dirname(require.resolve("@electron-forge/plugin-vite")),
    "config/vite.main.config.js"
  )
);
const variants = {};
for (const [variant, source] of Object.entries({
  baseline: matrix.sources.baseline,
  optimized: matrix.sources.optimized,
})) {
  const application = path.join(output, variant);
  await build(
    mergeConfig(
      getConfig(
        {
          root: repo,
          command: "build",
          mode: "production",
          forgeConfig: { renderer: [{ name: "main_window" }] },
          forgeConfigSelf: { entry: path.join(source, "bootstrap.ts") },
        },
        loaded.config
      ),
      {
        configFile: false,
        root: repo,
        mode: "production",
        define: {
          MAIN_WINDOW_VITE_NAME: JSON.stringify("main_window"),
          MAIN_WINDOW_VITE_DEV_SERVER_URL: "undefined",
        },
        resolve: { alias: { "@": source } },
        build: {
          outDir: path.join(application, ".vite/build"),
          emptyOutDir: false,
          lib: { entry: path.join(source, "bootstrap.ts") },
        },
      }
    )
  );
  fs.copyFileSync(
    path.join(repo, ".vite/build/preload.js"),
    path.join(application, ".vite/build/preload.js")
  );
  const rendererArtifacts = copyRendererArtifacts(
    rendererSources[variant],
    path.join(application, ".vite/renderer"),
    rendererFingerprints[variant]
  );
  fs.cpSync(
    path.join(source, "../scripts"),
    path.join(application, "scripts"),
    { recursive: true }
  );
  fs.cpSync(
    path.join(source, "../drizzle"),
    path.join(application, "drizzle"),
    { recursive: true }
  );
  // Preserve each snapshot's configs while sharing identical read-only weights.
  const frozenRuntimeRoot = path.dirname(source);
  linkSharedModelArtifacts(repo, frozenRuntimeRoot);
  const frozenModels = path.join(frozenRuntimeRoot, "models");
  const applicationModels = path.join(application, "models");
  fs.cpSync(frozenModels, applicationModels, {
    recursive: true,
    dereference: true,
    filter: (file) => !file.endsWith(".onnx"),
  });
  linkSharedModelArtifacts(frozenRuntimeRoot, application);
  const frozenRuntimeSourceHash = hashRuntimeSourceTree(frozenRuntimeRoot);
  fs.writeFileSync(
    path.join(application, "runtime-source.json"),
    JSON.stringify({ source, sourceTreeHash: frozenRuntimeSourceHash }, null, 2)
  );
  fs.mkdirSync(path.join(application, "assets"));
  fs.copyFileSync(
    path.join(repo, "assets/icon.png"),
    path.join(application, "assets/icon.png")
  );
  fs.writeFileSync(
    path.join(application, "package.json"),
    JSON.stringify(
      {
        name: packageInfo.name,
        version: packageInfo.version,
        type: "module",
        main: ".vite/build/bootstrap.js",
      },
      null,
      2
    )
  );
  variants[variant] = {
    application,
    source,
    sourceTreeHash: frozenRuntimeSourceHash,
    rendererSource: rendererSources[variant],
    rendererHash: rendererArtifacts.sha256,
    rendererEntryHash: rendererArtifacts.entrySha256,
    rendererArtifacts: rendererArtifacts.files,
    modelResources: applicationModels,
    frozenModelResources: frozenModels,
    modelArtifacts: fingerprintModelArtifacts(application),
  };
}
for (const [variant, directory] of Object.entries(rendererSources)) {
  if (
    fingerprintRendererArtifacts(directory).sha256 !==
    rendererFingerprints[variant].sha256
  ) {
    throw new Error(
      `Renderer input changed during comparison build: ${directory}`
    );
  }
}
const report = {
  createdAt: new Date().toISOString(),
  variants,
  // Preserve the legacy shared entry hash only when both complete trees agree.
  rendererHash:
    variants.baseline.rendererHash === variants.optimized.rendererHash
      ? variants.optimized.rendererEntryHash
      : null,
  rendererMode: process.argv.length > 3 ? "variant-renderers" : "same-renderer",
  buildConfiguration:
    process.argv.length > 3
      ? "Same production Forge Node resolution and Vite main config; baseline uses the specified frozen built renderer, optimized uses the current packaged renderer; all renderer artifacts SHA-verified; isolated output, input sources untouched"
      : "Same production Forge Node resolution and Vite main config, with the same current packaged renderer for both variants; all renderer artifacts SHA-verified; isolated output, input sources untouched",
};
fs.writeFileSync(
  path.join(output, "build.json"),
  JSON.stringify(report, null, 2)
);
console.log(`Comparison applications: ${output}`);
