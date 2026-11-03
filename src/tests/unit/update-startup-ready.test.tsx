import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  reportUpdateSurfaceFailure,
  UpdateStartupReady,
} from "@/components/update-startup-ready";

const mocks = vi.hoisted(() => ({ context: vi.fn(), report: vi.fn() }));
vi.mock("@/actions/update", () => ({
  getUpdateStartupContext: mocks.context,
  reportUpdateStartup: mocks.report,
}));
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.context.mockResolvedValue({ nonce: "document" });
  mocks.report.mockResolvedValue({ ok: true });
});
afterEach(() => {
  vi.useRealTimers();
});
it("does not acknowledge a loading surface, then reports the painted page", async () => {
  const view = render(<UpdateStartupReady ready={false} />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(mocks.report).not.toHaveBeenCalled();
  view.rerender(<UpdateStartupReady ready />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(mocks.report).toHaveBeenCalledWith("document", true);
  view.unmount();
});
it("acknowledges a confirmation that starts after the page is already ready", async () => {
  mocks.context.mockResolvedValueOnce(null);
  const view = render(<UpdateStartupReady ready />);
  await act(() => vi.advanceTimersByTimeAsync(100));
  expect(mocks.report).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { channel: "update:status", phase: "confirming" },
      })
    );
    await Promise.resolve();
  });
  expect(mocks.report).toHaveBeenCalledWith("document", true);
  view.unmount();
});
it("reports an actual error surface as failed", async () => {
  reportUpdateSurfaceFailure();
  await vi.advanceTimersByTimeAsync(1);
  expect(mocks.report).toHaveBeenCalledWith("document", false);
});
