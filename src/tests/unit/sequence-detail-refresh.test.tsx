import { act, renderHook, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSequenceDetailRefresh } from "@/hooks/useSequenceDetailRefresh";
import type { PhotoSequenceDetail } from "@/types/photo-sequence";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/actions/photo-sequences", () => ({ photoSequenceActions: { get } }));
const detail = {
  id: 1,
  frameCount: 2,
  members: [{ id: 10 }, { id: 11 }],
  source: "auto",
  userLocked: false,
} as PhotoSequenceDetail;

describe("open sequence detail refresh", () => {
  it("closes a collection detail when none of its members remain in scope", async () => {
    get.mockResolvedValue(detail);
    const { result, rerender } = renderHook(
      ({ scope }) => {
        const [current, setCurrent] = useState<PhotoSequenceDetail | null>(
          detail
        );
        useSequenceDetailRefresh(0, current, setCurrent, scope);
        return current;
      },
      { initialProps: { scope: [10, 11] } }
    );
    rerender({ scope: [] });
    await waitFor(() => expect(result.current).toBeNull());
  });
  it("refreshes metadata and closes a consumed sequence", async () => {
    get
      .mockResolvedValueOnce({ ...detail, source: "manual", userLocked: true })
      .mockResolvedValueOnce(null);
    const { result, rerender } = renderHook(
      ({ version }) => {
        const [current, setCurrent] = useState<PhotoSequenceDetail | null>(
          detail
        );
        useSequenceDetailRefresh(version, current, setCurrent);
        return current;
      },
      { initialProps: { version: 0 } }
    );
    rerender({ version: 1 });
    await waitFor(() => expect(result.current?.userLocked).toBe(true));
    rerender({ version: 2 });
    await waitFor(() => expect(result.current).toBeNull());
  });
  it("does not reopen a closed view after a late refresh response", async () => {
    let resolve!: (value: PhotoSequenceDetail) => void;
    get.mockReturnValue(
      new Promise<PhotoSequenceDetail>((done) => {
        resolve = done;
      })
    );
    const { result, rerender } = renderHook(
      ({ version }) => {
        const [current, setCurrent] = useState<PhotoSequenceDetail | null>(
          detail
        );
        useSequenceDetailRefresh(version, current, setCurrent);
        return { current, setCurrent };
      },
      { initialProps: { version: 0 } }
    );
    rerender({ version: 1 });
    act(() => result.current.setCurrent(null));
    await act(async () => resolve(detail));
    expect(result.current.current).toBeNull();
  });
});
