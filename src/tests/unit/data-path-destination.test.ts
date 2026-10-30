import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectDataPathDestination } from "@/utils/data-path-destination";

describe("inspectDataPathDestination", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes a previous AI Image Manager library", () => {
    const destinationPath = path.resolve("previous-library");
    const databasePath = path.join(
      destinationPath,
      "data",
      "ai-image-manager.db"
    );
    vi.spyOn(fs, "statSync").mockReturnValue({
      isFile: () => true,
    } as fs.Stats);

    expect(inspectDataPathDestination(destinationPath)).toEqual({
      kind: "existing-library",
      databasePath,
    });
  });

  it.each([
    "models",
    "shooting-projects",
  ])("rejects existing %s data without a library database", (directory) => {
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("missing");
    });
    vi.spyOn(fs, "existsSync").mockImplementation((candidate) =>
      String(candidate).endsWith(`${path.sep}${directory}`)
    );

    expect(inspectDataPathDestination(path.resolve("not-a-library"))).toEqual({
      kind: "conflict",
      conflictingDirectory: directory,
    });
  });

  it("allows a destination without managed data directories", () => {
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw new Error("missing");
    });
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    expect(inspectDataPathDestination(path.resolve("empty-directory"))).toEqual(
      { kind: "available" }
    );
  });
});
