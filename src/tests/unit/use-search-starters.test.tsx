import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { searchStarterActions } from "@/actions/search-starters";
import {
  clearSearchStarterCache,
  useSearchStarters,
} from "@/features/search-bar/use-search-starters";
import type { SearchStarterResponse } from "@/types/search-starters";

vi.mock("@/actions/search-starters", () => ({
  searchStarterActions: { get: vi.fn(), fallbacks: vi.fn() },
}));

function ready(revision = "first"): SearchStarterResponse {
  return {
    day: "2026-10-27",
    revision,
    validity: "same-library",
    status: "ready",
    candidates: Array.from({ length: 12 }, (_, index) => ({
      key: `${revision}-${index}`,
      text: `${revision} theme ${index}`,
      topics: [`${revision}-${index}`],
      source: (["library", "library", "interest", "rediscovery"] as const)[
        Math.floor(index / 3)
      ],
    })),
  };
}
const initial = {
  open: true,
  enabled: true,
  language: "zh",
  history: [] as string[],
  filters: {},
};

beforeEach(() => {
  clearSearchStarterCache();
  vi.mocked(searchStarterActions.get).mockReset().mockResolvedValue(ready());
  vi.mocked(searchStarterActions.fallbacks)
    .mockReset()
    .mockResolvedValue({ ...ready(), candidates: [], status: "empty" });
});
afterEach(() => vi.useRealTimers());

describe("search starter loading and cache", () => {
  it("loads asynchronously without exposing fabricated examples", async () => {
    let resolve: ((response: SearchStarterResponse) => void) | undefined;
    vi.mocked(searchStarterActions.get).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const { result } = renderHook(() => useSearchStarters(initial));
    expect(result.current).toMatchObject({ loading: true, batch: [] });
    await waitFor(() => expect(resolve).toBeDefined());
    await act(() => resolve?.(ready()));
    expect(result.current.loading).toBe(false);
    expect(result.current.batch).toHaveLength(4);
  });

  it("keeps the selected batch across reopenings and rotates within a cached pool", async () => {
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    const before = result.current.batch.map((item) => item.key);
    await act(async () => {
      await result.current.refresh();
    });
    const after = result.current.batch.map((item) => item.key);
    expect(after.every((key) => !before.includes(key))).toBe(true);
    rerender({ ...initial, open: false });
    rerender(initial);
    expect(result.current.batch.map((item) => item.key)).toEqual(after);
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("remembers multiple batches across reopenings instead of alternating between two", async () => {
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    const seen = new Set(result.current.batch.map((item) => item.key));
    for (let round = 0; round < 2; round++) {
      rerender({ ...initial, open: false });
      rerender(initial);
      await waitFor(() => expect(result.current.loading).toBe(false));
      await act(async () => {
        await result.current.refresh();
      });
      expect(result.current.batch.every((item) => !seen.has(item.key))).toBe(
        true
      );
      for (const item of result.current.batch) {
        seen.add(item.key);
      }
    }
    expect(seen.size).toBe(12);
  });

  it("rotates away from the visible batch when an updated pool has been prepared in the background", async () => {
    const { result } = renderHook(() => useSearchStarters(initial));
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    const before = result.current.batch;
    vi.mocked(searchStarterActions.get).mockResolvedValue({
      ...ready(),
      revision: "new-revision",
    });
    act(() => window.dispatchEvent(new Event("tags-changed")));
    await waitFor(() =>
      expect(searchStarterActions.get).toHaveBeenCalledTimes(2)
    );
    expect(result.current.batch).toEqual(before);
    await act(async () => {
      await result.current.refresh();
    });
    expect(
      result.current.batch.every(
        (item) => !before.some((shown) => shown.key === item.key)
      )
    ).toBe(true);
  });

  it("keeps the open batch stable when a newer revision arrives, and uses it on reopening", async () => {
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    rerender({ ...initial, open: false });
    vi.mocked(searchStarterActions.get).mockResolvedValue(ready("updated"));
    rerender(initial);
    await waitFor(() =>
      expect(searchStarterActions.get).toHaveBeenCalledTimes(2)
    );
    expect(result.current.batch[0].key).toContain("first");
    rerender({ ...initial, open: false });
    rerender(initial);
    expect(result.current.batch[0].key).toContain("updated");
  });

  it("rejects late responses for a previous filter scope", async () => {
    const replies: Array<(response: SearchStarterResponse) => void> = [];
    vi.mocked(searchStarterActions.get).mockImplementation(
      () =>
        new Promise((done) => {
          replies.push(done);
        })
    );
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      { initialProps: { ...initial, filters: { cameraModel: "Canon" } } }
    );
    await waitFor(() => expect(replies).toHaveLength(1));
    rerender({ ...initial, filters: { cameraModel: "Nikon" } });
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(() => replies[0](ready("old")));
    expect(result.current.batch).toEqual([]);
    await act(() => replies[1](ready("new")));
    expect(result.current.batch[0].key).toContain("new");
    expect(searchStarterActions.get).toHaveBeenLastCalledWith(
      expect.objectContaining({ filters: { cameraModel: "Nikon" } })
    );
  });

  it("rotates valid cached cards even when background refresh fails and allows retry", async () => {
    const { result } = renderHook(() => useSearchStarters(initial));
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    const before = result.current.batch;
    vi.mocked(searchStarterActions.get).mockRejectedValueOnce(
      new Error("IPC disconnected")
    );
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current).toMatchObject({
      loading: false,
      status: "ready",
    });
    expect(result.current.batch).toHaveLength(4);
    expect(result.current.batch).not.toEqual(before);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.batch).not.toEqual(before);
  });

  it("shows metadata cards before a slow semantic response and applies new themes on reopening", async () => {
    let finish: ((response: SearchStarterResponse) => void) | undefined;
    vi.mocked(searchStarterActions.get).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    vi.mocked(searchStarterActions.fallbacks).mockResolvedValue({
      ...ready(),
      candidates: [
        {
          kind: "month",
          key: "month:2023-02",
          text: "2023年2月",
          query: "",
          filters: { dateFrom: "2023-02-01", dateTo: "2023-02-28" },
          source: "library",
          topics: ["month:2023-02"],
          previewPhotoIds: [1, 2],
        },
      ],
    });
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.batch[0]?.kind).toBe("month"));
    expect(result.current.loading).toBe(false);
    await act(() => finish?.(ready()));
    expect(result.current.batch[0].kind).toBe("month");
    rerender({ ...initial, open: false });
    rerender(initial);
    expect(result.current.batch).toHaveLength(4);
    expect(result.current.batch.some((item) => item.kind !== "month")).toBe(
      true
    );
  });

  it("retains executable cards through busy and failed preference revisions", async () => {
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    const before = result.current.batch;
    for (const status of ["busy", "error"] as const) {
      vi.mocked(searchStarterActions.get).mockResolvedValue({
        ...ready("preferences-changed"),
        status,
        candidates: [],
      });
      act(() => window.dispatchEvent(new Event("tags-changed")));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.batch).toEqual(before);
    }
    rerender({ ...initial, history: ["new query"] });
    expect(result.current.batch).toEqual(before);
  });

  it("keeps month and tag entry points available while the model is unavailable", async () => {
    vi.mocked(searchStarterActions.fallbacks).mockResolvedValue({
      ...ready(),
      candidates: [
        {
          kind: "tag",
          key: "tag:1",
          text: "海滩",
          query: '"海滩"',
          source: "library",
          topics: ["海滩"],
          previewPhotoIds: [1],
        },
      ],
    });
    const { result } = renderHook(() =>
      useSearchStarters({ ...initial, semanticEnabled: false })
    );
    await waitFor(() => expect(result.current.batch[0]?.kind).toBe("tag"));
    expect(result.current.status).toBe("ready");
    expect(searchStarterActions.get).not.toHaveBeenCalled();
  });

  it("does not keep obsolete semantic cards when a newer eligibility snapshot cannot be rechecked", async () => {
    const { result } = renderHook(() => useSearchStarters(initial));
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    vi.mocked(searchStarterActions.get).mockResolvedValue({
      ...ready("changed-model"),
      validity: "changed-model",
      candidates: [],
      status: "busy",
    });
    vi.mocked(searchStarterActions.fallbacks)
      .mockResolvedValueOnce({ ...ready(), status: "empty", candidates: [] })
      .mockRejectedValueOnce(new Error("metadata unavailable"));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current).toMatchObject({
      batch: [],
      status: "error",
      loading: false,
    });
  });

  it("drops a cached batch when a failed response proves its revision is obsolete", async () => {
    const { result } = renderHook(() => useSearchStarters(initial));
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    vi.mocked(searchStarterActions.fallbacks).mockResolvedValue({
      ...ready("changed-library"),
      validity: "changed-library",
      candidates: [],
      status: "empty",
    });
    vi.mocked(searchStarterActions.get).mockResolvedValue({
      ...ready("changed-library"),
      validity: "changed-library",
      candidates: [],
      status: "error",
    });
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current).toMatchObject({
      batch: [],
      status: "error",
      loading: false,
    });
  });

  it("prepares tag updates without replacing the currently open batch", async () => {
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    vi.mocked(searchStarterActions.get).mockResolvedValue(ready("new-tags"));
    act(() => window.dispatchEvent(new Event("tags-changed")));
    await waitFor(() =>
      expect(searchStarterActions.get).toHaveBeenCalledTimes(2)
    );
    expect(result.current.batch[0].key).toContain("first");
    rerender({ ...initial, open: false });
    rerender(initial);
    expect(result.current.batch[0].key).toContain("new-tags");
  });

  it("rebuilds the daily default and uses exact local day boundaries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 27, 12));
    const { result, rerender } = renderHook(
      (props) => useSearchStarters(props),
      {
        initialProps: {
          ...initial,
          filters: { dateFrom: "2023-02-01", dateTo: "2023-02-28" },
        },
      }
    );
    await waitFor(() => expect(result.current.batch).toHaveLength(4));
    expect(searchStarterActions.get).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: {
          dateFrom: new Date(2023, 1, 1, 0, 0, 0, 0).getTime(),
          dateTo: new Date(2023, 1, 28, 23, 59, 59, 999).getTime(),
        },
      })
    );
    vi.setSystemTime(new Date(2026, 9, 28, 8));
    vi.mocked(searchStarterActions.get).mockResolvedValue({
      ...ready("next-day"),
      day: "2026-10-28",
    });
    rerender({
      ...initial,
      filters: { dateFrom: "2023-02-01", dateTo: "2023-02-28" },
    });
    await waitFor(() =>
      expect(result.current.batch[0].key).toContain("next-day")
    );
  });
});
