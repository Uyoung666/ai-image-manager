import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useGallerySnapshot } from "@/hooks/useGallerySnapshot";

const gallery = (scope: string) => ({
  routeKey: scope,
  photos: [`${scope}-photo`],
  sequences: [`${scope}-sequence`],
});

describe("gallery snapshot", () => {
  it.each([
    "photos",
    "sequences",
  ] as const)("keeps the committed folder while target %s are pending", (pending) => {
    const a = gallery("A");
    const b = gallery("B");
    const { result, rerender } = renderHook(useGallerySnapshot, {
      initialProps: { enabled: true, ready: true, value: a },
    });
    rerender({
      enabled: true,
      ready: false,
      value: { ...b, [pending]: a[pending] },
    });
    expect(result.current.value).toBe(a);
    expect(result.current.retaining).toBe(true);
    rerender({ enabled: true, ready: true, value: b });
    expect(result.current.value).toBe(b);
    expect(result.current.retaining).toBe(false);
  });

  it("ignores an intermediate response during rapid folder switching", () => {
    const a = gallery("A");
    const b = gallery("B");
    const c = gallery("C");
    const { result, rerender } = renderHook(useGallerySnapshot, {
      initialProps: { enabled: true, ready: true, value: a },
    });
    rerender({ enabled: true, ready: false, value: b });
    rerender({ enabled: true, ready: false, value: c });
    rerender({
      enabled: true,
      ready: false,
      value: { ...c, photos: b.photos },
    });
    expect(result.current.value).toBe(a);
    rerender({ enabled: true, ready: true, value: c });
    expect(result.current.value).toBe(c);
  });

  it("allows the initial loading state and commits empty folders", () => {
    const empty: ReturnType<typeof gallery> = {
      routeKey: "empty",
      photos: [],
      sequences: [],
    };
    const { result, rerender } = renderHook(useGallerySnapshot, {
      initialProps: { enabled: true, ready: false, value: empty },
    });
    expect(result.current.retaining).toBe(false);
    rerender({ enabled: true, ready: true, value: empty });
    rerender({ enabled: true, ready: false, value: gallery("B") });
    expect(result.current.value).toBe(empty);
  });

  it("shows failures or search results instead of retaining another folder", () => {
    const a = gallery("A");
    const failure = gallery("failed-B");
    const { result, rerender } = renderHook(useGallerySnapshot, {
      initialProps: { enabled: true, ready: true, value: a },
    });
    rerender({ enabled: false, ready: false, value: failure });
    expect(result.current.value).toBe(failure);
    expect(result.current.retaining).toBe(false);
    rerender({ enabled: true, ready: false, value: gallery("retry-B") });
    expect(result.current.retaining).toBe(false);
  });
});
