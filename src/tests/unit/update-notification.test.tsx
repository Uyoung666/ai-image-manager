import { act, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UpdateNotification } from "@/components/update-notification";
import { UpdateUiProvider } from "@/hooks/use-update-ui";
import { translateUpdate, updateUiFixture } from "../helpers/update-ui";

const mocks = vi.hoisted(() => ({
  language: "en",
  toast: {
    info: vi.fn(
      (
        _message: unknown,
        _options: {
          duration: number;
          closeButton: boolean;
          dismissible: boolean;
          action: { onClick: () => void };
        }
      ) => "update-toast"
    ),
    error: vi.fn((_message: unknown, _options: unknown) => "update-toast"),
    dismiss: vi.fn(),
  },
}));
vi.mock("sonner", () => mocks);
vi.mock("@/ipc/manager", () => ({ ipc: { client: {} } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      `${mocks.language}:${translateUpdate(key, options)}`,
  }),
}));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.language = "en";
});

it("shows one 8-second ready notice whose action opens details without installing", async () => {
  const fixture = updateUiFixture({ phase: "downloaded", version: "2.2.4" });
  fixture.render(<UpdateNotification />);
  await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledOnce());
  const options = mocks.toast.info.mock.calls[0][1];
  expect(options).toMatchObject({
    duration: 8000,
    closeButton: true,
    dismissible: true,
  });
  act(() => options.action.onClick());
  expect(fixture.store.getSnapshot().detailsOpen).toBe(true);
  expect(fixture.dependencies.install).not.toHaveBeenCalled();
  act(() =>
    fixture.emit({ phase: "downloaded", version: "2.2.4", percent: 100 })
  );
  expect(mocks.toast.info).toHaveBeenCalledOnce();
});

it("does not create persistent notifications for downloads or installation", async () => {
  const fixture = updateUiFixture();
  fixture.render(<UpdateNotification />);
  await waitFor(() =>
    expect(fixture.store.getSnapshot().preferencesReady).toBe(true)
  );
  act(() => {
    fixture.emit({ phase: "downloading", percent: 42 });
    fixture.emit({ phase: "retry-wait" });
    fixture.emit({ phase: "installing" });
  });
  expect(mocks.toast.info).not.toHaveBeenCalled();
});

it("reports an install failure even with reminders disabled, without repeating on progress events", async () => {
  const fixture = updateUiFixture();
  fixture.dependencies.getPreferences.mockResolvedValue({
    updateAutoUpdate: true,
    updateReminder: false,
  });
  fixture.render(<UpdateNotification />);
  await waitFor(() =>
    expect(fixture.store.getSnapshot().preferencesReady).toBe(true)
  );
  act(() =>
    fixture.emit({
      phase: "error",
      operation: "install",
      message: "UPDATE_INSTALL_DISK_FULL",
    })
  );
  await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledOnce());
  expect(mocks.toast.error.mock.calls[0][0]).toBe(
    "en:updateErrorInstallDiskFull"
  );
  act(() =>
    fixture.emit({
      phase: "error",
      operation: "install",
      message: "UPDATE_INSTALL_DISK_FULL",
      transferred: 100,
    })
  );
  expect(mocks.toast.error).toHaveBeenCalledOnce();
});

it("does not replay the same notice after a language change", async () => {
  const fixture = updateUiFixture({ phase: "downloaded", version: "2.2.4" });
  const mounted = fixture.render(<UpdateNotification />);
  await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledOnce());
  mocks.language = "ja";
  mounted.rerender(
    <UpdateUiProvider store={fixture.store}>
      <TooltipProvider>
        <UpdateNotification />
      </TooltipProvider>
    </UpdateUiProvider>
  );
  act(() =>
    fixture.emit({ phase: "downloaded", version: "2.2.4", percent: 100 })
  );
  expect(mocks.toast.info).toHaveBeenCalledOnce();
});
