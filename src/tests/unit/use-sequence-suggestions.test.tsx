import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSequenceSuggestions } from "@/hooks/useSequenceSuggestions";
import type { SequenceSuggestion } from "@/types/photo-sequence";

const mocks = vi.hoisted(() => ({
  listSuggestions: vi.fn(),
  acceptSuggestion: vi.fn(),
}));
vi.mock("@/actions/photo-sequences", () => ({ photoSequenceActions: mocks }));
const suggestion = {
  id: 1,
  firstSequenceId: 10,
  secondSequenceId: 20,
} as SequenceSuggestion;
const related = {
  id: 2,
  firstSequenceId: 20,
  secondSequenceId: 30,
} as SequenceSuggestion;
function deferred<T>() {
  let resolve!: (result: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  mocks.listSuggestions.mockReset();
  mocks.acceptSuggestion.mockReset();
});

describe("continuation suggestion synchronization", () => {
  it("blocks duplicate and overlapping merges, clears old advice, and deduplicates broadcast", async () => {
    mocks.listSuggestions
      .mockResolvedValueOnce([suggestion, related])
      .mockResolvedValue([]);
    const pending = deferred<{
      status: "merged";
      id: number;
      revision: number;
    }>();
    mocks.acceptSuggestion.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useSequenceSuggestions());
    await waitFor(() => expect(result.current.suggestions).toHaveLength(2));
    let accepting!: Promise<unknown>;
    act(() => {
      accepting = result.current.accept(suggestion);
    });
    expect(result.current.busyIds).toEqual([10, 20]);
    await act(async () => {
      expect(await result.current.accept(related)).toBeNull();
    });
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: "sequences-changed", revision: 2 },
        })
      )
    );
    await act(async () => {
      pending.resolve({ status: "merged", id: 40, revision: 2 });
      await accepting;
    });
    expect(result.current.suggestions).toEqual([]);
    expect(mocks.acceptSuggestion).toHaveBeenCalledTimes(1);
    expect(mocks.listSuggestions).toHaveBeenCalledTimes(2);
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: "sequences-changed", revision: 2 },
        })
      )
    );
    expect(mocks.listSuggestions).toHaveBeenCalledTimes(2);
  });
  it("never reintroduces an old suggestion from a delayed query", async () => {
    const old = deferred<SequenceSuggestion[]>();
    mocks.listSuggestions
      .mockResolvedValueOnce([suggestion])
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue([]);
    mocks.acceptSuggestion.mockResolvedValue({
      status: "merged",
      id: 40,
      revision: 2,
    });
    const { result } = renderHook(() => useSequenceSuggestions());
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    act(() => {
      result.current.refresh();
    });
    await act(async () => {
      await result.current.accept(suggestion);
    });
    await act(async () => {
      old.resolve([suggestion]);
      await old.promise;
    });
    expect(result.current.suggestions).toEqual([]);
  });
  it("preserves failed merges but distinguishes refresh failure after success", async () => {
    mocks.listSuggestions.mockResolvedValue([suggestion]);
    mocks.acceptSuggestion.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useSequenceSuggestions());
    await waitFor(() => expect(result.current.suggestions).toHaveLength(1));
    await act(async () => {
      await expect(result.current.accept(suggestion)).rejects.toThrow(
        "offline"
      );
    });
    expect(result.current.suggestions).toEqual([suggestion]);
    mocks.acceptSuggestion.mockResolvedValue({
      status: "merged",
      id: 40,
      revision: 2,
    });
    mocks.listSuggestions.mockRejectedValueOnce(new Error("refresh failed"));
    await act(async () => {
      expect(await result.current.accept(suggestion)).toMatchObject({
        status: "merged",
      });
    });
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.error).toBe(true);
    expect(result.current.busyIds).toEqual([]);
    mocks.listSuggestions.mockResolvedValue([]);
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current.error).toBe(false);
  });
  it("rejects delayed folder results and revalidates when a window regains focus", async () => {
    const old = deferred<SequenceSuggestion[]>();
    mocks.listSuggestions
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue([]);
    const { result, rerender } = renderHook(
      ({ folderId }) => useSequenceSuggestions(folderId),
      { initialProps: { folderId: 1 } }
    );
    rerender({ folderId: 2 });
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => {
      old.resolve([suggestion]);
      await old.promise;
    });
    expect(result.current.suggestions).toEqual([]);
    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => expect(mocks.listSuggestions).toHaveBeenCalledTimes(3));
  });
});
