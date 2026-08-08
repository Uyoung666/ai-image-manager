import { act, renderHook } from "@testing-library/react";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useImportDropZones } from "@/hooks/use-import-drop-zones";
import { ipc } from "@/ipc/manager";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        scanFolder: vi.fn(),
      },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

interface DroppedItem {
  directory?: boolean;
  name: string;
  path: string;
}

function createDataTransfer(
  items: DroppedItem[],
  types = ["Files"]
): DataTransfer {
  const dataTransferItems = items.map((item) => ({
    getAsFile: () => ({ name: item.name, path: item.path }) as unknown as File,
    kind: "file",
    webkitGetAsEntry: () => ({ isDirectory: item.directory === true }),
  }));

  vi.mocked(window.electronAPI.getFilePath).mockImplementation(
    (file: File) => (file as File & { path?: string }).path ?? file.name
  );

  return {
    dropEffect: "none",
    items: dataTransferItems,
    types,
  } as unknown as DataTransfer;
}

function createDropEvent(dataTransfer: DataTransfer): React.DragEvent {
  return {
    dataTransfer,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as unknown as React.DragEvent;
}

describe("useImportDropZones", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { getFilePath: vi.fn() },
    });
    vi.mocked(ipc.client.photos.scanFolder).mockResolvedValue({
      id: 1,
      position: 1,
      status: "queued",
    });
  });

  it("shows the classified zones as soon as an external drag enters the app", () => {
    const { result } = renderHook(() =>
      useImportDropZones({ onImageSearch: vi.fn() })
    );
    const image = createDataTransfer([
      { name: "photo.jpg", path: "C:/Photos/photo.jpg" },
    ]);
    const enterEvent = createDropEvent(image);

    act(() => result.current.handleRootDragEnter(enterEvent));

    expect(result.current.dragKind).toBe("image");
    expect(enterEvent.stopPropagation).toHaveBeenCalled();
  });

  it("only searches for an image dropped in the image zone", async () => {
    const onImageSearch = vi.fn();
    const { result } = renderHook(() => useImportDropZones({ onImageSearch }));
    const image = createDataTransfer([
      { name: "photo.jpg", path: "C:/Photos/photo.jpg" },
    ]);
    const multipleImages = createDataTransfer([
      { name: "one.jpg", path: "C:/Photos/one.jpg" },
      { name: "two.jpg", path: "C:/Photos/two.jpg" },
    ]);

    await act(async () => {
      await result.current.handleZoneDrop(createDropEvent(image), "folders");
    });

    expect(onImageSearch).not.toHaveBeenCalled();
    expect(ipc.client.photos.scanFolder).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleZoneDrop(
        createDropEvent(multipleImages),
        "folders"
      );
    });

    expect(onImageSearch).not.toHaveBeenCalled();
    expect(ipc.client.photos.scanFolder).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleZoneDrop(createDropEvent(image), "image");
    });

    expect(onImageSearch).toHaveBeenCalledWith("C:/Photos/photo.jpg");
    expect(ipc.client.photos.scanFolder).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleZoneDrop(
        createDropEvent(multipleImages),
        "image"
      );
    });

    expect(onImageSearch).toHaveBeenCalledTimes(1);
    expect(ipc.client.photos.scanFolder).not.toHaveBeenCalled();
  });

  it("only scans folders dropped in the folder zone", async () => {
    const onImageSearch = vi.fn();
    const { result } = renderHook(() => useImportDropZones({ onImageSearch }));
    const folders = createDataTransfer([
      { directory: true, name: "Travel", path: "C:/Photos/Travel" },
      { directory: true, name: "Work", path: "C:/Photos/Work" },
    ]);

    await act(async () => {
      await result.current.handleZoneDrop(createDropEvent(folders), "image");
    });
    expect(onImageSearch).not.toHaveBeenCalled();
    expect(ipc.client.photos.scanFolder).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.handleZoneDrop(createDropEvent(folders), "folders");
    });

    expect(ipc.client.photos.scanFolder).toHaveBeenCalledTimes(2);
    expect(ipc.client.photos.scanFolder).toHaveBeenNthCalledWith(1, {
      path: "C:/Photos/Travel",
    });
    expect(ipc.client.photos.scanFolder).toHaveBeenNthCalledWith(2, {
      path: "C:/Photos/Work",
    });
  });

  it("reports folders already being scanned as duplicates, not failures", async () => {
    vi.mocked(ipc.client.photos.scanFolder).mockResolvedValue({
      id: 1,
      position: 0,
      status: "scanning",
    });
    const { result } = renderHook(() =>
      useImportDropZones({ onImageSearch: vi.fn() })
    );
    const folders = createDataTransfer([
      { directory: true, name: "Travel", path: "C:/Photos/Travel" },
    ]);

    await act(async () => {
      await result.current.handleZoneDrop(createDropEvent(folders), "folders");
    });

    expect(toast.info).toHaveBeenCalledWith("1 个文件夹已在导入队列中");
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("does not intercept internal photo drops at the application root", () => {
    const { result } = renderHook(() =>
      useImportDropZones({ onImageSearch: vi.fn() })
    );
    const event = createDropEvent(
      createDataTransfer(
        [{ name: "photo.jpg", path: "C:/Photos/photo.jpg" }],
        ["application/x-photo-ids", "Files"]
      )
    );

    act(() => result.current.handleRootDrop(event));

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });

  it("clears the external overlay when an internal photo drag enters", () => {
    const { result } = renderHook(() =>
      useImportDropZones({ onImageSearch: vi.fn() })
    );
    const image = createDataTransfer([
      { name: "photo.jpg", path: "C:/Photos/photo.jpg" },
    ]);
    const internalPhotos = createDataTransfer(
      [{ name: "photo.jpg", path: "C:/Photos/photo.jpg" }],
      ["application/x-photo-ids", "Files"]
    );

    act(() => result.current.handleRootDragEnter(createDropEvent(image)));
    expect(result.current.dragKind).toBe("image");

    act(() =>
      result.current.handleRootDragOver(createDropEvent(internalPhotos))
    );

    expect(result.current.dragKind).toBeNull();
  });

  it("rejects mixed folders and files without invoking import handlers", async () => {
    const onImageSearch = vi.fn();
    const { result } = renderHook(() => useImportDropZones({ onImageSearch }));
    const mixed = createDataTransfer([
      { directory: true, name: "Travel", path: "C:/Photos/Travel" },
      { name: "photo.jpg", path: "C:/Photos/photo.jpg" },
    ]);

    await act(async () => {
      await result.current.handleZoneDrop(createDropEvent(mixed), "folders");
    });

    expect(onImageSearch).not.toHaveBeenCalled();
    expect(ipc.client.photos.scanFolder).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });
});
