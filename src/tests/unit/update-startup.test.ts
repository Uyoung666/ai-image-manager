// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpdateStartupConfirmation } from "@/services/update-startup";

let confirmation: UpdateStartupConfirmation;
const complete = vi.fn();
const failure = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  confirmation = new UpdateStartupConfirmation(complete, failure);
  confirmation.begin();
});
afterEach(() => {
  confirmation.stop();
  vi.useRealTimers();
});
describe("update startup confirmation", () => {
  it("retains a known critical failure if installer recovery delays confirmation", () => {
    confirmation.stop();
    confirmation.criticalReady(false);
    confirmation.begin();
    expect(failure).toHaveBeenCalledOnce();
    expect(confirmation.context()).toBeNull();
  });
  it.each([
    true,
    false,
  ])("waits for both signals and five seconds, renderer first: %s", async (rendererFirst) => {
    const nonce = confirmation.context()?.nonce ?? "";
    if (rendererFirst) {
      confirmation.acknowledge(nonce);
    } else {
      confirmation.criticalReady(true);
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(complete).not.toHaveBeenCalled();
    if (rendererFirst) {
      confirmation.criticalReady(true);
    } else {
      confirmation.acknowledge(nonce);
    }
    await vi.advanceTimersByTimeAsync(4999);
    expect(complete).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("rejects duplicate and stale document acknowledgements", () => {
    const old = confirmation.context()?.nonce ?? "";
    confirmation.documentChanged();
    expect(confirmation.acknowledge(old)).toBe(false);
    const nonce = confirmation.context()?.nonce ?? "";
    expect(confirmation.acknowledge(nonce)).toBe(true);
    expect(confirmation.acknowledge(nonce)).toBe(false);
  });
  it("keeps the original deadline across repeated health signals", async () => {
    for (let count = 0; count < 1200; count++) {
      await vi.advanceTimersByTimeAsync(100);
      confirmation.criticalReady(true);
    }
    expect(failure).toHaveBeenCalledOnce();
    expect(complete).not.toHaveBeenCalled();
  });
  it.each([
    "critical",
    "renderer",
    "timeout",
  ])("does not confirm after %s failure", async (reason) => {
    confirmation.acknowledge(confirmation.context()?.nonce ?? "");
    confirmation.criticalReady(true);
    if (reason === "critical") {
      confirmation.criticalReady(false);
    } else if (reason === "renderer") {
      confirmation.fail();
    } else {
      confirmation.documentChanged();
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(complete).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledOnce();
  });
  it("pauses the deadline and observation while suspended", async () => {
    confirmation.acknowledge(confirmation.context()?.nonce ?? "");
    confirmation.criticalReady(true);
    await vi.advanceTimersByTimeAsync(2000);
    confirmation.suspend();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(failure).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    confirmation.resume();
    await vi.advanceTimersByTimeAsync(3000);
    expect(complete).toHaveBeenCalledOnce();
  });
});
