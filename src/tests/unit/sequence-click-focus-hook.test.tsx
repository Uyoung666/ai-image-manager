import { act, cleanup, render } from "@testing-library/react";
import { useLayoutEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSequenceClickFocus } from "@/hooks/useSequenceClickFocus";
import type { SequenceClickFocusGeometry } from "@/utils/sequence-click-focus";

const memberIds = Array.from({ length: 100 }, (_, index) => index + 1);
const onGeometry = vi.fn<(geometry: SequenceClickFocusGeometry) => void>();
const onSettled = vi.fn();
let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let surface: ReturnType<typeof installGeometry>;

function Harness({
  request = 1,
  outerSettled = 0,
  renderCard = true,
  containerWidth = 900,
  memberId = 80,
  alignment = "center",
}: {
  request?: number;
  outerSettled?: number;
  renderCard?: boolean;
  containerWidth?: number;
  memberId?: number;
  alignment?: "center" | "nearest";
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const installedRef = useRef(false);
  useLayoutEffect(() => {
    if (!rootRef.current) {
      return;
    }
    if (installedRef.current) {
      surface.attachCard();
    } else {
      surface = installGeometry(rootRef.current);
      installedRef.current = true;
    }
  });
  useSequenceClickFocus({
    scrollRef,
    memberId,
    memberIds,
    columns: 4,
    request,
    containerWidth,
    topInset: 48,
    onGeometry,
    onSettled,
    outerSettled,
    alignment,
  });
  return (
    <div data-masonry-scroll="" ref={rootRef} style={{ paddingBottom: 24 }}>
      <section data-sequence-tray-id="42">
        <div data-sequence-virtual-scroll="" ref={scrollRef}>
          {renderCard && (
            <div
              aria-selected={true}
              data-photo-id={memberId}
              role="option"
              tabIndex={0}
            />
          )}
        </div>
      </section>
    </div>
  );
}

function rect(top: number, height: number, width = 900): DOMRect {
  return {
    top,
    bottom: top + height,
    left: 0,
    right: width,
    width,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

function installGeometry(outer: HTMLElement) {
  const tray = outer.querySelector<HTMLElement>("[data-sequence-tray-id]");
  const inner = outer.querySelector<HTMLElement>(
    "[data-sequence-virtual-scroll]"
  );
  if (!(tray && inner)) {
    throw new Error("Missing sequence focus containers");
  }
  const layout = {
    trayOffset: 1000,
    trayWidth: 900,
    outerScrollHeight: 2600,
    cardTop: 900,
    cardHeight: 100,
  };
  outer.scrollTop = 500;
  Object.defineProperties(outer, {
    clientHeight: { configurable: true, get: () => 600 },
    scrollHeight: {
      configurable: true,
      get: () => layout.outerScrollHeight,
    },
  });
  Object.defineProperties(inner, {
    clientHeight: { configurable: true, get: () => 400 },
    scrollHeight: { configurable: true, get: () => 1600 },
  });
  outer.getBoundingClientRect = () => rect(0, 600);
  tray.getBoundingClientRect = () =>
    rect(layout.trayOffset - outer.scrollTop, 500, layout.trayWidth);
  inner.getBoundingClientRect = () =>
    rect(layout.trayOffset - outer.scrollTop + 80, 400);
  const attachCard = () => {
    const card = outer.querySelector<HTMLElement>("[data-photo-id]");
    if (card) {
      card.getBoundingClientRect = () =>
        rect(
          layout.trayOffset -
            outer.scrollTop +
            80 +
            layout.cardTop -
            inner.scrollTop,
          layout.cardHeight
        );
    }
    return card;
  };
  attachCard();
  return { outer, inner, layout, attachCard };
}

function nextFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  act(() => {
    for (const callback of callbacks) {
      callback(0);
    }
  });
}

function advanceFrames(count: number) {
  for (let index = 0; index < count; index++) {
    nextFrame();
  }
}

beforeEach(() => {
  frames = new Map();
  frameId = 0;
  vi.clearAllMocks();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frameId += 1;
    frames.set(frameId, callback);
    return frameId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sequence click focus", () => {
  it("keeps a visible keyboard target still and publishes its outer scroll unchanged", () => {
    const view = render(<Harness request={0} />);
    surface.outer.scrollTop = 968;
    surface.inner.scrollTop = 700;
    view.rerender(<Harness alignment="nearest" />);
    expect(onGeometry).toHaveBeenCalledExactlyOnceWith({
      request: 1,
      offsetTop: 280,
      height: 100,
      layoutWidth: 900,
      innerScrollTop: 700,
      outerScrollTop: 968,
    });
    view.rerender(<Harness alignment="nearest" outerSettled={1} />);
    advanceFrames(2);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(1);
    expect(surface.inner.scrollTop).toBe(700);
    expect(surface.outer.scrollTop).toBe(968);
  });
  it("publishes the joint plan during the first layout without moving either scroll", () => {
    render(<Harness />);
    expect(onGeometry).toHaveBeenCalledExactlyOnceWith({
      request: 1,
      offsetTop: 80,
      height: 100,
      layoutWidth: 900,
      innerScrollTop: 900,
    });
    expect(surface.inner.scrollTop).toBe(0);
    expect(surface.outer.scrollTop).toBe(500);
    advanceFrames(5);
    expect(surface.inner.scrollTop).toBe(0);
    expect(surface.outer.scrollTop).toBe(500);
    expect(onGeometry).toHaveBeenCalledOnce();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("requires the parent to apply both scrolls and acknowledge two stable frames", () => {
    const view = render(<Harness />);
    view.rerender(<Harness outerSettled={1} />);
    advanceFrames(3);
    expect(onSettled).not.toHaveBeenCalled();
    surface.inner.scrollTop = 900;
    nextFrame();
    expect(onSettled).not.toHaveBeenCalled();
    surface.outer.scrollTop = 818;
    nextFrame();
    expect(onSettled).not.toHaveBeenCalled();
    nextFrame();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(1);
    expect(onGeometry).toHaveBeenCalledOnce();
    expect(document.activeElement).not.toBe(surface.attachCard());
  });

  it("waits for a virtual member to mount without scrolling to its row", () => {
    const view = render(<Harness renderCard={false} />);
    advanceFrames(4);
    expect(onGeometry).not.toHaveBeenCalled();
    view.rerender(<Harness />);
    nextFrame();
    expect(onGeometry).toHaveBeenCalledOnce();
    expect(surface.inner.scrollTop).toBe(0);
  });

  it("waits for real width to catch up before reporting the new layout", () => {
    render(<Harness containerWidth={650} />);
    advanceFrames(4);
    expect(onGeometry).not.toHaveBeenCalled();
    surface.layout.trayWidth = 650;
    nextFrame();
    expect(onGeometry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ layoutWidth: 650 })
    );
    expect(surface.inner.scrollTop).toBe(0);
  });

  it("keeps the outer still when the inner alone can center the next member", () => {
    const view = render(<Harness request={0} />);
    surface.outer.scrollTop = 968;
    surface.inner.scrollTop = 700;
    view.rerender(<Harness />);
    expect(onGeometry).toHaveBeenCalledExactlyOnceWith({
      request: 1,
      offsetTop: 230,
      height: 100,
      layoutWidth: 900,
      innerScrollTop: 750,
    });
    expect(surface.inner.scrollTop).toBe(700);
    expect(surface.outer.scrollTop).toBe(968);
  });

  it("reports boundary compensation once without an intermediate inner center", () => {
    const view = render(<Harness request={0} />);
    surface.layout.trayOffset = 0;
    surface.outer.scrollTop = 0;
    view.rerender(<Harness />);
    expect(onGeometry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ innerScrollTop: 718, offsetTop: 262 })
    );
    expect(surface.inner.scrollTop).toBe(0);
    surface.inner.scrollTop = 718;
    view.rerender(<Harness outerSettled={1} />);
    advanceFrames(2);
    expect(onGeometry).toHaveBeenCalledOnce();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("reports the nearest fully visible position at the outer end", () => {
    const view = render(<Harness request={0} />);
    surface.layout.trayOffset = 1300;
    surface.layout.outerScrollHeight = 1600;
    surface.outer.scrollTop = 1000;
    view.rerender(<Harness />);
    expect(onGeometry).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ innerScrollTop: 900, offsetTop: 80 })
    );
    surface.inner.scrollTop = 900;
    view.rerender(<Harness outerSettled={1} />);
    advanceFrames(2);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("republishes resized geometry and waits for the updated joint plan", () => {
    const view = render(<Harness />);
    surface.inner.scrollTop = 900;
    surface.outer.scrollTop = 818;
    surface.layout.cardHeight = 160;
    view.rerender(<Harness outerSettled={1} />);
    nextFrame();
    expect(onGeometry).toHaveBeenLastCalledWith(
      expect.objectContaining({
        height: 160,
        innerScrollTop: 900,
        offsetTop: 80,
      })
    );
    advanceFrames(3);
    expect(onSettled).not.toHaveBeenCalled();
    surface.outer.scrollTop = 848;
    advanceFrames(2);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("cancels a request and publishes only the newest repeated or keyboard target", () => {
    const view = render(<Harness />);
    view.rerender(<Harness request={0} />);
    advanceFrames(5);
    expect(onSettled).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
    view.rerender(<Harness request={2} />);
    expect(onGeometry).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: 2 })
    );
    surface.layout.cardTop = 1000;
    view.rerender(<Harness memberId={81} request={3} />);
    expect(onGeometry).toHaveBeenLastCalledWith(
      expect.objectContaining({ request: 3, innerScrollTop: 1000 })
    );
    surface.inner.scrollTop = 1000;
    surface.outer.scrollTop = 818;
    view.rerender(<Harness memberId={81} outerSettled={3} request={3} />);
    advanceFrames(2);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(3);
  });
});
