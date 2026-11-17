import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveStartupProfile } from "@/utils/startup-profile";

const appPath = path.resolve("checkouts", "ai-image-manager");
const options = { appPath, isE2E: false, isPackaged: false };

describe("startup profile selection", () => {
  it("puts the default development profile beside its checkout", () => {
    expect(resolveStartupProfile(options)).toBe(
      path.resolve("checkouts", "ai-image-manager-dev-data")
    );
  });

  it("keeps the original Electron default for release and existing E2E hooks", () => {
    expect(
      resolveStartupProfile({ ...options, isPackaged: true })
    ).toBeUndefined();
    expect(resolveStartupProfile({ ...options, isE2E: true })).toBeUndefined();
  });

  it("honors explicit overrides and gives E2E the highest priority", () => {
    const overridePath = path.resolve("override");
    const e2ePath = path.resolve("e2e-profile");
    expect(resolveStartupProfile({ ...options, overridePath })).toBe(
      overridePath
    );
    expect(resolveStartupProfile({ ...options, e2ePath, overridePath })).toBe(
      e2ePath
    );
  });
});
