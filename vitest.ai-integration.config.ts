import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "node",
    fileParallelism: false,
    hookTimeout: 300_000,
    include: ["src/tests/integration/ai-*.test.ts"],
    maxWorkers: 1,
    reporters: ["verbose"],
    testTimeout: 300_000,
  },
});
