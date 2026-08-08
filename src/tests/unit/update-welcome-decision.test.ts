import { describe, expect, it } from "vitest";
import { decideUpdateWelcomeVersion } from "@/services/update-welcome-decision";

const baseInput = {
  currentVersion: "1.5.0",
  hasChangelog: true,
  isPackaged: true,
  lastLaunchedVersion: "1.4.0",
  skip: false,
};

describe("decideUpdateWelcomeVersion", () => {
  it("shows the current version after an upgrade", () => {
    expect(decideUpdateWelcomeVersion(baseInput)).toEqual({
      nextLaunchedVersion: "1.5.0",
      version: "1.5.0",
    });
  });

  it("initializes first launch without showing a welcome page", () => {
    expect(
      decideUpdateWelcomeVersion({
        ...baseInput,
        lastLaunchedVersion: undefined,
      })
    ).toEqual({
      nextLaunchedVersion: "1.5.0",
      version: null,
    });
  });

  it("does not show the same version twice", () => {
    expect(
      decideUpdateWelcomeVersion({
        ...baseInput,
        lastLaunchedVersion: "1.5.0",
      }).version
    ).toBeNull();
  });

  it("skips versions without bundled content", () => {
    expect(
      decideUpdateWelcomeVersion({ ...baseInput, hasChangelog: false }).version
    ).toBeNull();
  });

  it("skips development and E2E launches", () => {
    expect(
      decideUpdateWelcomeVersion({ ...baseInput, isPackaged: false }).version
    ).toBeNull();
    expect(
      decideUpdateWelcomeVersion({ ...baseInput, skip: true }).version
    ).toBeNull();
  });
});
