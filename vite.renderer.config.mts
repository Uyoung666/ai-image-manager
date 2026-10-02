import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const TEST_RUNTIME_DIRECTORY = /(^|[/\\])\.(cache|test-runtime)([/\\]|$)/;

export default defineConfig({
  server: {
    watch: {
      // Test profiles are disposable; watching them holds Windows directory
      // handles and can race with cleanup or a subsequent packaging scan.
      ignored: (file) => TEST_RUNTIME_DIRECTORY.test(file),
    },
  },
  plugins: [
    tanstackRouter({
      routeFileIgnorePattern: "home-sort-storage",
      target: "react",
    }),
    tailwindcss(),
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  resolve: {
    preserveSymlinks: true,
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
});
