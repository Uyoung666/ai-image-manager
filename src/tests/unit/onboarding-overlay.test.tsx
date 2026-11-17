import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEV_AUTO_SHOW_ONBOARDING,
  OnboardingOverlay,
} from "@/components/onboarding/OnboardingOverlay";
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
        chooseDataPath: vi.fn(),
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

const onboardingMocks = vi.hoisted(() => ({
  setExiting: vi.fn(),
  setNeedsOnboarding: vi.fn(),
  setPreRenderContent: vi.fn(),
}));

vi.mock("@/components/onboarding/OnboardingProvider", () => ({
  useOnboarding: () => ({
    exiting: false,
    needsOnboarding: true,
    setExiting: onboardingMocks.setExiting,
    setNeedsOnboarding: onboardingMocks.setNeedsOnboarding,
    setPreRenderContent: onboardingMocks.setPreRenderContent,
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
      isDevelopment: true,
      profilePath: "C:\\OldData",
      path: "C:\\OldData",
    });
    vi.mocked(ipc.client.settings.getGpuSettings).mockResolvedValue({
      detected: null,
      enabled: false,
      promptShown: false,
    });
    vi.mocked(ipc.client.settings.chooseDataPath).mockResolvedValue({
      path: "D:\\NewData",
    });
    vi.mocked(ipc.client.settings.setGpuSettings).mockResolvedValue({
      ok: true,
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "electronAPI");
  });

  it("keeps the persisted step after development auto-show is disabled", async () => {
    expect(DEV_AUTO_SHOW_ONBOARDING).toBe(false);
    localStorage.setItem("onboarding_current_step", "2");

    render(<OnboardingOverlay />);

    expect(await screen.findByText("onboardingStep2Title")).toBeInTheDocument();
    expect(localStorage.getItem("onboarding_current_step")).toBe("2");
  });

  it("keeps the E2E startup bypass ahead of development auto-show", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { isE2E: true },
    });

    render(<OnboardingOverlay />);

    await waitFor(() =>
      expect(onboardingMocks.setNeedsOnboarding).toHaveBeenCalledWith(false)
    );
    expect(ipc.client.settings.getAppSetting).not.toHaveBeenCalled();
  });

  it("shows a migration error and keeps the old path when the backend rejects the directory", async () => {
    vi.mocked(ipc.client.settings.setDataPath).mockResolvedValue({
      error: "unavailable",
      ok: false,
    });

    render(<OnboardingOverlay />);

    await screen.findByText("C:\\OldData");
    fireEvent.click(
      screen.getByRole("button", { name: "onboardingStep1Change" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "libraryDirectory_open_title" })
    );
    fireEvent.click(await screen.findByRole("button", { name: "confirm" }));

    expect(
      await screen.findByText("libraryDirectory_error_unavailable")
    ).toBeInTheDocument();
    expect(screen.getByText("C:\\OldData")).toBeInTheDocument();
    expect(queryClient.clear).not.toHaveBeenCalled();
  });

  it("accepts a previously created library path", async () => {
    vi.mocked(ipc.client.settings.setDataPath).mockResolvedValue({
      cleaned: 0,
      cleanupErrors: undefined,
      copied: 0,
      path: "D:\\NewData",
      ok: true,
    });

    render(<OnboardingOverlay />);

    await screen.findByText("C:\\OldData");
    fireEvent.click(
      screen.getByRole("button", { name: "onboardingStep1Change" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "libraryDirectory_open_title" })
    );
    fireEvent.click(await screen.findByRole("button", { name: "confirm" }));

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    );
    expect(screen.getByText("D:\\NewData")).toBeInTheDocument();
    expect(queryClient.clear).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("libraryDirectory_error_unavailable")
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
