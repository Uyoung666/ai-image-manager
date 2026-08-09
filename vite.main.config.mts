import { builtinModules } from "node:module";
import path from "node:path";
import { defineConfig } from "vite";

const requireShim = `import { createRequire as __createRequire } from "node:module";
var require = __createRequire(import.meta.url);`;

export default defineConfig({
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
