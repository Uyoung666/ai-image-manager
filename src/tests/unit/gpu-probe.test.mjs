import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  default: {
    execFileSync: execFileSyncMock,
  },
  execFileSync: execFileSyncMock,
}));

import {
  getGpuName,
  isRealGpu,
  selectRealGpuName,
} from "../../../scripts/gpu-probe.mjs";

describe("GPU name detection", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("filters Oray virtual adapters even when they appear first", () => {
    expect(
      selectRealGpuName([
        "OrayIddDriver Device",
        "NVIDIA GeForce RTX 4060 Laptop GPU",
      ])
    ).toBe("NVIDIA GeForce RTX 4060 Laptop GPU");
    expect(isRealGpu("OrayIddDriver Device")).toBe(false);
  });

  it("returns no name when every adapter is virtual", () => {
    expect(
      selectRealGpuName([
        "OrayIddDriver Device",
        "Microsoft Basic Display Adapter",
      ])
    ).toBeNull();
  });

  it("falls back to PowerShell when WMIC only reports virtual adapters", () => {
    execFileSyncMock.mockImplementation((command) => {
      if (command === "wmic") {
        return "Node,Name\r\nhost,OrayIddDriver Device\r\n";
      }
      return "NVIDIA GeForce RTX 4060 Laptop GPU\r\n";
    });

    expect(getGpuName()).toBe("NVIDIA GeForce RTX 4060 Laptop GPU");
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns no name when both GPU queries fail", () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("query failed");
    });

    expect(getGpuName()).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
  });
});
