import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WanderPresentationPreview } from "@/components/wander/WanderPresentationPreview";
import {
  wanderColumnOffset,
  wanderProgressForOffset,
} from "@/components/wander/wander-motion";

let visibility: (visible: boolean) => void;
const disconnect = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        visibility = (visible) =>
          callback(
            [
              {
                isIntersecting: visible,
                intersectionRatio: visible ? 1 : 0,
              } as IntersectionObserverEntry,
            ],
            this as unknown as IntersectionObserver
          );
      }
      observe() {
        /* visibility is emitted by each test */
      }
      disconnect = disconnect;
    }
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* no layout in jsdom */
      }
      disconnect = disconnect;
    }
  );
  disconnect.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function renderPreview(presentation: "parallax" | "slideshow" = "parallax") {
  return render(
    <WanderPresentationPreview
      flowSpeed="normal"
      intervalSeconds={3}
      presentation={presentation}
    />
  );
}
function stage() {
  return screen.getByRole("img", { name: "wander.preview.label" });
}
function progress() {
  return Number(stage().dataset.progress);
}

describe("alternating wander motion", () => {
  it("starts and ends each column at opposite edges with no overshoot", () => {
    expect(
      [0, 1, 2, 3].map((column) => wanderColumnOffset(100, 0, column))
    ).toEqual([-0, -100, -0, -100]);
    expect(
      [0, 1, 2, 3].map((column) => wanderColumnOffset(100, 1, column))
    ).toEqual([-100, -0, -100, -0]);
    expect(wanderColumnOffset(100, -1, 1)).toBe(-100);
    expect(wanderColumnOffset(-10, 1, 0)).toBe(-0);
  });
  it("inverts keyboard positioning for downward columns", () => {
    expect(wanderProgressForOffset(100, 25, 0)).toBe(0.25);
    expect(wanderProgressForOffset(100, 25, 1)).toBe(0.75);
    expect(
      wanderColumnOffset(100, wanderProgressForOffset(100, 25, 1), 1)
    ).toBe(-25);
  });
});

describe("wander presentation preview", () => {
  it("plays once while visible, pauses without consuming time, and replays from zero", async () => {
    renderPreview();
    await advance(1000);
    expect(progress()).toBe(0);
    act(() => visibility(true));
    await advance(2000);
    expect(progress()).toBeGreaterThan(0.15);
    fireEvent.click(
      screen.getByRole("button", { name: "wander.preview.pause" })
    );
    const paused = progress();
    await advance(5000);
    expect(progress()).toBe(paused);
    fireEvent.click(
      screen.getByRole("button", { name: "wander.preview.resume" })
    );
    await advance(9000);
    expect(stage()).toHaveAttribute("data-preview-phase", "finished");
    expect(progress()).toBe(1);
    await advance(2000);
    expect(progress()).toBe(1);
    fireEvent.click(
      screen.getByRole("button", { name: "wander.preview.replay" })
    );
    expect(progress()).toBe(0);
    await advance(1000);
    expect(progress()).toBeGreaterThan(0);
  });

  it("stops offscreen, on blur, behind wander and after unmount", async () => {
    const { rerender, unmount } = renderPreview();
    act(() => visibility(true));
    await advance(1500);
    act(() => visibility(false));
    const offscreen = progress();
    await advance(2000);
    expect(progress()).toBe(offscreen);
    act(() => visibility(true));
    fireEvent(window, new Event("blur"));
    await advance(2000);
    expect(progress()).toBe(offscreen);
    fireEvent(window, new Event("focus"));
    await advance(1000);
    expect(progress()).toBeGreaterThan(offscreen);
    rerender(
      <WanderPresentationPreview
        flowSpeed="normal"
        intervalSeconds={3}
        presentation="parallax"
        suspended
      />
    );
    const suspended = progress();
    await advance(1000);
    expect(progress()).toBe(suspended);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows three complete slides at the configured interval and resets on changing presentation", async () => {
    const { rerender } = renderPreview("slideshow");
    act(() => visibility(true));
    await advance(3100);
    expect(document.querySelector("[data-preview-slide='1']")).toHaveClass(
      "opacity-100"
    );
    await advance(3000);
    expect(document.querySelector("[data-preview-slide='2']")).toHaveClass(
      "opacity-100"
    );
    await advance(3100);
    expect(stage()).toHaveAttribute("data-preview-phase", "finished");
    rerender(
      <WanderPresentationPreview
        flowSpeed="slow"
        intervalSeconds={3}
        key="parallax"
        presentation="parallax"
      />
    );
    expect(progress()).toBe(0);
    expect(document.querySelectorAll("[data-preview-column]")).toHaveLength(4);
    expect(document.querySelectorAll("[data-preview-slide]")).toHaveLength(0);
  });

  it("uses static illustrations for reduced motion", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    renderPreview();
    act(() => visibility(true));
    await advance(20_000);
    expect(progress()).toBe(0);
    expect(
      screen.getByText("wander.preview.reducedMotion")
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "wander.preview.replay" })
    ).toBeNull();
  });
});
