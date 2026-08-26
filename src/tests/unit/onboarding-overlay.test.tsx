import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingOverlay } from "@/components/onboarding/OnboardingOverlay";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getFolders: vi.fn(),
        listPhotos: vi.fn(),
      },
      settings: {
        getAppSetting: vi.fn(),
        getDataPathInfo: vi.fn(),
        getGpuSettings: vi.fn(),
        markGpuPromptShown: vi.fn(),
        setAppSetting: vi.fn(),
        setDataPath: vi.fn(),
        setGpuSettings: vi.fn(),
      },
      shell: {
        openFolderDialog: vi.fn(),
      },
    },
  },
}));

vi.mock("@/providers/QueryProvider", () => ({
  queryClient: {
    clear: vi.fn(),
    prefetchInfiniteQuery: vi.fn(),
    prefetchQuery: vi.fn(),
  },
}));

vi.mock("@/components/onboarding/OnboardingProvider", () => ({
  useOnboarding: () => ({
    exiting: false,
    needsOnboarding: true,
    setExiting: vi.fn(),
    setNeedsOnboarding: vi.fn(),
    setPreRenderContent: vi.fn(),
  }),
}));

vi.mock("@/components/gpu-settings-card", () => ({
  GpuSettingsCard: ({
    onEnabledChange,
    onLoaded,
  }: {
    onEnabledChange?: (enabled: boolean) => void;
    onLoaded?: () => void;
  }) => (
    <button
      onClick={() => {
        onEnabledChange?.(true);
        onLoaded?.();
      }}
      type="button"
    >
      gpu-ready
    </button>
  ),
}));

vi.mock("@/components/lang-toggle", () => ({
  default: () => null,
}));

describe("OnboardingOverlay", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(ipc.client.settings.getAppSetting).mockResolvedValue({
      key: "onboarding.completed",
      value: "false",
    });
    vi.mocked(ipc.client.settings.getDataPathInfo).mockResolvedValue({
      isDefault: true,
      path: "C:\\OldData",
    });
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: null,
      enabled: false,
      promptShown: false,
    });
    vi.mocked(ipc.client.shell.openFolderDialog).mockResolvedValue({
      path: "D:\\NewData",
    });
    vi.mocked(ipc.client.settings.setGpuSettings).mockResolvedValue({
      ok: true,
    });
  });

  it("shows a migration error and keeps the old path when the backend rejects the directory", async () => {
    vi.mocked(ipc.client.settings.setDataPath).mockResolvedValue({
      error: "directory is not writable",
      ok: false,
    });

    render(<OnboardingOverlay />);

    await screen.findByText("C:\\OldData");
    fireEvent.click(screen.getByText("onboardingStep1Change"));

    expect(
      await screen.findByText("onboardingErrorMigration")
    ).toBeInTheDocument();
    expect(screen.queryByText("D:\\NewData")).not.toBeInTheDocument();
    expect(queryClient.clear).not.toHaveBeenCalled();
  });

  it("accepts a previously created library path", async () => {
    vi.mocked(ipc.client.settings.setDataPath).mockResolvedValue({
      adopted: true,
      cleaned: 0,
      cleanupErrors: undefined,
      copied: 0,
      errors: undefined,
      ok: true,
    });

    render(<OnboardingOverlay />);

    await screen.findByText("C:\\OldData");
    fireEvent.click(screen.getByText("onboardingStep1Change"));

    expect(await screen.findByText("D:\\NewData")).toBeInTheDocument();
    expect(queryClient.clear).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("onboardingErrorMigration")
    ).not.toBeInTheDocument();
  });

  it("saves the selected GPU state before advancing to the final step", async () => {
    render(<OnboardingOverlay />);

    await screen.findByText("C:\\OldData");
    fireEvent.click(screen.getByText("onboardingContinue"));
    fireEvent.click(await screen.findByText("gpu-ready"));
    fireEvent.click(screen.getByText("onboardingSaveContinue"));

    await waitFor(() => {
      expect(ipc.client.settings.setGpuSettings).toHaveBeenCalledWith({
        enabled: true,
      });
    });
    expect(await screen.findByText("onboardingStep3Title")).toBeInTheDocument();
  });

  it("stays on the GPU step when saving fails", async () => {
    vi.mocked(ipc.client.settings.setGpuSettings).mockRejectedValue(
      new Error("save failed")
    );

    render(<OnboardingOverlay />);

    await screen.findByText("C:\\OldData");
    fireEvent.click(screen.getByText("onboardingContinue"));
    fireEvent.click(await screen.findByText("gpu-ready"));
    fireEvent.click(screen.getByText("onboardingSaveContinue"));

    expect(
      await screen.findByText("onboardingErrorGpuSave")
    ).toBeInTheDocument();
    expect(screen.queryByText("onboardingStep3Title")).not.toBeInTheDocument();
  });
});
