import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import { ipc } from "@/ipc/manager";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: {
        checkGpuCapability: vi.fn(),
        getGpuSettings: vi.fn(),
        setGpuSettings: vi.fn(),
      },
    },
  },
}));

describe("GpuSettingsCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: null,
      enabled: false,
      promptShown: false,
    });
  });

  it("reports its loaded state and hides the separate save action in onboarding mode", async () => {
    const onEnabledChange = vi.fn();
    const onLoaded = vi.fn();

    render(
      <GpuSettingsCard
        hideSaveButton
        onEnabledChange={onEnabledChange}
        onLoaded={onLoaded}
      />
    );

    await waitFor(() => {
      expect(onLoaded).toHaveBeenCalledOnce();
    });
    expect(onEnabledChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("保存")).not.toBeInTheDocument();
  });

  it("reports detection work and the enabled state to the onboarding parent", async () => {
    const onBusyChange = vi.fn();
    const onEnabledChange = vi.fn();
    vi.mocked(ipc.client.settings.checkGpuCapability).mockResolvedValue({
      dmlAvailable: true,
      gpuName: "Test GPU",
      probeTimeMs: 12,
      timestamp: Date.now(),
    });

    render(
      <GpuSettingsCard
        hideSaveButton
        onBusyChange={onBusyChange}
        onEnabledChange={onEnabledChange}
      />
    );

    await screen.findByText("gpuDetect");
    onBusyChange.mockClear();
    onEnabledChange.mockClear();
    fireEvent.click(screen.getByText("gpuDetect"));

    await waitFor(() => {
      expect(onEnabledChange).toHaveBeenCalledWith(true);
    });
    expect(onBusyChange.mock.calls).toEqual([[true], [false]]);
  });
});
