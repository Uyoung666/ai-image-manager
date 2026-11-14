/** @vitest-environment node */
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  isLibraryForegroundBusy,
  noteLibraryForegroundActivity,
  waitForLibraryForegroundIdle,
} from "@/services/library-foreground";
import { releaseGalleryResources } from "@/utils/gallery-lifecycle";

// Node's promise timers use internal scheduling. Adapt them to Vitest's fake
// clock while retaining cancellation and the requested event-loop reference.
vi.mock("node:timers/promises", () => ({
  setTimeout: vi.fn(
    (
      ms: number,
      _value: unknown,
      options?: { ref?: boolean; signal?: AbortSignal }
    ) =>
      new Promise<void>((resolve, reject) => {
        const signal = options?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", abort);
          resolve();
        }, ms);
        const abort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        if (options?.ref === false) {
          timer.unref();
        }
      })
  ),
}));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.mocked(delay).mockClear();
  releaseGalleryResources();
});

afterEach(async () => {
  releaseGalleryResources();
  await vi.runOnlyPendingTimersAsync();
  vi.useRealTimers();
});

it("returns immediately without scheduling a timer when browsing is idle", async () => {
  const isCurrent = vi.fn(() => true);
  expect(isLibraryForegroundBusy()).toBe(false);
  await expect(waitForLibraryForegroundIdle(isCurrent)).resolves.toBe(true);
  expect(isCurrent).toHaveBeenCalledTimes(1);
  expect(delay).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("expires a foreground lease after 300 milliseconds", async () => {
  noteLibraryForegroundActivity();
  expect(isLibraryForegroundBusy()).toBe(true);
  await vi.advanceTimersByTimeAsync(299);
  expect(isLibraryForegroundBusy()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(isLibraryForegroundBusy()).toBe(false);
  expect(delay).not.toHaveBeenCalled();
});

it("renews the deadline from the latest activity without a permanent busy flag", async () => {
  noteLibraryForegroundActivity();
  await vi.advanceTimersByTimeAsync(250);
  noteLibraryForegroundActivity();
  await vi.advanceTimersByTimeAsync(299);
  expect(isLibraryForegroundBusy()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(isLibraryForegroundBusy()).toBe(false);
});

it("waits in bounded unreferenced intervals and leaves no idle polling timer", async () => {
  noteLibraryForegroundActivity();
  const settled = vi.fn();
  const waiting = waitForLibraryForegroundIdle(() => true);
  waiting.then(settled);
  await vi.advanceTimersByTimeAsync(299);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(waiting).resolves.toBe(true);
  expect(delay).toHaveBeenCalledTimes(6);
  for (const [ms, , options] of vi.mocked(delay).mock.calls) {
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(50);
    expect(options?.ref).toBe(false);
  }
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(delay).toHaveBeenCalledTimes(6);
});

it("keeps an existing waiter paused when browsing renews the lease", async () => {
  noteLibraryForegroundActivity();
  const settled = vi.fn();
  const waiting = waitForLibraryForegroundIdle(() => true);
  waiting.then(settled);
  await vi.advanceTimersByTimeAsync(250);
  noteLibraryForegroundActivity();
  await vi.advanceTimersByTimeAsync(299);
  expect(settled).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await expect(waiting).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it("stops an obsolete caller within one check interval", async () => {
  noteLibraryForegroundActivity();
  let current = true;
  const waiting = waitForLibraryForegroundIdle(() => current);
  await vi.advanceTimersByTimeAsync(1);
  current = false;
  await vi.advanceTimersByTimeAsync(49);
  await expect(waiting).resolves.toBe(false);
  expect(delay).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects an obsolete caller without waiting even when there is no activity", async () => {
  await expect(waitForLibraryForegroundIdle(() => false)).resolves.toBe(false);
  expect(delay).not.toHaveBeenCalled();
});

it("returns false for a signal that was already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const isCurrent = vi.fn(() => true);
  await expect(
    waitForLibraryForegroundIdle(isCurrent, controller.signal)
  ).resolves.toBe(false);
  expect(isCurrent).not.toHaveBeenCalled();
  expect(delay).not.toHaveBeenCalled();
});

it("cancels an outstanding timer as soon as its signal is aborted", async () => {
  noteLibraryForegroundActivity();
  const controller = new AbortController();
  const waiting = waitForLibraryForegroundIdle(() => true, controller.signal);
  expect(vi.getTimerCount()).toBe(1);
  controller.abort();
  await expect(waiting).resolves.toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("resets the lease and invalidates old waiters when gallery resources change", async () => {
  noteLibraryForegroundActivity();
  const previous = waitForLibraryForegroundIdle(() => true);
  releaseGalleryResources();
  expect(isLibraryForegroundBusy()).toBe(false);
  noteLibraryForegroundActivity();
  const current = waitForLibraryForegroundIdle(() => true);
  await vi.advanceTimersByTimeAsync(50);
  await expect(previous).resolves.toBe(false);
  expect(isLibraryForegroundBusy()).toBe(true);
  await vi.advanceTimersByTimeAsync(250);
  await expect(current).resolves.toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
