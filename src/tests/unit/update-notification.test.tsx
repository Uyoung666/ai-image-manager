import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { UpdateNotification } from "@/components/update-notification";

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), {
    info: vi.fn(),
    error: vi.fn(),
    loading: vi.fn(),
    dismiss: vi.fn(),
  }),
  getUpdateStatus: vi.fn(),
  installDownloadedUpdate: vi.fn(),
  resumeUpdate: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: mocks.toast }));
vi.mock("@/actions/update", () => mocks);
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));
function translate(key: string) {
  return key;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.getUpdateStatus.mockResolvedValue({
    phase: "downloaded",
    version: "2.2.4",
  });
});

it("shows immediate global feedback and handles a rejected install result", async () => {
  mocks.installDownloadedUpdate.mockResolvedValue({
    ok: false,
    error: "UPDATE_BUSY",
  });
  render(<UpdateNotification reminder />);
  await waitFor(() => expect(mocks.toast.info).toHaveBeenCalled());
  await act(async () => {
    await mocks.toast.info.mock.calls[0][1].action.onClick({
      preventDefault: vi.fn(),
    });
  });
  expect(mocks.toast.loading).toHaveBeenCalledWith(
    "updateInstalling",
    expect.anything()
  );
  await waitFor(() =>
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "updateErrorBusy",
      expect.anything()
    )
  );
});

it("shows installation feedback even when download reminders are disabled", async () => {
  mocks.getUpdateStatus.mockResolvedValue({
    phase: "installing",
    operation: "install",
  });
  render(<UpdateNotification reminder={false} />);
  await waitFor(() =>
    expect(mocks.toast.info).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        duration: Number.POSITIVE_INFINITY,
        dismissible: false,
      })
    )
  );
});

it("ignores a late snapshot after a newer main-process event", async () => {
  let finish: (value: unknown) => void = () => undefined;
  mocks.getUpdateStatus.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    })
  );
  render(<UpdateNotification reminder />);
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "update:status", phase: "installing" },
      })
    )
  );
  await act(async () => finish({ phase: "downloaded" }));
  expect(mocks.toast.info).not.toHaveBeenCalledWith(
    "updateDownloaded",
    expect.anything()
  );
});
