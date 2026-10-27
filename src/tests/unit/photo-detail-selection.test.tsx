import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePhotoDetailPanel } from "@/hooks/usePhotoDetailPanel";
import type { Photo } from "@/types/photo";
import { notifyTagsChanged } from "@/utils/tag-change-event";

const session = vi.hoisted(() => ({
  getSession: () => ({ detailDismissed: false }),
  saveSession: vi.fn(),
}));
vi.mock("@/contexts/BrowseSessionContext", () => ({
  useBrowseSession: () => session,
}));
const photos: Photo[] = [1, 2].map((id) => ({
  id,
  path: `C:/fixture/${id}.jpg`,
  filename: `${id}.jpg`,
  width: 100,
  height: 100,
  fileSize: 1024,
  isIndexed: true,
  thumbnailPath: null,
}));

describe("photo details and batch selection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps a tag-edit inspector after the photo leaves the visible selection and navigates to surviving neighbors", () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected, visible }) =>
        usePhotoDetailPanel(selected, visible, "home", onSelect, true),
      { initialProps: { selected: new Set([1]), visible: photos } }
    );
    act(() => notifyTagsChanged({ photoIds: [1], source: "detail" }));
    rerender({ selected: new Set(), visible: photos.slice(1) });
    expect(result.current.detailPhoto?.id).toBe(1);
    expect(onSelect).not.toHaveBeenCalled();
    act(() => result.current.navigateDetail("next"));
    expect(result.current.detailPhoto?.id).toBe(2);
    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("keeps details through an empty result and clears the edit session on close or scope change", () => {
    const { result, rerender } = renderHook(
      ({ selected, visible, route }) =>
        usePhotoDetailPanel(selected, visible, route, vi.fn(), true),
      {
        initialProps: {
          selected: new Set([1]),
          visible: photos,
          route: "home",
        },
      }
    );
    act(() => notifyTagsChanged({ photoIds: [1], source: "detail" }));
    rerender({ selected: new Set(), visible: [], route: "home" });
    expect(result.current.detailPhoto?.id).toBe(1);
    act(() => result.current.navigateDetail("next"));
    expect(result.current.detailPhoto?.id).toBe(1);
    act(() => result.current.dismissDetail());
    rerender({ selected: new Set(), visible: photos, route: "home" });
    expect(result.current.detailPhoto).toBeNull();
    rerender({ selected: new Set([1]), visible: photos, route: "home" });
    act(() => notifyTagsChanged({ photoIds: [1], source: "detail" }));
    rerender({ selected: new Set(), visible: [], route: "other" });
    expect(result.current.detailPhoto).toBeNull();
  });

  it("ends a retained edit when the user selects a batch", () => {
    const { result, rerender } = renderHook(
      ({ selected }) =>
        usePhotoDetailPanel(selected, photos, "home", vi.fn(), true),
      { initialProps: { selected: new Set([1]) } }
    );
    act(() => notifyTagsChanged({ photoIds: [1], source: "detail" }));
    rerender({ selected: new Set([1, 2]) });
    expect(result.current.detailPhoto).toBeNull();
    rerender({ selected: new Set() });
    expect(result.current.detailPhoto).toBeNull();
  });

  it("closes single-photo details when multiple photos are selected", () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }) =>
        usePhotoDetailPanel(selected, photos, "fixture", onSelect),
      { initialProps: { selected: new Set([1]) } }
    );
    expect(result.current.detailPhoto?.id).toBe(1);
    const selected = new Set([1, 2]);
    rerender({ selected });
    expect(result.current.detailPhoto).toBeNull();
    expect(selected).toEqual(new Set([1, 2]));
    expect(onSelect).not.toHaveBeenCalled();

    // Reducing the batch back to its original photo must reopen the inspector.
    rerender({ selected: new Set([1]) });
    expect(result.current.detailPhoto?.id).toBe(1);
    expect(result.current.detailDismissed).toBe(false);
  });

  it("keeps manual dismissal and navigation working after a batch selection", () => {
    const onSelect = vi.fn();
    const { result, rerender } = renderHook(
      ({ selected }) =>
        usePhotoDetailPanel(selected, photos, "fixture", onSelect),
      { initialProps: { selected: new Set([1, 2]) } }
    );
    expect(result.current.detailPhoto).toBeNull();
    rerender({ selected: new Set([1]) });
    act(() => result.current.navigateDetail("next"));
    expect(result.current.detailPhoto?.id).toBe(2);
    expect(onSelect).toHaveBeenCalledWith(2);
    act(() => result.current.dismissDetail());
    expect(result.current.detailPhoto).toBeNull();
    expect(result.current.detailDismissed).toBe(true);
    expect(session.saveSession).toHaveBeenLastCalledWith("fixture", {
      detailDismissed: true,
    });
  });
});
