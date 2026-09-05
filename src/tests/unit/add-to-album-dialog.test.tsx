import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";

const mocks = vi.hoisted(() => ({
  addPhotosToAlbum: vi.fn(),
  createAlbum: vi.fn(),
  listAlbums: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      albums: mocks,
    },
  },
}));

vi.mock("sonner", () => ({ toast }));

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
  render(<AddToAlbumDialog onClose={onClose} open photoIds={[1, 2]} />);
  return onClose;
}

describe("AddToAlbumDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listAlbums.mockResolvedValue([]);
    mocks.addPhotosToAlbum.mockResolvedValue(undefined);
    mocks.createAlbum.mockResolvedValue({
      description: null,
      id: 2,
      name: "新相册",
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("shows loading and a retryable error instead of an empty state", async () => {
    const pending = deferred<unknown>();
    mocks.listAlbums
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce([{ description: null, id: 1, name: "旅行" }]);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    renderDialog();

    expect(screen.getByText("加载中…")).toBeInTheDocument();
    expect(
      screen.queryByText("还没有相册，创建一个吧")
    ).not.toBeInTheDocument();

    pending.reject(new Error("list failed"));
    await waitFor(() => {
      expect(screen.getByText("加载失败，请重试")).toBeInTheDocument();
    });
    expect(
      screen.queryByText("还没有相册，创建一个吧")
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "旅行" })).toBeInTheDocument();
    });
  });

  it("ignores a stale album response after the dialog closes and reopens", async () => {
    const stale = deferred<unknown>();
    const fresh = deferred<unknown>();
    mocks.listAlbums
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(fresh.promise);

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(false)} type="button">
            close dialog
          </button>
          <button onClick={() => setOpen(true)} type="button">
            reopen dialog
          </button>
          <AddToAlbumDialog onClose={vi.fn()} open={open} photoIds={[1, 2]} />
        </>
      );
    }

    render(<Harness />);
    await waitFor(() => expect(mocks.listAlbums).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByText("close dialog"));
    fireEvent.click(screen.getByText("reopen dialog"));
    await waitFor(() => expect(mocks.listAlbums).toHaveBeenCalledTimes(2));

    fresh.resolve([{ description: null, id: 2, name: "新相册" }]);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "新相册" })).toBeInTheDocument()
    );

    stale.resolve([{ description: null, id: 1, name: "旧相册" }]);
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "旧相册" })
      ).not.toBeInTheDocument()
    );
  });

  it("keeps the dialog open after an existing-album failure and allows retry", async () => {
    mocks.listAlbums.mockResolvedValue([
      { description: null, id: 1, name: "旅行" },
    ]);
    mocks.addPhotosToAlbum
      .mockRejectedValueOnce(new Error("add failed"))
      .mockResolvedValueOnce(undefined);
    const onClose = renderDialog();
    const albumButton = await screen.findByRole("button", { name: "旅行" });

    fireEvent.click(albumButton);
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("添加失败");
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(albumButton).not.toBeDisabled();

    fireEvent.click(albumButton);
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith("已添加 2 张照片到「旅行」");
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("prevents duplicate create submissions while pending and reports success", async () => {
    const pending = deferred<{ description: null; id: number; name: string }>();
    mocks.createAlbum.mockReturnValueOnce(pending.promise);
    const onClose = renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "新建相册" }));
    const input = screen.getByPlaceholderText("相册名称...");
    fireEvent.change(input, { target: { value: "新相册" } });
    const createButton = screen.getByRole("button", { name: "创建" });
    fireEvent.click(createButton);
    fireEvent.click(createButton);

    await waitFor(() => {
      expect(mocks.createAlbum).toHaveBeenCalledTimes(1);
      expect(createButton).toBeDisabled();
      expect(
        screen.queryByRole("button", { name: "关闭" })
      ).not.toBeInTheDocument();
    });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.getByDisplayValue("新相册")).toBeInTheDocument();

    pending.resolve({ description: null, id: 2, name: "新相册" });
    await waitFor(() => {
      expect(mocks.addPhotosToAlbum).toHaveBeenCalledWith({
        albumId: 2,
        photoIds: [1, 2],
      });
      expect(toast.success).toHaveBeenCalledWith("已添加 2 张照片到「新相册」");
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the create input and dialog open when creation fails", async () => {
    mocks.createAlbum.mockRejectedValueOnce(new Error("create failed"));
    const onClose = renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "新建相册" }));
    const input = screen.getByPlaceholderText("相册名称...");
    fireEvent.change(input, { target: { value: "保留名称" } });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("albumCreateFailed");
    });
    expect(screen.getByDisplayValue("保留名称")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建" })).not.toBeDisabled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("returns to the refreshed album list when adding a newly created album fails", async () => {
    mocks.listAlbums
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { description: null, id: 2, name: "已创建相册" },
      ]);
    mocks.createAlbum.mockResolvedValueOnce({
      description: null,
      id: 2,
      name: "已创建相册",
    });
    mocks.addPhotosToAlbum
      .mockRejectedValueOnce(new Error("add failed"))
      .mockResolvedValueOnce(undefined);
    const onClose = renderDialog();

    fireEvent.click(await screen.findByRole("button", { name: "新建相册" }));
    fireEvent.change(screen.getByPlaceholderText("相册名称..."), {
      target: { value: "已创建相册" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("添加失败");
      expect(mocks.listAlbums).toHaveBeenCalledTimes(2);
    });
    expect(
      screen.queryByPlaceholderText("相册名称...")
    ).not.toBeInTheDocument();
    const albumButton = await screen.findByRole("button", {
      name: "已创建相册",
    });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(albumButton);
    await waitFor(() => {
      expect(toast.success).toHaveBeenCalledWith(
        "已添加 2 张照片到「已创建相册」"
      );
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
