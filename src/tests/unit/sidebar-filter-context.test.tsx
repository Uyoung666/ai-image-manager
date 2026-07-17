import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
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

  it("atomically selects all photos and emits one search reset", () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <SidebarFilterProvider>{children}</SidebarFilterProvider>
    );
    const { result } = renderHook(() => useSidebarFilter(), { wrapper });
    const resetHandler = vi.fn();
    window.addEventListener("sidebar:clear-search", resetHandler);

    act(() => {
      result.current.selectFolderAndNotify(42);
      result.current.toggleTag(7);
      result.current.setFavoriteOnly(true);
    });
    resetHandler.mockClear();

    act(() => {
      result.current.selectAllPhotosAndNotify();
    });

    expect(result.current.activeFolderId).toBeNull();
    expect(result.current.activeTagIds).toEqual([]);
    expect(result.current.favoriteOnly).toBe(false);
    expect(resetHandler).toHaveBeenCalledTimes(1);

    window.removeEventListener("sidebar:clear-search", resetHandler);
  });
});
