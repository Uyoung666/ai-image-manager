import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    include: ["src/tests/unit/**/*.{test,spec}.{ts,tsx,js,jsx,mjs}"],
    exclude: [
      "src/tests/e2e/**",
      "src/tests/integration/**",
      // Runs under Node's native test runner (node:sqlite), not Vitest
      // (CI runs it via `electron --test` in test-face-migration).
      "src/tests/unit/face-data-migration.test.mjs",
    ],
    fileParallelism: !process.env.CI,
    maxWorkers: process.env.CI ? 1 : undefined,
    globals: true,
    environment: "jsdom",
    setupFiles: "./src/tests/unit/setup.ts",
    css: true,
    reporters: ["verbose"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*"],
      exclude: [],
    },
  },
});
