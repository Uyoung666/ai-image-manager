import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateSection } from "@/components/settings/UpdateSection";

const UPDATE_INSTALLING_LABEL_RE = /updateInstalling/i;
const UPDATE_NETWORK_WAITING_LABEL_RE = /updateNetworkWaiting/i;

const mocks = vi.hoisted(() => ({
  getUpdateStatus: vi.fn(),
  checkForUpdates: vi.fn(),
  installDownloadedUpdate: vi.fn(),
  openReleasePage: vi.fn(),
  resumeUpdate: vi.fn(),
  downloadFullUpdate: vi.fn(),
}));
vi.mock("@/actions/update", () => mocks);
vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: {
        getAppPreferences: async () => ({
          updateAutoUpdate: true,
          updateReminder: true,
        }),
        setAppPreference: vi.fn(),
      },
    },
  },
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));
function translate(key: string) {
  return key;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getUpdateStatus.mockResolvedValue({ phase: "idle" });
  mocks.checkForUpdates.mockResolvedValue({ ok: true });
  mocks.resumeUpdate.mockResolvedValue({ ok: true });
  mocks.downloadFullUpdate.mockResolvedValue({ ok: true });
});

function status(data: Record<string, unknown>) {
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "update:status", ...data },
      })
    )
  );
}

describe("update settings errors", () => {
  it("keeps retry on the interrupted package and exposes explicit full download", async () => {
    mocks.getUpdateStatus.mockResolvedValue({
      phase: "error",
      operation: "download",
      message: "NETWORK_ERROR",
      canResume: true,
      canUseFull: true,
      updateMethod: "delta",
    });
    render(<UpdateSection appVersion="2.2.3" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "updateUseFull" })
    );
    await waitFor(() =>
      expect(mocks.downloadFullUpdate).toHaveBeenCalledOnce()
    );
    status({
      phase: "error",
      operation: "download",
      message: "NETWORK_ERROR",
      canResume: true,
      canUseFull: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "updateRetry" }));
    await waitFor(() => expect(mocks.resumeUpdate).toHaveBeenCalledOnce());
    expect(mocks.checkForUpdates).not.toHaveBeenCalled();
  });

  it("shows network waits and retry countdown, then clears an idle snapshot", async () => {
    render(<UpdateSection appVersion="2.2.3" />);
    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalledOnce());
    status({ phase: "downloading", networkWaiting: true });
    expect(
      screen.getByRole("button", { name: UPDATE_NETWORK_WAITING_LABEL_RE })
    ).toBeDisabled();
    status({
      phase: "retry-wait",
      attempt: 1,
      maxAttempts: 4,
      retryAfter: new Date(Date.now() + 5000).toISOString(),
    });
    expect(screen.getByText("updateRetryCountdown")).toBeInTheDocument();
    status({ phase: "idle" });
    expect(screen.queryByText("updateRetryCountdown")).not.toBeInTheDocument();
  });
  it.each([
    [
      "System.Net.WebException: ���� at System.Net.TlsStream.EndWrite",
      "updateErrorTls",
    ],
    ["unknown raw ����", "updateError"],
    ["UPDATE_NOT_READY", "updateErrorNotReady"],
  ])("renders cached %s as localized %s", async (message, key) => {
    mocks.getUpdateStatus.mockResolvedValue({ phase: "error", message });
    render(<UpdateSection appVersion="2.2.1" />);
    expect(await screen.findByText(key)).toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "updateDownloadManually" })
    );
    expect(mocks.openReleasePage).toHaveBeenCalledOnce();
  });

  it("hides event errors when retrying and recovers after success", async () => {
    render(<UpdateSection appVersion="2.2.1" />);
    await waitFor(() => expect(mocks.getUpdateStatus).toHaveBeenCalledOnce());
    status({ phase: "error", message: "System.Net.WebException: ����" });
    expect(screen.getByText("updateErrorNetwork")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "updateRetry" }));
    await waitFor(() => expect(mocks.checkForUpdates).toHaveBeenCalledOnce());
    expect(screen.queryByText("updateErrorNetwork")).not.toBeInTheDocument();
    status({ phase: "up-to-date" });
    expect(screen.getByText("updateUpToDate")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "updateCheckBtn" })
    ).toBeEnabled();
  });

  it("handles rejected status and check IPC without displaying raw text", async () => {
    mocks.getUpdateStatus.mockRejectedValue(new Error("private raw ����"));
    mocks.checkForUpdates.mockRejectedValue(new Error("private raw ����"));
    render(<UpdateSection appVersion="2.2.1" />);
    expect(await screen.findByText("updateError")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "updateRetry" }));
    expect(await screen.findByText("updateError")).toBeInTheDocument();
    expect(screen.queryByText("private raw ����")).not.toBeInTheDocument();
  });

  it("localizes a failed installation", async () => {
    mocks.getUpdateStatus.mockResolvedValue({
      phase: "downloaded",
      version: "2.2.1",
    });
    mocks.installDownloadedUpdate.mockResolvedValue({
      ok: false,
      error: "UPDATE_BUSY",
    });
    render(<UpdateSection appVersion="2.2.0" />);
    fireEvent.click(
      await screen.findByRole("button", { name: "updateRestartNow" })
    );
    expect(await screen.findByText("updateErrorBusy")).toBeInTheDocument();
  });

  it("shows an immediate installing state and disables duplicate installs", async () => {
    let finishInstall: (() => void) | undefined;
    mocks.getUpdateStatus.mockResolvedValue({
      phase: "downloaded",
      version: "2.2.2",
    });
    mocks.installDownloadedUpdate.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishInstall = () => resolve({ ok: true });
        })
    );
    render(<UpdateSection appVersion="2.2.1" />);

    const restart = await screen.findByRole("button", {
      name: "updateRestartNow",
    });
    fireEvent.click(restart);

    expect(screen.getAllByText("updateInstalling")).not.toHaveLength(0);
    expect(
      screen.getByRole("button", { name: UPDATE_INSTALLING_LABEL_RE })
    ).toBeDisabled();
    expect(mocks.installDownloadedUpdate).toHaveBeenCalledOnce();

    act(() => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            channel: "update:status",
            phase: "restarting",
            version: "2.2.2",
          },
        })
      );
    });
    expect(await screen.findAllByText("updateRestarting")).not.toHaveLength(0);
    finishInstall?.();
  });
});
