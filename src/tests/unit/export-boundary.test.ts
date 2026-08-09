import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allocateExportFilename,
  resolveExportChildPath,
  resolveExportOutputPath,
  sanitizeExportFilename,
} from "@/ipc/photos/handlers/export";

describe("photo export path boundaries", () => {
  it("strips path components and unsafe filename characters", () => {
    expect(sanitizeExportFilename("..\\outside/<photo>:?.jpg")).toBe(
      "_photo___.jpg"
    );
  });

  it("allocates unique final names after compression changes the extension", () => {
    const usedNames = new Set<string>();

    expect(allocateExportFilename("same.png", "compressed", usedNames)).toBe(
      "same.jpg"
    );
    expect(allocateExportFilename("same.jpg", "compressed", usedNames)).toBe(
      "same_1.jpg"
    );
  });

  it("rejects a child path that escapes the temporary export directory", () => {
    expect(() =>
      resolveExportChildPath(
        path.join(os.tmpdir(), "gallery"),
        "..\\escape.jpg"
      )
    ).toThrow("outside the export directory");
  });

  it("rejects a directory as the archive output", () => {
    expect(() => resolveExportOutputPath(os.tmpdir())).toThrow(
      "must be a file"
    );
  });
});
