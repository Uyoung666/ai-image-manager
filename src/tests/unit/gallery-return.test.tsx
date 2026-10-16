import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useGalleryReturn } from "@/hooks/useGalleryReturn";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";
import {
  getGalleryReturnPresentation,
  resolveGalleryReturnTarget,
} from "@/utils/gallery-return";

const members = [10, 20, 30].map((id) => ({ id })) as Photo[];
const sequence = {
  id: 7,
  photo: members[0],
  memberPhotoIds: [10, 20, 30],
  matchedPhotoIds: [20, 30],
} as PhotoSequence;
const detail = { id: 7, members } as PhotoSequenceDetail;
const memberTarget = {
  kind: "sequence-member" as const,
  sequenceId: 7,
  photoId: 30,
};
const options = {
  contextKey: "album:1",
  photos: [{ id: 99 }],
  sequences: [sequence],
  details: [detail],
  ready: true,
};
afterEach(() => vi.useRealTimers());

describe("gallery return targets", () => {
  it("retains an unloaded member using the sequence membership", () => {
    expect(resolveGalleryReturnTarget(memberTarget, [], [sequence])).toBe(
      memberTarget
    );
  });
  it("uses a loaded detail when summary membership is unavailable", () => {
    const summary = {
      ...sequence,
      matchedPhotoIds: undefined,
      memberPhotoIds: undefined,
    };
    expect(
      resolveGalleryReturnTarget(memberTarget, [], [summary], [detail])
    ).toBe(memberTarget);
  });
  it("falls back to the sequence when a member is removed or filtered out", () => {
    expect(
      resolveGalleryReturnTarget(
        memberTarget,
        [],
        [{ ...sequence, matchedPhotoIds: [20] }],
        [detail]
      )
    ).toEqual({ kind: "sequence", sequenceId: 7 });
  });
  it("clears a sequence that is no longer visible", () => {
    expect(resolveGalleryReturnTarget(memberTarget, [], [])).toBeNull();
  });
  it("resolves a changed cover through the stable sequence ID", () => {
    expect(
      getGalleryReturnPresentation(
        memberTarget,
        [{ ...sequence, photo: members[1] }],
        null,
        null
      )
    ).toEqual({ itemId: 20, memberId: null, frame: 3 });
  });
  it("uses the full order rather than renumbering the filtered frames", () => {
    expect(
      getGalleryReturnPresentation(memberTarget, [sequence], null, null).frame
    ).toBe(3);
    expect(
      getGalleryReturnPresentation(
        memberTarget,
        [{ ...sequence, memberPhotoIds: [30, 10, 20] }],
        null,
        null
      ).frame
    ).toBe(1);
  });
  it("moves the marker between the cover and an expanded member", () => {
    expect(
      getGalleryReturnPresentation(memberTarget, [sequence], detail, detail)
    ).toEqual({ itemId: -7, memberId: 30, frame: 3 });
    expect(
      getGalleryReturnPresentation(memberTarget, [sequence], null, null)
    ).toEqual({ itemId: 10, memberId: null, frame: 3 });
  });
  it("does not invent a frame number for a sequence-only visit", () => {
    expect(
      getGalleryReturnPresentation(
        { kind: "sequence", sequenceId: 7 },
        [sequence],
        null,
        null
      ).frame
    ).toBeUndefined();
  });
});

describe("gallery return state", () => {
  it("starts the 1500ms pulse only after positioning and retains the label", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => result.current.markRecentlyViewed(30));
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.recentlyViewedReturnRequest).toBe(1);
    act(() => result.current.settleReturn(1));
    expect(result.current.recentlyViewedPulseActive).toBe(true);
    act(() => vi.advanceTimersByTime(1499));
    expect(result.current.recentlyViewedPulseActive).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
  });
  it("remembers nested playback without issuing a return before the detail closes", () => {
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => {
      result.current.beginSequence(7);
      result.current.rememberPhoto(30, 7);
    });
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    act(() => result.current.markSequence(7));
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
    expect(result.current.recentlyViewedReturnRequest).toBe(1);
  });
  it("records a viewed photo without returning or pulsing after returning to the top", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() =>
      result.current.markRecentlyViewed(99, undefined, {
        restorePosition: false,
      })
    );
    expect(result.current.recentlyViewedTarget).toEqual({
      kind: "photo",
      photoId: 99,
    });
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    act(() => result.current.settleReturn(1));
    act(() => vi.advanceTimersByTime(3000));
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    expect(result.current.recentlyViewedPhotoId).toBe(99);
  });
  it("records a sequence after returning to the top without restoring its position", () => {
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => result.current.beginSequence(7));
    act(() => result.current.markSequence(7, { restorePosition: false }));
    expect(result.current.recentlyViewedTarget).toEqual({
      kind: "sequence",
      sequenceId: 7,
    });
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    act(() => result.current.settleReturn(1));
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    act(() => result.current.markSequence(7));
    expect(result.current.recentlyViewedReturnRequest).toBe(2);
  });
  it("preserves the last viewed sequence member while suppressing a sequence return", () => {
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => {
      result.current.beginSequence(7);
      result.current.rememberPhoto(30, 7);
      result.current.markSequence(7, { restorePosition: false });
    });
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
  });
  it("cancels a pending return while allowing a later default photo return", () => {
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => result.current.markRecentlyViewed(99));
    expect(result.current.recentlyViewedReturnRequest).toBe(1);
    act(() =>
      result.current.markRecentlyViewed(99, undefined, {
        restorePosition: false,
      })
    );
    act(() => {
      result.current.settleReturn(1);
      result.current.settleReturn(2);
    });
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    act(() => result.current.markRecentlyViewed(99));
    expect(result.current.recentlyViewedReturnRequest).toBe(3);
    act(() => result.current.settleReturn(2));
    expect(result.current.recentlyViewedReturnRequest).toBe(3);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    act(() => result.current.settleReturn(3));
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    expect(result.current.recentlyViewedPulseActive).toBe(true);
  });
  it("stops an existing pulse without disabling later default sequence returns", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => result.current.markRecentlyViewed(30, 7));
    act(() => result.current.settleReturn(1));
    expect(result.current.recentlyViewedPulseActive).toBe(true);
    act(() =>
      result.current.markRecentlyViewed(30, 7, { restorePosition: false })
    );
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    act(() => result.current.markSequence(7));
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
    expect(result.current.recentlyViewedReturnRequest).toBe(3);
    act(() => result.current.settleReturn(3));
    expect(result.current.recentlyViewedPulseActive).toBe(true);
  });
  it("allows repeated returns and ignores stale or duplicate completion callbacks", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => result.current.markRecentlyViewed(30));
    act(() => result.current.markRecentlyViewed(30));
    act(() => result.current.settleReturn(1));
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    act(() => result.current.settleReturn(2));
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current.settleReturn(2));
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.recentlyViewedPulseActive).toBe(false);
  });
  it.each([
    "wheel",
    "pointerdown",
    "keydown",
  ])("cancels pending positioning on %s", (event) => {
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => result.current.markRecentlyViewed(30));
    fireEvent(window, new Event(event));
    act(() => result.current.settleReturn(1));
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
  });
  it("waits for a confirmed refresh before clearing invalid data", () => {
    const { result, rerender } = renderHook(
      (props) => useGalleryReturn(props),
      { initialProps: options }
    );
    act(() => result.current.markRecentlyViewed(30));
    rerender({ ...options, ready: false, sequences: [] });
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
    rerender({ ...options, sequences: [] });
    expect(result.current.recentlyViewedTarget).toBeNull();
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
  });
  it("clears the label on a context change", () => {
    const { result, rerender } = renderHook(
      (props) => useGalleryReturn(props),
      { initialProps: options }
    );
    act(() => result.current.markRecentlyViewed(30));
    rerender({ ...options, contextKey: "album:2" });
    expect(result.current.recentlyViewedTarget).toBeNull();
  });
  it("preserves a marker while stopping a pulse for a manual expansion change", () => {
    const { result } = renderHook(() => useGalleryReturn(options));
    act(() => result.current.markRecentlyViewed(30));
    act(() => result.current.settleReturn(1));
    act(() => result.current.stopPulse());
    expect(result.current.recentlyViewedTarget).toEqual(memberTarget);
    expect(result.current.recentlyViewedPulseActive).toBe(false);
    expect(result.current.recentlyViewedReturnRequest).toBe(0);
  });
});
