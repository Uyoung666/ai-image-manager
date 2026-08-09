import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "@/hooks/use-media-query";

describe("useMediaQuery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tracks viewport query changes", () => {
    let matches = false;
    const listeners = new Set<() => void>();
    const matchMedia = vi.fn((query: string) => ({
      addEventListener: (_type: string, listener: () => void) => {
        listeners.add(listener);
      },
      dispatchEvent: () => true,
      matches,
      media: query,
      onchange: null,
      removeEventListener: (_type: string, listener: () => void) => {
        listeners.delete(listener);
      },
    }));
    vi.stubGlobal("matchMedia", matchMedia);

    const { result } = renderHook(() => useMediaQuery("(max-width: 840px)"));
    expect(result.current).toBe(false);

    act(() => {
      matches = true;
      for (const listener of listeners) {
        listener();
      }
    });

    expect(result.current).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(max-width: 840px)");
  });

  it("falls back safely when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);

    const { result } = renderHook(() => useMediaQuery("(max-width: 840px)"));

    expect(result.current).toBe(false);
  });
});
