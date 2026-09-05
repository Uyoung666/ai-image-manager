import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudUploadDialog } from "@/components/CloudUploadDialog";

const mocks = vi.hoisted(() => ({
  listCloudConfigs: vi.fn(),
  navigate: vi.fn(),
  uploadPhotoToCloud: vi.fn(),
}));
const PRIMARY_CONFIG_PATTERN = /Primary/;
const ARCHIVE_CONFIG_PATTERN = /Archive/;

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      cloud: mocks,
    },
  },
}));

function deferred<T>() {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function renderDialog(onClose = vi.fn()) {
  render(<CloudUploadDialog onClose={onClose} open photoIds={[1, 2]} />);
  return onClose;
}

describe("CloudUploadDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCloudConfigs.mockResolvedValue([]);
    mocks.uploadPhotoToCloud.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("distinguishes loading and failure, then gives retry feedback", async () => {
    const retryPending = deferred<unknown>();
    mocks.listCloudConfigs
      .mockRejectedValueOnce(new Error("list failed"))
      .mockReturnValueOnce(retryPending.promise);

    renderDialog();

    expect(screen.getByText("加载中…")).toBeInTheDocument();
    expect(screen.queryByText("cloudNoConfig")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("cloudLoadFailed")).toBeInTheDocument();
    });
    expect(screen.getByText("加载失败，请重试")).toBeInTheDocument();
    expect(screen.queryByText("cloudNoConfig")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(screen.getByText("加载中…")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "retry" })
    ).not.toBeInTheDocument();

    await waitFor(() =>
      expect(mocks.listCloudConfigs).toHaveBeenCalledTimes(2)
    );
    retryPending.resolve([]);
    await waitFor(() => {
      expect(screen.getByText("cloudNoConfig")).toBeInTheDocument();
    });
  });

  it("closes before navigating to cloud sync settings from the empty state", async () => {
    const onClose = renderDialog();

    await screen.findByText("cloudNoConfig");
    fireEvent.click(screen.getByRole("button", { name: "cloudSync" }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).toHaveBeenCalledWith({
      to: "/settings/cloud-sync",
    });
    expect(onClose.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.navigate.mock.invocationCallOrder[0]
    );
  });

  it("exposes the selected cloud target with aria-pressed", async () => {
    mocks.listCloudConfigs.mockResolvedValue([
      { id: 1, name: "Primary", provider: "webdav" },
      { id: 2, name: "Archive", provider: "s3" },
    ]);

    renderDialog();

    const primary = await screen.findByRole("button", {
      name: PRIMARY_CONFIG_PATTERN,
    });
    const archive = screen.getByRole("button", {
      name: ARCHIVE_CONFIG_PATTERN,
    });

    expect(primary).toHaveAttribute("aria-pressed", "false");
    expect(archive).toHaveAttribute("aria-pressed", "false");

    fireEvent.click(archive);

    expect(primary).toHaveAttribute("aria-pressed", "false");
    expect(archive).toHaveAttribute("aria-pressed", "true");
  });
});
