import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ShareDialog } from "@/components/ShareDialog";

const mocks = vi.hoisted(() => ({
  generateAndUploadShare: vi.fn(),
  listCloudConfigs: vi.fn(),
  navigate: vi.fn(),
}));
const ARCHIVE_CONFIG_PATTERN = /Archive/;

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mocks.navigate,
}));

vi.mock("@/actions/shell", () => ({
  openExternalLink: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      cloud: {
        listCloudConfigs: mocks.listCloudConfigs,
      },
      photos: {
        generateAndUploadShare: mocks.generateAndUploadShare,
      },
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
  render(<ShareDialog onClose={onClose} open photoIds={[1, 2]} />);
  return onClose;
}

describe("ShareDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listCloudConfigs.mockResolvedValue([]);
    mocks.generateAndUploadShare.mockResolvedValue({
      success: true,
      url: "https://example.test/share",
    });
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
    expect(screen.queryByText("noCloudConfig")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("cloudLoadFailed")).toBeInTheDocument();
    });
    expect(screen.getByText("加载失败，请重试")).toBeInTheDocument();
    expect(screen.queryByText("noCloudConfig")).not.toBeInTheDocument();

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
      expect(screen.getByText("noCloudConfig")).toBeInTheDocument();
    });
  });

  it("closes before navigating to cloud sync settings from the empty state", async () => {
    const onClose = renderDialog();

    await screen.findByText("noCloudConfig");
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

    const primaryLabel = await screen.findByText("Primary");
    const primary = primaryLabel.closest("button");
    expect(primary).not.toBeNull();
    if (!primary) {
      return;
    }
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
