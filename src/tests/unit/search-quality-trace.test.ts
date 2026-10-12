import { describe, expect, it, vi } from "vitest";
import {
  traceSearchQuality,
  withSearchQualityTrace,
} from "@/services/search-quality-trace";

describe("internal search quality trace", () => {
  it("does not build payloads when disabled and isolates concurrent requests", async () => {
    const payload = vi.fn(() => "disabled");
    traceSearchQuality("unused", payload);
    expect(payload).not.toHaveBeenCalled();
    const first = vi.fn();
    const second = vi.fn();
    await Promise.all([
      withSearchQualityTrace("first", first, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        traceSearchQuality("encoded", () => [1]);
      }),
      withSearchQualityTrace("second", second, async () => {
        await Promise.resolve();
        traceSearchQuality("encoded", () => [2]);
      }),
    ]);
    expect(first.mock.calls).toEqual([
      [{ requestId: "first", stage: "encoded", data: [1] }],
    ]);
    expect(second.mock.calls).toEqual([
      [{ requestId: "second", stage: "encoded", data: [2] }],
    ]);
  });

  it("does not change results when a diagnostic observer throws", () => {
    const result = withSearchQualityTrace(
      "request",
      () => {
        throw new Error("observer");
      },
      () => {
        traceSearchQuality("result", () => ({ photoId: 2 }));
        return 2;
      }
    );
    expect(result).toBe(2);
  });
});
