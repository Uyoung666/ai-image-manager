import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: () => "[name].js",
    },
    rollupOptions: {
      external: [
        "electron",
        "better-sqlite3",
        "sharp",
        "@lancedb/lancedb",
        "@lancedb/lancedb-win32-x64-msvc",
        "@xenova/transformers",
        "chokidar",
        "exifr",
        "lru-cache",
        "p-queue",
        "electron-store",
        "@claudiu-ceia/dhash",
        "archiver",
        "update-electron-app",
      ],
    },
  },
});
