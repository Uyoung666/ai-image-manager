// @vitest-environment node
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  beginSearchRequest,
  cancelSearchRequest,
  createSearchDiagnostics,
  waitForSearch,
} from "@/services/search-control";

describe("search cancellation and timing", () => {
  it("does not cancel a different renderer's request", () => {
    const request = beginSearchRequest(1, "same-id");
    expect(cancelSearchRequest(2, "same-id")).toBe(false);
    expect(request.signal.aborted).toBe(false);
    expect(cancelSearchRequest(1, "same-id")).toBe(true);
    expect(request.signal.aborted).toBe(true);
    request.finish();
  });
  it("cancels only the subscriber to shared inference", async () => {
    let resolve!: (value: number) => void;
    const shared = new Promise<number>((done) => {
      resolve = done;
    });
    const controller = new AbortController();
    const first = waitForSearch(shared, {
      deadline: performance.now() + 1000,
      signal: controller.signal,
    });
    const second = waitForSearch(shared, {
      deadline: performance.now() + 1000,
    });
    controller.abort();
    await expect(first).rejects.toMatchObject({ reason: "cancelled" });
    resolve(42);
    await expect(second).resolves.toBe(42);
  });
  it("uses a common deadline and preserves unmeasured timings", async () => {
    await expect(
      waitForSearch(new Promise(() => undefined), {
        deadline: performance.now() + 5,
      })
    ).rejects.toMatchObject({ reason: "deadline" });
    expect(
      Object.values(createSearchDiagnostics().timings).every(
        (value) => value === null
      )
    ).toBe(true);
  });
});
