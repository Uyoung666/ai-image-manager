import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browseCriteriaReducer,
  initialBrowseCriteriaState,
  SidebarFilterProvider,
  useSidebarFilter,
} from "@/contexts/SidebarFilterContext";

const {
  invalidateQueriesMock,
  openFolderDialogMock,
  scanFolderMock,
  toastErrorMock,
  toastSuccessMock,
} = vi.hoisted(() => ({
  invalidateQueriesMock: vi.fn(),
  openFolderDialogMock: vi.fn(),
  scanFolderMock: vi.fn(),
  toastErrorMock: vi.fn(),
  toastSuccessMock: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: { scanFolder: scanFolderMock },
      shell: { openFolderDialog: openFolderDialogMock },
    },
  },
}));

vi.mock("@/providers/QueryProvider", () => ({
  queryClient: { invalidateQueries: invalidateQueriesMock },
}));

vi.mock("sonner", () => ({
  toast: { error: toastErrorMock, success: toastSuccessMock },
}));

describe("SidebarFilterContext", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    openFolderDialogMock.mockResolvedValue({ path: null });
    scanFolderMock.mockResolvedValue({
      id: 1,
      position: 1,
      status: "queued",
    });
  });

  function createWrapper() {
    return ({ children }: { children: ReactNode }) => (
      <SidebarFilterProvider>{children}</SidebarFilterProvider>
    );
  }

  it("shows a distinct error when folder selection fails", async () => {
    openFolderDialogMock.mockRejectedValue(
      new Error("Unable to open D:\\private\\photos")
    );
    const { result } = renderHook(() => useSidebarFilter(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.handleAddFolder();
    });

    expect(scanFolderMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith("无法打开文件夹选择器，请重试");
    expect(toastErrorMock.mock.calls[0]?.[0]).not.toContain("D:\\private");
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("shows a generic error when adding the selected folder fails", async () => {
    const folderPath = "D:\\private\\photos";
    scanFolderMock.mockRejectedValue(
      new Error(`Folder does not exist: ${folderPath}`)
    );
    const { result } = renderHook(() => useSidebarFilter(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.handleAddFolder(folderPath);
    });

    expect(scanFolderMock).toHaveBeenCalledWith({ path: folderPath });
    expect(toastErrorMock).toHaveBeenCalledWith("扫描文件夹失败，请重试");
    expect(toastErrorMock.mock.calls[0]?.[0]).not.toContain(folderPath);
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("does not report an error when folder selection is cancelled", async () => {
    const { result } = renderHook(() => useSidebarFilter(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.handleAddFolder();
    });

    expect(openFolderDialogMock).toHaveBeenCalledWith({});
    expect(scanFolderMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("queues a selected folder and reports success", async () => {
    const folderPath = "D:\\photos";
    openFolderDialogMock.mockResolvedValue({ path: folderPath });
    const { result } = renderHook(() => useSidebarFilter(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.handleAddFolder();
    });

    expect(scanFolderMock).toHaveBeenCalledWith({ path: folderPath });
    expect(invalidateQueriesMock).toHaveBeenNthCalledWith(1, {
      queryKey: ["folders"],
    });
    expect(invalidateQueriesMock).toHaveBeenNthCalledWith(2, {
      queryKey: ["photos"],
      refetchType: "active",
    });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "已加入后台导入队列，请留意顶部状态栏"
    );
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("reports queued refresh failure after attempting both list invalidations", async () => {
    const folderPath = "D:\\photos";
    invalidateQueriesMock.mockRejectedValueOnce(
      new Error("Database error for D:\\private\\catalog")
    );
    const { result } = renderHook(() => useSidebarFilter(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.handleAddFolder(folderPath);
    });

    expect(invalidateQueriesMock).toHaveBeenCalledTimes(2);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith(
      "已加入导入队列但列表刷新失败",
      expect.objectContaining({
        action: expect.objectContaining({
          label: "retry",
          onClick: expect.any(Function),
        }),
      })
    );
    expect(toastErrorMock.mock.calls[0]?.[0]).not.toContain("D:\\private");
  });

  it("retries both list invalidations from the refresh failure toast", async () => {
    const folderPath = "photos";
    invalidateQueriesMock
      .mockRejectedValueOnce(new Error("first refresh failed"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(() => useSidebarFilter(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      await result.current.handleAddFolder(folderPath);
    });

    const options = toastErrorMock.mock.calls[0]?.[1] as
      | {
          action?: {
            label?: string;
            onClick?: () => void;
          };
        }
      | undefined;
    expect(options?.action?.label).toBe("retry");
    expect(options?.action?.onClick).toEqual(expect.any(Function));

    await act(async () => {
      await options?.action?.onClick?.();
    });
    await waitFor(() => expect(invalidateQueriesMock).toHaveBeenCalledTimes(4));
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "已加入后台导入队列，请留意顶部状态栏"
    );
  });

  it("atomically selects all photos and clears every browse criterion", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SidebarFilterProvider>{children}</SidebarFilterProvider>
    );
    const { result } = renderHook(() => useSidebarFilter(), { wrapper });
    act(() => {
      result.current.selectFolder(42);
      result.current.toggleTag(7);
      result.current.setFavoriteOnly(true);
    });

    act(() => {
      result.current.selectAllPhotos();
    });

    expect(result.current.activeFolderId).toBeNull();
    expect(result.current.activeTagIds).toEqual([]);
    expect(result.current.favoriteOnly).toBe(false);
    expect(result.current.appliedSearch).toBeNull();
    expect(result.current.searchDraft).toEqual({ filters: {}, query: "" });
  });

  it("reduces applied search and all-photos reset as one state transition", () => {
    const searched = browseCriteriaReducer(initialBrowseCriteriaState, {
      type: "applySearch",
      criteria: {
        filters: { cameraModel: "Example Camera", isoMin: "800" },
        mode: "exif",
        query: "night",
      },
    });
    const reset = browseCriteriaReducer(searched, {
      type: "selectAllPhotos",
    });

    expect(searched.searchDraft.query).toBe("night");
    expect(searched.appliedSearch?.filters.isoMin).toBe("800");
    expect(reset).toMatchObject({
      activeFolderId: null,
      activeTagIds: [],
      appliedSearch: null,
      favoriteOnly: false,
      searchDraft: { filters: {}, query: "" },
      searchResetVersion: 1,
    });
  });

  it("keeps the reference path in applied image-search criteria", () => {
    const searched = browseCriteriaReducer(initialBrowseCriteriaState, {
      type: "applySearch",
      criteria: {
        filters: {},
        imagePath: "D:\\references\\source.jpg",
        mode: "image",
        query: "",
      },
    });

    expect(searched.appliedSearch).toMatchObject({
      imagePath: "D:\\references\\source.jpg",
      mode: "image",
      query: "",
    });
    expect(searched.searchDraft.query).toBe("");
  });

  it("selects a folder while clearing the previously applied search", () => {
    const searched = browseCriteriaReducer(initialBrowseCriteriaState, {
      type: "applySearch",
      criteria: { filters: {}, mode: "text", query: "sunset" },
    });
    const folderState = browseCriteriaReducer(searched, {
      type: "selectFolder",
      id: 9,
    });

    expect(folderState.activeFolderId).toBe(9);
    expect(folderState.appliedSearch).toBeNull();
    expect(folderState.searchDraft).toEqual({ filters: {}, query: "" });
  });

  it("atomically selects tag filters and clears free-text search state", () => {
    const searched = browseCriteriaReducer(initialBrowseCriteriaState, {
      type: "applySearch",
      criteria: { filters: {}, mode: "text", query: "自行车" },
    });
    const tagState = browseCriteriaReducer(searched, {
      type: "selectTags",
      tagIds: [42, 42, 51],
    });

    expect(tagState.activeTagIds).toEqual([42, 51]);
    expect(tagState.appliedSearch).toBeNull();
    expect(tagState.searchDraft).toEqual({ filters: {}, query: "" });
    expect(tagState.favoriteOnly).toBe(false);
  });
});
