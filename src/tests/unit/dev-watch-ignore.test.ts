import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDevWatchIgnored } from "@/utils/dev-watch-ignore";

const root = path.resolve(".");
const ignored = createDevWatchIgnored(root);

describe("development watcher boundaries", () => {
  it.each([
    "reports",
    "out",
    ".face-dev",
  ])("excludes the root %s directory and its descendants with either separator", (directory) => {
    for (const file of [directory, `${directory}/src/page.tsx`]) {
      const absolute = path.join(root, file);
      expect(ignored(absolute)).toBe(true);
      expect(ignored(absolute.replaceAll("\\", "/"))).toBe(true);
      expect(ignored(absolute.replaceAll("/", "\\"))).toBe(true);
    }
  });

  it.each([
    ".cache",
    ".test-runtime",
  ])("preserves exclusion of nested %s directories", (directory) => {
    expect(ignored(path.join(root, directory))).toBe(true);
    expect(ignored(path.join(root, "src", directory, "profile.json"))).toBe(
      true
    );
  });

  it.each([
    "src/routes/index.tsx",
    "src/components/reports/chart.tsx",
    "src/out/page.tsx",
    "src/.face-dev/page.tsx",
    "reports-other/page.tsx",
    "outdated/page.tsx",
    "index.html",
    "vite.renderer.config.mts",
  ])("keeps source and similarly named paths watchable: %s", (file) => {
    expect(ignored(path.join(root, file))).toBe(false);
  });

  it("does not exclude similarly named directories outside the project", () => {
    expect(ignored(path.join(root, "..", "reports", "page.tsx"))).toBe(false);
  });
});
