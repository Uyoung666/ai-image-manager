import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

const requireShim = `import { createRequire as __createRequire } from "node:module";
var require = __createRequire(import.meta.url);`;
const updateBaseURL = process.env.AIM_UPDATE_BASE_URL?.trim() ?? "";

export default defineConfig({
  // Keep the production feed in the packaged main bundle. Unit tests use an
  // explicit in-memory seam; an installed app never reads a runtime feed env.
  define: {
    __AIM_UPDATE_BASE_URL__: JSON.stringify(updateBaseURL),
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    lib: {
      entry: "src/bootstrap.ts",
      formats: ["es"],
      fileName: () => "[name].js",
    },
    rollupOptions: {
      output: {
        inlineDynamicImports: false,
        chunkFileNames: "chunks/[name]-[hash].js",
        banner: requireShim,
      },
      external: [
        "electron",
        "electron/main",
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
        "better-sqlite3",
        "sharp",
        "@lancedb/lancedb",
        "@lancedb/lancedb-win32-x64-msvc",
        "@xenova/transformers",
        "apache-arrow",
        "flatbuffers",
      ],
    },
  },
});
