const DOWNLOADED_LABEL = /updateDownloadedStatus/;
const COMPLETE_PERCENT = /100%/;
const OLD_NOTES = /Old notes/;

import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateSection } from "@/components/settings/UpdateSection";
import { UpdateTaskCard } from "@/components/update-task-card";
import { translateUpdate, updateUiFixture } from "../helpers/update-ui";

vi.mock("@/ipc/manager", () => ({ ipc: { client: {} } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translateUpdate, i18n: { language: "en" } }),
}));
beforeEach(() => localStorage.clear());

async function section(
  initial: Parameters<typeof updateUiFixture>[0] = { phase: "idle" }
) {
  const fixture = updateUiFixture(initial);
  fixture.render(<UpdateSection appVersion="2.2.3" />);
  await waitFor(() =>
    expect(fixture.store.getSnapshot().preferencesReady).toBe(true)
  );
  return fixture;
}

describe("update task actions and presentation", () => {
  it("puts a working retry beside insufficient-space feedback without suggesting a larger package", async () => {
    const fixture = await section({
      phase: "error",
      operation: "download",
      message: "UPDATE_DISK_SPACE",
      canResume: true,
      canUseFull: true,
    });
    const card = screen.getByTestId("update-task-card");
    expect(within(card).getByText("updateErrorDiskSpace")).toBeVisible();
    expect(
      within(card).queryByRole("button", { name: "updateUseFull" })
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(card).getByRole("button", { name: "updateRetryAfterSpace" })
    );
    await waitFor(() =>
      expect(fixture.dependencies.resume).toHaveBeenCalledOnce()
    );
    expect(
      // biome-ignore lint/suspicious/noBitwiseOperators: compareDocumentPosition returns a DOM bit mask
      card.compareDocumentPosition(
        screen.getByRole("checkbox", { name: "settingsAutoUpdate" })
      ) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it.each([
    "UPDATE_ACCESS_DENIED",
    "UPDATE_TLS_ERROR",
    "NETWORK_ERROR",
  ] as const)("does not offer a full package for %s", async (message) => {
    await section({
      phase: "error",
      message,
      canUseFull: true,
      canResume: true,
    });
    expect(
      screen.queryByRole("button", { name: "updateUseFull" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "updateContinueDownload" })
    ).toBeEnabled();
  });

  it("offers full download only for eligible package failures", async () => {
    const fixture = await section({
      phase: "error",
      message: "UPDATE_PACKAGE_CORRUPT",
      canUseFull: true,
      canResume: true,
    });
    fireEvent.click(screen.getByRole("button", { name: "updateUseFull" }));
    await waitFor(() =>
      expect(fixture.dependencies.full).toHaveBeenCalledOnce()
    );
    expect(fixture.dependencies.check).not.toHaveBeenCalled();
  });

  it("disables retries during the server cooldown and unlocks them when it expires", async () => {
    const fixture = await section({ phase: "idle" });
    vi.useFakeTimers();
    act(() =>
      fixture.emit({
        phase: "error",
        message: "UPDATE_PACKAGE_CORRUPT",
        canResume: true,
        canUseFull: true,
        retryAfter: new Date(Date.now() + 2000).toISOString(),
      })
    );
    expect(
      screen.getByRole("button", { name: "updateContinueDownload" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "updateUseFull" })
    ).toBeDisabled();
    act(() => vi.advanceTimersByTime(2000));
    expect(
      screen.getByRole("button", { name: "updateContinueDownload" })
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "updateUseFull" })).toBeEnabled();
    vi.useRealTimers();
  });

  it("shares the install lock between cards and gives immediate request feedback without a fake phase", async () => {
    const fixture = updateUiFixture({ phase: "downloaded", version: "2.2.4" });
    let finish: (value: { ok: true }) => void = () => undefined;
    fixture.dependencies.install.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    fixture.render(
      <>
        <UpdateTaskCard />
        <UpdateTaskCard compact />
      </>
    );
    const buttons = await screen.findAllByRole("button", {
      name: "updateRestartNow",
    });
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    expect(fixture.dependencies.install).toHaveBeenCalledOnce();
    expect(
      screen.getAllByRole("button", { name: "updatePreparingInstall" })
    ).toHaveLength(2);
    expect(screen.queryByText(DOWNLOADED_LABEL)).not.toBeInTheDocument();
    expect(fixture.store.getSnapshot().status.phase).toBe("downloaded");
    act(() => fixture.emit({ phase: "installing", version: "2.2.4" }));
    await act(async () => finish({ ok: true }));
    expect(screen.getAllByText("updateInstalling")).toHaveLength(2);
  });

  it("shows only authoritative progress, and never retains downloaded percentages during installation", async () => {
    const fixture = await section({
      phase: "downloading",
      percent: 42,
      transferred: 28 * 1024 ** 2,
      total: 67 * 1024 ** 2,
      bytesPerSecond: 2.1 * 1024 ** 2,
    });
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "42"
    );
    expect(screen.getByText("42% · 28 MB / 67 MB")).toBeVisible();
    expect(screen.getByText("updateSpeed 2.1 MB")).toBeVisible();
    act(() => fixture.emit({ phase: "downloading" }));
    expect(screen.getByRole("progressbar")).not.toHaveAttribute(
      "aria-valuenow"
    );
    act(() => fixture.emit({ phase: "installing", percent: 100 }));
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    expect(screen.queryByText(COMPLETE_PERCENT)).not.toBeInTheDocument();
  });

  it("separates repair and fallback reasons and clears stale notes from new snapshots", async () => {
    const fixture = await section({
      phase: "downloading",
      version: "2.2.4",
      recoveryReason: "cache-corrupt",
    });
    expect(screen.getByText("updateRepairingCache")).toBeVisible();
    expect(screen.queryByText("updateDeltaFallback")).not.toBeInTheDocument();
    act(() =>
      fixture.emit({
        phase: "downloading",
        fallbackReason: "user-selected",
        updateMethod: "full",
      })
    );
    expect(screen.getByText("updateFullUserSelected")).toBeVisible();
    expect(screen.queryByText("updateDeltaFallback")).not.toBeInTheDocument();
    act(() =>
      fixture.emit({
        phase: "downloaded",
        fallbackReason: "delta-corrupt",
        version: "2.2.4",
        releaseNotes: "Old notes <script>text only</script>",
      })
    );
    expect(screen.getByText("updateDeltaFallback")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "updateReleaseNotes" }));
    expect(
      screen.getByText("Old notes <script>text only</script>")
    ).toBeVisible();
    act(() => fixture.emit({ phase: "downloaded", version: "2.2.5" }));
    expect(screen.queryByText("updateDeltaFallback")).not.toBeInTheDocument();
    expect(screen.queryByText(OLD_NOTES)).not.toBeInTheDocument();
  });

  it("keeps the approved installation in progress after cache repair instead of offering installation again", async () => {
    await section({
      phase: "downloaded",
      version: "2.2.4",
      resumeInstallation: true,
    });
    expect(screen.getByText("updatePreparingInstall")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "updateRestartNow" })
    ).not.toBeInTheDocument();
  });

  it("localizes command rejection and allows retry through the same IPC entry", async () => {
    const fixture = await section({ phase: "downloaded", version: "2.2.4" });
    fixture.dependencies.install.mockResolvedValueOnce({
      ok: false,
      error: "UPDATE_BUSY",
    });
    fireEvent.click(screen.getByRole("button", { name: "updateRestartNow" }));
    expect(await screen.findByText("updateErrorBusy")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "updateRetryUpdate" }));
    await waitFor(() =>
      expect(fixture.dependencies.install).toHaveBeenCalledTimes(2)
    );
  });

  it("rolls preferences back and gives visible save-error feedback", async () => {
    const fixture = await section();
    fixture.dependencies.savePreference.mockRejectedValueOnce(
      new Error("denied")
    );
    fireEvent.click(
      screen.getByRole("checkbox", { name: "settingsAutoUpdate" })
    );
    expect(await screen.findByText("updatePreferenceSaveFailed")).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "settingsAutoUpdate" })
    ).toBeChecked();
  });
});
