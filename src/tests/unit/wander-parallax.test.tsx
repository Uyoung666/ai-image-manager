import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordWanderExposure } from "@/actions/wander";
import { WanderOverlay } from "@/components/wander/WanderOverlay";
import {
  WanderParallax,
  wanderColumnCount,
} from "@/components/wander/WanderParallax";
import type { WanderSession } from "@/types/wander";

vi.mock("@/actions/wander", () => ({
  recordWanderExposure: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock("@/utils/local-media-url", () => ({
  preloadImageAsync: vi.fn().mockResolvedValue(true),
  toLocalMediaUrl: (path: string) => `local://${path}`,
  toPreviewUrl: (path: string) => `preview://${path}`,
}));
vi.mock("@/components/ZoomableImage", () => ({
  ZoomableImage: ({ alt }: { alt: string }) => (
    <div data-testid="zoom-image">{alt}</div>
  ),
}));

const observers: TestIntersectionObserver[] = [];
class TestIntersectionObserver {
  callback: IntersectionObserverCallback;
  disconnected = false;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe() {
    /* test emits visibility explicitly */
  }
  disconnect() {
    this.disconnected = true;
  }
  emit(target: Element, ratio: number) {
    this.callback(
      [
        {
          target,
          intersectionRatio: ratio,
          isIntersecting: ratio > 0,
        } as IntersectionObserverEntry,
      ],
      this as unknown as IntersectionObserver
    );
  }
}
const session: WanderSession = {
  mode: "rediscovery",
  titleKey: "wander.title.rediscovery",
  photos: Array.from({ length: 12 }, (_, index) => ({
    id: index + 1,
    filename: `photo-${index + 1}.jpg`,
    path: `/${index + 1}.jpg`,
    thumbnailPath: `/${index + 1}.webp`,
    width: 1000,
    height: 700,
    fileDate: 1,
    isFavorite: false,
    isIndexed: true,
  })),
};
function loadImages() {
  for (const image of document.querySelectorAll("[data-wander-parallax] img")) {
    fireEvent.load(image);
  }
}
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
function renderOverlay(
  overrides: Partial<Parameters<typeof WanderOverlay>[0]> = {}
) {
  const props = {
    intervalMs: 3000,
    onClose: vi.fn(),
    onRoundComplete: vi.fn(),
    onSave: vi.fn(),
    roundNumber: 1,
    saving: false,
    session,
    ...overrides,
  };
  return { ...render(<WanderOverlay {...props} />), props };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  observers.length = 0;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        /* fixed test viewport */
      }
      disconnect() {
        /* fixed test viewport */
      }
    }
  );
  vi.stubGlobal("IntersectionObserver", TestIntersectionObserver);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("wander parallax", () => {
  it.each([
    [480, 12, 1],
    [720, 12, 2],
    [900, 12, 3],
    [1280, 12, 4],
    [1280, 6, 2],
  ])("uses responsive columns at %ipx with %i photos", (width, photos, expected) => {
    expect(wanderColumnCount(width, photos)).toBe(expected);
  });

  it("waits for images, allows manual takeover, preserves progress through inspection and exits in two steps", async () => {
    const { props } = renderOverlay();
    await advance(2400);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "0"
    );
    loadImages();
    await advance(2000);
    expect(
      Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"))
    ).toBeGreaterThan(0);
    const stage = document.querySelector(
      "[data-wander-parallax]"
    ) as HTMLElement;
    fireEvent.wheel(stage, { deltaY: 300 });
    const progress = screen
      .getByRole("progressbar")
      .getAttribute("aria-valuenow");
    await advance(4000);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      progress
    );
    const inspectedCard = stage.querySelectorAll("button")[2];
    fireEvent.click(inspectedCard);
    expect(screen.getByTestId("zoom-image")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId("zoom-image")).not.toBeInTheDocument();
    expect(inspectedCard).toHaveFocus();
    expect(props.onClose).not.toHaveBeenCalled();
    await advance(4000);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      progress
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("holds at the manual endpoint and advances only once after resuming", async () => {
    const { props } = renderOverlay();
    loadImages();
    await advance(1200);
    fireEvent.wheel(
      document.querySelector("[data-wander-parallax]") as HTMLElement,
      { deltaY: 100_000 }
    );
    await advance(3000);
    expect(props.onRoundComplete).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "wander.play" }));
    await advance(500);
    expect(props.onRoundComplete).toHaveBeenCalledOnce();
    await advance(1000);
    expect(props.onRoundComplete).toHaveBeenCalledOnce();
  });

  it("falls back for small collections and reduced motion without changing the preference", () => {
    const { unmount } = renderOverlay({
      session: { ...session, photos: session.photos.slice(0, 5) },
    });
    expect(document.querySelector("[data-wander-parallax]")).toBeNull();
    unmount();
    vi.stubGlobal("matchMedia", () => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }));
    renderOverlay();
    expect(document.querySelector("[data-wander-parallax]")).toBeNull();
  });

  it("drops broken cards and falls back when fewer than six remain", async () => {
    renderOverlay({
      session: { ...session, photos: session.photos.slice(0, 6) },
    });
    loadImages();
    await advance(1200);
    fireEvent.error(
      document.querySelector("[data-wander-parallax] img") as HTMLElement
    );
    expect(document.querySelector("[data-wander-parallax]")).toBeNull();
  });

  it("pauses on keyboard navigation and does not swallow unrelated shortcuts", async () => {
    renderOverlay();
    loadImages();
    await advance(1200);
    fireEvent.keyDown(window, { key: "Tab" });
    expect(
      screen.getByRole("button", { name: "wander.play" })
    ).toBeInTheDocument();
    const event = new KeyboardEvent("keydown", { key: "a", cancelable: true });
    fireEvent(window, event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("brings a downward-column card into view when navigating with the keyboard", async () => {
    const { container } = renderOverlay();
    const column = document.querySelector(
      "[data-wander-direction='down']"
    ) as HTMLElement;
    const card = column.querySelector("button") as HTMLElement;
    Object.defineProperty(column, "scrollHeight", {
      configurable: true,
      value: 2000,
    });
    Object.defineProperty(card, "offsetTop", {
      configurable: true,
      value: 800,
    });
    Object.defineProperty(card, "offsetHeight", {
      configurable: true,
      value: 300,
    });
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      top: -500,
      bottom: -200,
    } as DOMRect);
    loadImages();
    await advance(1200);
    fireEvent.keyDown(document, { key: "Tab" });
    act(() => card.focus({ preventScroll: true }));
    expect(
      Number(screen.getByRole("progressbar").getAttribute("aria-valuenow"))
    ).toBe(
      Math.round(
        (1 -
          (800 - (window.innerHeight - 300) / 2) /
            (2000 - window.innerHeight)) *
          100
      )
    );
    expect(container).toBeInTheDocument();
  });

  it("requests another round once when every gallery image fails together", async () => {
    const { props } = renderOverlay();
    const images = document.querySelectorAll("[data-wander-parallax] img");
    act(() => {
      for (const image of images) {
        fireEvent.error(image);
      }
    });
    expect(props.onRoundComplete).toHaveBeenCalledOnce();
    await advance(3000);
    expect(props.onRoundComplete).toHaveBeenCalledOnce();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("records only loaded, half-visible photos after continuous exposure and cancels exposure behind inspection", async () => {
    const props = {
      durationMs: 60_000,
      exposureEnabled: true,
      exposedIds: new Set<number>(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      onInspect: vi.fn(),
      onPause: vi.fn(),
      onProgress: vi.fn(),
      paused: true,
      photos: session.photos,
    };
    const { rerender, unmount } = render(<WanderParallax {...props} />);
    loadImages();
    const card = document.querySelector("[data-photo-id='1']") as HTMLElement;
    const observer = observers.at(-1) as TestIntersectionObserver;
    act(() => observer.emit(card, 0.49));
    await advance(2100);
    expect(recordWanderExposure).not.toHaveBeenCalled();
    act(() => observer.emit(card, 0.7));
    await advance(1999);
    expect(recordWanderExposure).not.toHaveBeenCalled();
    await advance(1);
    expect(recordWanderExposure).toHaveBeenCalledExactlyOnceWith({
      photoId: 1,
      source: "wander",
    });
    act(() => {
      observer.emit(card, 0);
      observer.emit(card, 1);
    });
    await advance(2100);
    expect(recordWanderExposure).toHaveBeenCalledOnce();
    const second = document.querySelector("[data-photo-id='2']") as HTMLElement;
    act(() => observer.emit(second, 1));
    await advance(1000);
    rerender(<WanderParallax {...props} exposureEnabled={false} />);
    await advance(2000);
    expect(recordWanderExposure).toHaveBeenCalledOnce();
    unmount();
    expect(observers.every((item) => item.disconnected)).toBe(true);
  });

  it("cancels animation frames when paused or unmounted", async () => {
    const onProgress = vi.fn();
    const props = {
      durationMs: 60_000,
      exposureEnabled: false,
      exposedIds: new Set<number>(),
      onComplete: vi.fn(),
      onError: vi.fn(),
      onInspect: vi.fn(),
      onPause: vi.fn(),
      onProgress,
      paused: false,
      photos: session.photos,
    };
    const { rerender, unmount } = render(<WanderParallax {...props} />);
    loadImages();
    await advance(1500);
    rerender(<WanderParallax {...props} paused />);
    onProgress.mockClear();
    await advance(3000);
    expect(onProgress).not.toHaveBeenCalled();
    unmount();
    await advance(3000);
    expect(onProgress).not.toHaveBeenCalled();
  });
});
