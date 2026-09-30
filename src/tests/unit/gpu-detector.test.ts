import { beforeEach, describe, expect, it, vi } from "vitest";

const getSettingMock = vi.hoisted(() => vi.fn());

vi.mock("@/services/settings-manager", () => ({
  getSetting: getSettingMock,
  setSetting: vi.fn(),
}));

vi.mock("@/services/diagnostics/worker-output", () => ({
  captureWorkerOutput: vi.fn(),
}));

vi.mock("@/services/tracked-child-processes", () => ({
  trackChildProcess: vi.fn((child) => child),
}));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
  }),
}));

import { getCachedDetection } from "@/services/gpu-detector";

describe("cached GPU detection", () => {
  beforeEach(() => {
    getSettingMock.mockReset();
  });

  it("invalidates cached Oray virtual adapter results", () => {
    getSettingMock.mockReturnValue(
      JSON.stringify({
        dmlAvailable: true,
        gpuName: "OrayIddDriver Device",
        probeTimeMs: 20,
      })
    );

    expect(getCachedDetection()).toBeNull();
  });

  it("keeps cached results for a real GPU", () => {
    const cached = {
      dmlAvailable: true,
      gpuName: "NVIDIA GeForce RTX 4060 Laptop GPU",
      probeTimeMs: 20,
    };
    getSettingMock.mockReturnValue(JSON.stringify(cached));

    expect(getCachedDetection()).toEqual(cached);
  });
});
