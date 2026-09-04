import { describe, expect, it } from "vitest";
import {
  assertTemporaryCleanupKey,
  buildInventoryPrefixes,
  buildTemporaryCleanupTargets,
  summarizeObjects,
} from "../../../scripts/release-cos-maintenance.mjs";

const REFUSING_TO_DELETE_PATTERN = /Refusing to delete/;

describe("release COS maintenance safety", () => {
  it("builds inventory roots without broad bucket prefixes", () => {
    expect(buildInventoryPrefixes("ai-image-manager")).toEqual({
      testing: "ai-image-manager/updates/win32/x64/testing/runs/",
      candidates: "ai-image-manager/updates/win32/x64/candidates/",
      downloads: "ai-image-manager/downloads/",
      stable: "ai-image-manager/updates/win32/x64/stable/",
      buildBase: "ai-image-manager/updates/win32/x64/build-base/",
    });
  });

  it("limits cleanup to one testing run and one candidate version", () => {
    const targets = buildTemporaryCleanupTargets({
      version: "2.1.0",
      runId: "33458386015",
      releasePrefix: "ai-image-manager",
    });
    expect(targets).toEqual([
      "ai-image-manager/updates/win32/x64/testing/runs/33458386015/",
      "ai-image-manager/updates/win32/x64/candidates/2.1.0/",
    ]);
    expect(
      assertTemporaryCleanupKey(
        `${targets[0]}ai-image-manager-2.1.0-delta.nupkg`,
        targets
      )
    ).toContain("testing/runs/33458386015");
  });

  it("rejects stable, build-base, downloads, and unrelated objects", () => {
    const targets = buildTemporaryCleanupTargets({
      version: "2.1.0",
      runId: "33458386015",
      releasePrefix: "ai-image-manager",
    });
    for (const key of [
      "ai-image-manager/updates/win32/x64/stable/RELEASES",
      "ai-image-manager/updates/win32/x64/build-base/RELEASES",
      "ai-image-manager/downloads/2.1.0/AI.Image.Manager-2.1.0.Setup.exe",
      "ai-image-manager/updates/win32/x64/testing/runs/other/file",
    ]) {
      expect(() => assertTemporaryCleanupKey(key, targets)).toThrow(
        REFUSING_TO_DELETE_PATTERN
      );
    }
  });

  it("summarizes object count and bytes", () => {
    expect(summarizeObjects([{ size: 10 }, { size: "25" }])).toEqual({
      count: 2,
      bytes: 35,
    });
  });
});
