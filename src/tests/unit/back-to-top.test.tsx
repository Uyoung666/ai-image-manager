import { act, fireEvent, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBackToTop } from "@/hooks/use-back-to-top";
import {
  createBackToTopController,
  shouldShowBackToTop,
} from "@/utils/back-to-top";

vi.mock("@/actions/ui-preferences", () => ({
  isReducedMotionEnabled: () =>
    document.documentElement.dataset.reducedMotion === "true",
}));

function fixture(top = 3000) {
  const element = document.createElement("div");
  element.tabIndex = -1;
  element.innerHTML =
    "<div data-back-to-top-content><button>Photo</button></div>";
  document.body.append(element);
  Object.defineProperty(element, "clientHeight", { value: 500 });
  element.scrollTop = top;
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    if (options.behavior !== "smooth") {
      element.scrollTop = Number(options.top);
    }
  });
  element.scrollTo = scrollTo as typeof element.scrollTo;
  const surface = element.firstElementChild as HTMLElement;
  const animations: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] =
    [];
  surface.animate = vi.fn(() => {
    let finish: () => void = () => undefined;
    let reject: () => void = () => undefined;
    const finished = new Promise<void>((resolve, rejectPromise) => {
      finish = resolve;
      reject = () => rejectPromise(new Error("cancelled"));
    });
    const animation = { finish, finished, cancel: vi.fn(reject) };
    animations.push(animation);
    return animation as unknown as Animation;
  });
  const controller = createBackToTopController(element);
  return { element, surface, scrollTo, animations, controller };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16)
  );
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
});

afterEach(() => {
  document.dispatchEvent(new Event("wheel"));
  document.body.innerHTML = "";
  delete document.documentElement.dataset.reducedMotion;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("back to top", () => {
  it("only appears beyond two viewport heights", () => {
    const { element } = fixture(1000);
    expect(shouldShowBackToTop(element)).toBe(false);
    element.scrollTop++;
    expect(shouldShowBackToTop(element)).toBe(true);
  });

  it("uses native smooth scroll up to four screens and stops it on input", () => {
    const { controller, element, scrollTo, surface } = fixture(2000);
    controller.start(false);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
    expect(surface.animate).not.toHaveBeenCalled();
    document.dispatchEvent(new Event("wheel"));
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: element.scrollTop,
      behavior: "instant",
    });
  });

  it.each([
    "app",
    "system",
  ])("respects %s reduced motion immediately", (preference) => {
    if (preference === "app") {
      document.documentElement.dataset.reducedMotion = "true";
    } else {
      vi.stubGlobal("matchMedia", () => ({ matches: true }));
    }
    const { controller, surface, element } = fixture();
    controller.start(true);
    expect(element.scrollTop).toBe(0);
    expect(surface.animate).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(element);
  });

  it("jumps once between fades and waits for layout without waiting for image decode", async () => {
    const { controller, surface, element, animations, scrollTo } = fixture();
    const onStart = vi.fn();
    controller.start(true, onStart);
    controller.start(true, onStart);
    expect(onStart).toHaveBeenCalledOnce();
    expect(element.scrollTop).toBe(3000);
    animations[0].finish();
    await vi.advanceTimersByTimeAsync(32);
    expect(scrollTo).toHaveBeenCalledOnce();
    expect(element.scrollTop).toBe(0);
    expect(surface.animate).toHaveBeenCalledTimes(2);
    animations[1].finish();
    await Promise.resolve();
    expect(document.activeElement).toBe(element);
  });

  it.each([
    "wheel",
    "touchstart",
    "pointerdown",
    "keydown",
  ])("%s cancels a pending jump and leaves input enabled", async (type) => {
    const { controller, element, animations, scrollTo } = fixture();
    controller.start(false);
    const event =
      type === "keydown"
        ? new KeyboardEvent(type, { key: "Home", cancelable: true })
        : new Event(type, { cancelable: true });
    document.dispatchEvent(event);
    animations[0].finish();
    await vi.advanceTimersByTimeAsync(500);
    expect(element.scrollTop).toBe(3000);
    expect(scrollTo).not.toHaveBeenCalled();
    expect(animations[0].cancel).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it("a cancelled animation's rejection cannot cancel a new transition", async () => {
    const { controller, animations, element } = fixture();
    controller.start(false);
    controller.cancel();
    controller.start(false);
    await Promise.resolve();
    expect(animations[1].cancel).not.toHaveBeenCalled();
    animations[1].finish();
    await vi.advanceTimersByTimeAsync(32);
    expect(element.scrollTop).toBe(0);
    controller.cancel();
  });

  it("cancels between positioning and reveal without stealing focus", async () => {
    const { controller, animations, element } = fixture();
    controller.start(true);
    (element.querySelector("button") as HTMLButtonElement).focus();
    animations[0].finish();
    await Promise.resolve();
    controller.cancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(animations).toHaveLength(1);
    expect(document.activeElement).not.toBe(element);
  });

  it("finishes safely when reveal creation fails", async () => {
    const { controller, animations, surface, element } = fixture();
    controller.start(false);
    vi.mocked(surface.animate).mockImplementation(() => {
      throw new Error("animation failed");
    });
    animations[0].finish();
    await vi.advanceTimersByTimeAsync(32);
    expect(element.scrollTop).toBe(0);
    expect(animations[0].cancel).toHaveBeenCalledOnce();
  });

  it("falls back to immediate positioning without animation support", () => {
    const { controller, surface, element } = fixture();
    surface.animate = undefined as unknown as typeof surface.animate;
    controller.start(false);
    expect(element.scrollTop).toBe(0);
  });

  it("cleans up on route change and unmount", async () => {
    const cancel = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = cancel;
      }
    );
    const scrollTo = vi.fn();
    function Harness({ route }: { route: string }) {
      const ref = useRef<HTMLDivElement>(null);
      const { onClick } = useBackToTop(ref, undefined, route);
      return (
        <>
          <div ref={ref} />
          <button onClick={onClick} type="button">
            Top
          </button>
        </>
      );
    }
    const view = render(<Harness route="home" />);
    const el = view.container.querySelector("div") as HTMLDivElement;
    Object.defineProperty(el, "clientHeight", { value: 500 });
    el.scrollTop = 1500;
    el.scrollTo = scrollTo;
    fireEvent.click(view.getByText("Top"));
    await act(() => view.rerender(<Harness route="album" />));
    expect(scrollTo).toHaveBeenLastCalledWith({
      top: 1500,
      behavior: "instant",
    });
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });
});
