import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  browseCriteriaReducer,
  initialBrowseCriteriaState,
  SidebarFilterProvider,
  useSidebarFilter,
} from "@/contexts/SidebarFilterContext";

vi.mock("@/ipc/manager", () => ({
  ipc: { client: {} },
}));

vi.mock("@/providers/QueryProvider", () => ({
  queryClient: { invalidateQueries: vi.fn() },
}));

describe("SidebarFilterContext", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
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
});
