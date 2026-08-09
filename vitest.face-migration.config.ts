import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    fileParallelism: false,
    globals: true,
    include: ["src/tests/unit/face-data-migration.test.mjs"],
    reporters: ["verbose"],
  },
});
