import path from "node:path";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { createDevWatchIgnored } from "./src/utils/dev-watch-ignore";

export default defineConfig({
  server: {
    watch: {
      // Generated reports and packaged apps can contain entire source trees.
      // Keep them outside the watcher without excluding same-named source dirs.
      ignored: createDevWatchIgnored(import.meta.dirname),
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
      ...(process.env.AIM_GALLERY_PROFILE_BUILD === "1"
        ? { "react-dom/client": "react-dom/profiling" }
        : {}),
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  optimizeDeps: {
    entries: ["index.html"],
  },
});
