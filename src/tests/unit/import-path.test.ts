import path from "node:path";
import { describe, expect, it } from "vitest";
import { importPathKey, normalizeImportFolderPath } from "@/utils/import-path";

describe("import folder path normalization", () => {
  it("resolves an existing directory to a normalized real path", () => {
    expect(normalizeImportFolderPath(process.cwd())).toBe(
      path.normalize(process.cwd())
    );
  });

  it("rejects a file path", () => {
    expect(() =>
      normalizeImportFolderPath(path.join(process.cwd(), "package.json"))
    ).toThrow("Path is not a folder");
  });

  it("uses case-insensitive keys on Windows", () => {
    const mixed = path.join(process.cwd(), "Photos", "Summer");
    const expected =
      process.platform === "win32"
        ? path.normalize(mixed).toLowerCase()
        : path.normalize(mixed);
    expect(importPathKey(mixed)).toBe(expected);
  });
});
