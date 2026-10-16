import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { createRef, useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MasonryGrid } from "@/components/MasonryGrid";
import type { MasonryGridHandle } from "@/hooks/useMasonryAnchor";

const restoration = vi.hoisted(() => ({ positioned: true }));
vi.mock("@/hooks/useRouteScrollRestoration", async () => {
  const { useRef } = await import("react");
  return {
    useRouteScrollRestoration: () => ({
      initialScrollTop: 0,
      hasInitialPositionedRef: useRef(restoration.positioned),
      forceUnlock: vi.fn(),
    }),
  };
});
vi.mock("@/components/MasonryBackToTop", () => ({
  MasonryBackToTop: () => null,
}));

const photos = Array.from({ length: 2000 }, (_, index) => ({
  id: index + 1,
  width: 1000,
  height: [660, 1500, 1000, 800, 1250][index % 5],
}));
const mounts = new Map<number, number>();
const imageMounts = new Map<number, number>();

function LoadedImage({ id }: { id: number }) {
  const [loaded, setLoaded] = useState(false);
  useLayoutEffect(() => {
    imageMounts.set(id, (imageMounts.get(id) ?? 0) + 1);
  }, [id]);
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: simulate thumbnail load state
    <img
      alt={String(id)}
      data-load-state={loaded ? "loaded" : "loading"}
      height={100}
      onLoad={() => setLoaded(true)}
      src={`fixture-${id}.png`}
      width={100}
    />
  );
}

function Card({ id, renderImage }: { id: number; renderImage: boolean }) {
  useLayoutEffect(() => {
    mounts.set(id, (mounts.get(id) ?? 0) + 1);
  }, [id]);
  return (
    <div aria-selected="false" data-photo-id={id} role="option" tabIndex={0}>
      {renderImage && <LoadedImage id={id} />}
    </div>
  );
}

function renderItem(
  item: { id: number },
  _index: number,
  _style: React.CSSProperties,
  { renderImage }: { renderImage: boolean }
) {
  return <Card id={item.id} renderImage={renderImage} />;
}

const props = {
  columnCount: 5,
  containerWidth: 1024,
  gap: 8,
  items: photos,
  renderItem,
  routeKey: "reflow-regression",
};

function scrollTo(scroll: HTMLElement, top: number) {
  act(() => {
    scroll.scrollTop = top;
    fireEvent.scroll(scroll);
    vi.advanceTimersByTime(16);
  });
}

function loadImages(scroll: HTMLElement) {
  for (const image of scroll.querySelectorAll("img")) {
    fireEvent.load(image);
  }
}

function position(card: HTMLElement) {
  if (!card.parentElement) {
    throw new Error("Expected a positioned card wrapper");
  }
  const style = card.parentElement.style;
  return {
    top: Number.parseFloat(style.top),
    height: Number.parseFloat(style.height),
  };
}

function requireElement(root: ParentNode, selector: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(selector);
  if (!element) {
    throw new Error(`Missing fixture element: ${selector}`);
  }
  return element;
}

function expectPhotoCentered(
  scroll: HTMLElement,
  photoId: number,
  topInset = 0
) {
  const card = requireElement(scroll, `[data-photo-id="${photoId}"]`);
  const bounds = position(card);
  const style = getComputedStyle(scroll);
  const paddingTop = Number.parseFloat(style.paddingTop) || 0;
  const paddingBottom = Number.parseFloat(style.paddingBottom) || 0;
  const viewportCenter =
    topInset + (scroll.clientHeight - topInset - paddingBottom) / 2;
  expect(
    Math.abs(
      bounds.top +
        paddingTop +
        bounds.height / 2 -
        scroll.scrollTop -
        viewportCenter
    )
  ).toBeLessThanOrEqual(2);
}

function settleFocus() {
  act(() => vi.advanceTimersByTime(64));
}

function visibleCards(scroll: HTMLElement) {
  return Array.from(
    scroll.querySelectorAll<HTMLElement>("[data-photo-id]")
  ).filter((card) => {
    const bounds = position(card);
    return (
      bounds.top + bounds.height > scroll.scrollTop &&
      bounds.top < scroll.scrollTop + 700
    );
  });
}

function capture(scroll: HTMLElement) {
  loadImages(scroll);
  const cards = visibleCards(scroll);
  return cards.map((card) => {
    const id = Number(card.dataset.photoId);
    return {
      card,
      id,
      image: card.querySelector("img"),
      mounts: mounts.get(id),
      imageMounts: imageMounts.get(id),
      offset: position(card).top - scroll.scrollTop,
    };
  });
}

function expectRetained(
  scroll: HTMLElement,
  before: ReturnType<typeof capture>
) {
  const retained = before.filter(({ id }) =>
    scroll.querySelector(`[data-photo-id="${id}"] img`)
  );
  expect(retained.length).toBeGreaterThan(0);
  for (const entry of retained) {
    const card = scroll.querySelector(`[data-photo-id="${entry.id}"]`);
    expect(card).toBe(entry.card);
    expect(card?.querySelector("img")).toBe(entry.image);
    expect(card?.querySelector("img")).toHaveAttribute(
      "data-load-state",
      "loaded"
    );
    expect(mounts.get(entry.id)).toBe(entry.mounts);
    expect(imageMounts.get(entry.id)).toBe(entry.imageMounts);
  }
}

beforeEach(() => {
  restoration.positioned = true;
  mounts.clear();
  imageMounts.clear();
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {
        return undefined;
      }
      disconnect() {
        return undefined;
      }
    }
  );
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 16)
  );
  vi.stubGlobal("cancelAnimationFrame", (handle: number) =>
    clearTimeout(handle)
  );
  const offsets = new WeakMap<HTMLElement, number>();
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(700);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    function (this: HTMLElement) {
      const content = this.firstElementChild as HTMLElement | null;
      return Math.max(
        700,
        Number.parseFloat(content?.style.height ?? "0") +
          (Number.parseFloat(this.style.paddingTop) || 0) +
          (Number.parseFloat(this.style.paddingBottom) || 0)
      );
    }
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
    function (this: HTMLElement) {
      return Math.min(
        offsets.get(this) ?? 0,
        Math.max(0, this.scrollHeight - this.clientHeight)
      );
    }
  );
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
    function (this: HTMLElement, value: number) {
      offsets.set(
        this,
        Math.max(0, Math.min(value, this.scrollHeight - this.clientHeight))
      );
    }
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("masonry reflow continuity", () => {
  it("mounts an offscreen member tray without scrolling until the joint plan is ready", () => {
    const items = [...photos];
    items.splice(1000, 0, {
      id: -42,
      width: 1024,
      height: 680,
      fullWidth: true,
    } as (typeof items)[number]);
    const renderTray: typeof renderItem = (item, index, style, options) =>
      item.id === -42 ? (
        <div data-photo-id={-42} data-sequence-tray-id={42}>
          {options.renderImage && (
            <div data-sequence-virtual-scroll="">
              <div style={{ height: 2000 }} />
            </div>
          )}
        </div>
      ) : (
        renderItem(item, index, style, options)
      );
    const request = { id: 1, photoId: -42, targetRect: null };
    const view = render(
      <MasonryGrid {...props} items={items} renderItem={renderTray} />
    );
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    view.rerender(
      <MasonryGrid
        {...props}
        items={items}
        photoFocusRequest={request}
        renderItem={renderTray}
      />
    );
    settleFocus();
    expect(scroll.scrollTop).toBe(0);
    const tray = requireElement(scroll, '[data-photo-id="-42"]');
    const inner = requireElement(tray, "[data-sequence-virtual-scroll]");
    const layoutWidth = Number.parseFloat(
      tray.parentElement?.style.width ?? "0"
    );
    view.rerender(
      <MasonryGrid
        {...props}
        items={items}
        photoFocusRequest={{
          ...request,
          targetRect: {
            top: 200,
            height: 180,
            layoutWidth,
            innerScrollTop: 320,
            outerScrollTop: 50,
          },
        }}
        renderItem={renderTray}
      />
    );
    // Both scrolls must be committed by the same layout pass, before any RAF.
    expect(inner.scrollTop).toBe(320);
    expect(scroll.scrollTop).toBe(50);
    expect(requireElement(scroll, '[data-photo-id="-42"]')).toBe(tray);
  });
  it("centers a measured sequence member and replans when its local position changes", () => {
    const items = [...photos];
    items.splice(100, 0, {
      id: -42,
      width: 1024,
      height: 680,
      fullWidth: true,
    } as (typeof items)[number]);
    const settled = vi.fn();
    const view = render(
      <MasonryGrid
        {...props}
        items={items}
        onPhotoFocusSettled={settled}
        topInset={80}
      />
    );
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scroll.style.paddingBottom = "24px";
    const request = { id: 1, photoId: -42, targetRect: null };
    view.rerender(
      <MasonryGrid
        {...props}
        items={items}
        onPhotoFocusSettled={settled}
        photoFocusRequest={request}
        topInset={80}
      />
    );
    settleFocus();
    expect(settled).not.toHaveBeenCalled();
    const tray = requireElement(scroll, '[data-photo-id="-42"]');
    const layoutWidth = Number.parseFloat(
      tray.parentElement?.style.width ?? "0"
    );
    for (const top of [160, 260]) {
      view.rerender(
        <MasonryGrid
          {...props}
          items={items}
          onPhotoFocusSettled={settled}
          photoFocusRequest={{
            ...request,
            targetRect: { top, height: 180, layoutWidth },
          }}
          topInset={80}
        />
      );
      settleFocus();
      const paddingTop =
        Number.parseFloat(getComputedStyle(scroll).paddingTop) || 0;
      const center = 80 + (700 - 80 - 24) / 2;
      expect(
        Math.abs(
          position(tray).top + paddingTop + top + 90 - scroll.scrollTop - center
        )
      ).toBeLessThanOrEqual(2);
      expect(requireElement(scroll, '[data-photo-id="-42"]')).toBe(tray);
    }
    expect(settled.mock.calls).toEqual([[1], [1]]);
    fireEvent.wheel(scroll);
    const userTop = scroll.scrollTop + 100;
    scrollTo(scroll, userTop);
    view.rerender(
      <MasonryGrid
        {...props}
        items={items}
        onPhotoFocusSettled={settled}
        photoFocusRequest={{
          ...request,
          targetRect: { top: 360, height: 180, layoutWidth },
        }}
        topInset={80}
      />
    );
    settleFocus();
    expect(scroll.scrollTop).toBe(userTop);
    expect(settled).toHaveBeenCalledTimes(2);
  });
  for (const visibility of [
    "fully visible",
    "clipped above",
    "clipped below",
  ]) {
    it(`centers a clicked photo that is ${visibility} below the toolbar`, () => {
      const view = render(<MasonryGrid {...props} topInset={80} />);
      const scroll = requireElement(view.container, "[data-masonry-scroll]");
      scroll.style.paddingBottom = "24px";
      scrollTo(scroll, 10_000);
      const card = visibleCards(scroll)[3];
      const photoId = Number(card.dataset.photoId);
      const bounds = position(card);
      const contentTop = bounds.top + 88;
      let initialScrollTop = contentTop - 96;
      if (visibility === "clipped above") {
        initialScrollTop = contentTop + bounds.height / 2 - 80;
      } else if (visibility === "clipped below") {
        initialScrollTop = contentTop + bounds.height / 2 - 700;
      }
      scrollTo(scroll, initialScrollTop);
      loadImages(scroll);
      const image = card.querySelector("img");
      const mountCount = mounts.get(photoId);
      const imageMountCount = imageMounts.get(photoId);

      view.rerender(
        <MasonryGrid
          {...props}
          photoFocusRequest={{ id: 1, photoId }}
          topInset={80}
        />
      );
      settleFocus();

      expectPhotoCentered(scroll, photoId, 80);
      expect(scroll.scrollTop).not.toBeCloseTo(initialScrollTop, 1);
      const focusedCard = requireElement(
        scroll,
        `[data-photo-id="${photoId}"]`
      );
      expect(focusedCard).toBe(card);
      expect(focusedCard.querySelector("img")).toBe(image);
      expect(image).toHaveAttribute("data-load-state", "loaded");
      expect(mounts.get(photoId)).toBe(mountCount);
      expect(imageMounts.get(photoId)).toBe(imageMountCount);
    });
  }

  it("keeps the clicked photo centered when the panel narrows in the next frame", () => {
    const view = render(<MasonryGrid {...props} topInset={80} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    const photoId = Number(visibleCards(scroll).at(-1)?.dataset.photoId);
    const request = { id: 1, photoId };
    view.rerender(
      <MasonryGrid {...props} photoFocusRequest={request} topInset={80} />
    );
    act(() => vi.advanceTimersByTime(16));
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        photoFocusRequest={request}
        topInset={80}
      />
    );
    settleFocus();
    expectPhotoCentered(scroll, photoId, 80);
  });

  it("waits for the layout width when DOM shrinks before its measurement arrives", () => {
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    Object.defineProperty(scroll, "clientWidth", {
      configurable: true,
      value: 664,
    });
    const request = { id: 1, photoId: 1000 };
    view.rerender(<MasonryGrid {...props} photoFocusRequest={request} />);
    settleFocus();
    expect(scroll.scrollTop).toBe(10_000);

    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        photoFocusRequest={request}
      />
    );
    settleFocus();
    expectPhotoCentered(scroll, 1000);
  });

  it("keeps a new click pending through an earlier layout scroll notification", () => {
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    Object.defineProperty(scroll, "clientWidth", {
      configurable: true,
      value: 664,
    });
    const request = { id: 1, photoId: 1000 };
    view.rerender(<MasonryGrid {...props} photoFocusRequest={request} />);
    // A previous layout can change/clamp the offset before its native scroll
    // notification arrives. No wheel, pointer or scrolling key occurred.
    scrollTo(scroll, 10_100);
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        photoFocusRequest={request}
      />
    );
    settleFocus();
    expectPhotoCentered(scroll, 1000);
  });

  it("keeps a new click pending when an earlier return is cancelled before resize measurement", () => {
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    view.rerender(
      <MasonryGrid {...props} returnToPhotoId={700} returnToPhotoRequest={1} />
    );
    settleFocus();
    const oldScrollTop = scroll.scrollTop;
    Object.defineProperty(scroll, "clientWidth", {
      configurable: true,
      value: 664,
    });
    const request = { id: 1, photoId: 1000 };
    view.rerender(
      <MasonryGrid
        {...props}
        photoFocusRequest={request}
        returnToPhotoId={null}
        returnToPhotoRequest={0}
      />
    );
    settleFocus();
    expect(scroll.scrollTop).toBe(oldScrollTop);
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        photoFocusRequest={request}
        returnToPhotoId={null}
        returnToPhotoRequest={0}
      />
    );
    settleFocus();
    expectPhotoCentered(scroll, 1000);
  });

  it("recenters the same photo only when its click request changes", () => {
    const request = { id: 1, photoId: 1000 };
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    view.rerender(<MasonryGrid {...props} photoFocusRequest={request} />);
    settleFocus();
    expectPhotoCentered(scroll, 1000);

    scrollTo(scroll, scroll.scrollTop + 200);
    const userScrollTop = scroll.scrollTop;
    view.rerender(
      <MasonryGrid {...props} photoFocusRequest={{ ...request }} />
    );
    settleFocus();
    expect(scroll.scrollTop).toBe(userScrollTop);

    view.rerender(
      <MasonryGrid {...props} photoFocusRequest={{ ...request, id: 2 }} />
    );
    settleFocus();
    expectPhotoCentered(scroll, 1000);
  });

  it("only completes the latest photo click during rapid selection", () => {
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    view.rerender(
      <MasonryGrid {...props} photoFocusRequest={{ id: 1, photoId: 1000 }} />
    );
    act(() => vi.advanceTimersByTime(16));
    view.rerender(
      <MasonryGrid {...props} photoFocusRequest={{ id: 2, photoId: 1500 }} />
    );
    settleFocus();
    expectPhotoCentered(scroll, 1500);
    const finalScrollTop = scroll.scrollTop;
    settleFocus();
    expect(scroll.scrollTop).toBe(finalScrollTop);
  });

  it("cancels pending click positioning when the user scrolls the wheel", () => {
    const request = { id: 1, photoId: 1000 };
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    Object.defineProperty(scroll, "clientWidth", {
      configurable: true,
      value: 664,
    });
    view.rerender(<MasonryGrid {...props} photoFocusRequest={request} />);
    fireEvent.wheel(scroll, { deltaY: 200 });
    scrollTo(scroll, 15_000);
    const anchor = capture(scroll)[0];
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        photoFocusRequest={request}
      />
    );
    settleFocus();
    const card = requireElement(scroll, `[data-photo-id="${anchor.id}"]`);
    expect(position(card).top - scroll.scrollTop).toBeCloseTo(anchor.offset, 4);
  });

  it("restores ordinary resize anchoring after click positioning completes", () => {
    const request = { id: 1, photoId: 1000 };
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    view.rerender(<MasonryGrid {...props} photoFocusRequest={request} />);
    settleFocus();
    expectPhotoCentered(scroll, 1000);
    const anchor = capture(scroll)[0];
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        photoFocusRequest={request}
      />
    );
    settleFocus();
    const card = requireElement(scroll, `[data-photo-id="${anchor.id}"]`);
    expect(position(card).top - scroll.scrollTop).toBeCloseTo(anchor.offset, 4);
  });

  it("releases an enforced restored anchor before centering a clicked photo", () => {
    const ref = createRef<MasonryGridHandle>();
    const view = render(<MasonryGrid {...props} ref={ref} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    act(() => ref.current?.scrollToItem(1000, 0.5));
    view.rerender(
      <MasonryGrid
        {...props}
        photoFocusRequest={{ id: 1, photoId: 1500 }}
        ref={ref}
      />
    );
    settleFocus();
    expectPhotoCentered(scroll, 1500);
    act(() => vi.advanceTimersByTime(800));
    expectPhotoCentered(scroll, 1500);
  });

  it("does not revive a withdrawn pending click request when its photo reappears", () => {
    const request = { id: 1, photoId: 1000 };
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    Object.defineProperty(scroll, "clientWidth", {
      configurable: true,
      value: 664,
    });
    view.rerender(<MasonryGrid {...props} photoFocusRequest={request} />);
    view.rerender(<MasonryGrid {...props} photoFocusRequest={null} />);
    Object.defineProperty(scroll, "clientWidth", {
      configurable: true,
      value: 1024,
    });
    view.rerender(<MasonryGrid {...props} photoFocusRequest={request} />);
    settleFocus();
    expect(scroll.scrollTop).toBe(10_000);
    view.rerender(
      <MasonryGrid {...props} photoFocusRequest={{ ...request, id: 2 }} />
    );
    settleFocus();
    expectPhotoCentered(scroll, 1000);
  });

  for (const photoId of [1, 30]) {
    it(`clamps click positioning for boundary photo ${photoId}`, () => {
      const boundaryProps = {
        ...props,
        columnCount: 1,
        containerWidth: 400,
        items: photos.slice(0, 30).map((photo) => ({ ...photo, height: 1000 })),
      };
      const view = render(<MasonryGrid {...boundaryProps} />);
      const scroll = requireElement(view.container, "[data-masonry-scroll]");
      view.rerender(
        <MasonryGrid
          {...boundaryProps}
          photoFocusRequest={{ id: 1, photoId }}
        />
      );
      settleFocus();
      expect(scroll.scrollTop).toBe(
        photoId === 1 ? 0 : scroll.scrollHeight - scroll.clientHeight
      );
      expect(
        visibleCards(scroll).some(
          (card) => Number(card.dataset.photoId) === photoId
        )
      ).toBe(true);
    });
  }

  it("centers the middle of a card taller than the usable viewport", () => {
    const tallProps = {
      ...props,
      columnCount: 1,
      containerWidth: 400,
      items: photos.slice(0, 30).map((photo) => ({
        ...photo,
        height: photo.id === 15 ? 5000 : 1000,
      })),
      topInset: 80,
    };
    const view = render(<MasonryGrid {...tallProps} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    view.rerender(
      <MasonryGrid {...tallProps} photoFocusRequest={{ id: 1, photoId: 15 }} />
    );
    settleFocus();
    const card = requireElement(scroll, '[data-photo-id="15"]');
    expect(position(card).height).toBeGreaterThan(
      scroll.clientHeight - tallProps.topInset
    );
    expectPhotoCentered(scroll, 15, 80);
  });

  it("restores a mode's virtual window before the first paint", () => {
    const view = render(<MasonryGrid {...props} items={photos.slice(0, 3)} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    const onScrollRestored = vi.fn();

    view.rerender(
      <MasonryGrid
        {...props}
        onScrollRestored={onScrollRestored}
        scrollRestoreRequest={{ id: 1, scrollTop: 30_000 }}
      />
    );

    expect(scroll.scrollTop).toBe(30_000);
    expect(visibleCards(scroll).length).toBeGreaterThan(0);
    expect(
      visibleCards(scroll).every((card) => card.querySelector("img"))
    ).toBe(true);
    expect(onScrollRestored).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("consumes a mode restore once without locking subsequent user scrolling", () => {
    const onScrollRestored = vi.fn();
    const request = { id: 1, scrollTop: 10_000 };
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    view.rerender(
      <MasonryGrid
        {...props}
        onScrollRestored={onScrollRestored}
        scrollRestoreRequest={request}
      />
    );
    scrollTo(scroll, 15_000);
    view.rerender(
      <MasonryGrid
        {...props}
        onScrollRestored={onScrollRestored}
        scrollRestoreRequest={{ ...request }}
      />
    );
    expect(scroll.scrollTop).toBe(15_000);
    expect(onScrollRestored).toHaveBeenCalledTimes(1);

    view.rerender(
      <MasonryGrid
        {...props}
        onScrollRestored={onScrollRestored}
        scrollRestoreRequest={{ ...request, id: 2 }}
      />
    );
    expect(scroll.scrollTop).toBe(10_000);
    expect(onScrollRestored).toHaveBeenLastCalledWith(2);
  });

  it("waits for confirmed items before consuming a mode restore", () => {
    const onScrollRestored = vi.fn();
    const request = { id: 1, scrollTop: 10_000 };
    const view = render(
      <MasonryGrid
        {...props}
        isPlaceholderData
        onScrollRestored={onScrollRestored}
        scrollRestoreRequest={request}
      />
    );
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    expect(scroll.scrollTop).toBe(0);
    expect(onScrollRestored).not.toHaveBeenCalled();
    view.rerender(
      <MasonryGrid
        {...props}
        onScrollRestored={onScrollRestored}
        scrollRestoreRequest={request}
      />
    );
    expect(scroll.scrollTop).toBe(10_000);
    expect(visibleCards(scroll).length).toBeGreaterThan(0);
    expect(onScrollRestored).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("clamps a mode restore against the new layout's height", () => {
    const view = render(<MasonryGrid {...props} items={photos.slice(0, 3)} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    const onScrollRestored = vi.fn();
    view.rerender(
      <MasonryGrid
        {...props}
        onScrollRestored={onScrollRestored}
        scrollRestoreRequest={{ id: 1, scrollTop: Number.MAX_SAFE_INTEGER }}
      />
    );
    expect(scroll.scrollTop).toBe(scroll.scrollHeight - scroll.clientHeight);
    expect(visibleCards(scroll).length).toBeGreaterThan(0);
    expect(onScrollRestored).toHaveBeenCalledExactlyOnceWith(1);
  });

  for (const depth of [0, 10_000, 30_000, Number.MAX_SAFE_INTEGER]) {
    it(`retains images while opening and closing the panel at ${depth}px`, () => {
      const view = render(<MasonryGrid {...props} />);
      const scroll = requireElement(view.container, "[data-masonry-scroll]");
      scrollTo(scroll, depth);
      for (const geometry of [
        { containerWidth: 664, columnCount: 3 },
        { containerWidth: 1024, columnCount: 5 },
        { containerWidth: 664, columnCount: 3 },
        { containerWidth: 1024, columnCount: 5 },
      ]) {
        const before = capture(scroll);
        view.rerender(<MasonryGrid {...props} {...geometry} />);
        expectRetained(scroll, before);
        const anchor = before[0];
        const card = scroll.querySelector<HTMLElement>(
          `[data-photo-id="${anchor.id}"]`
        );
        if (
          card &&
          scroll.scrollTop > 0 &&
          scroll.scrollTop < scroll.scrollHeight - 700
        ) {
          expect(
            Math.abs(position(card).top - scroll.scrollTop - anchor.offset)
          ).toBeLessThanOrEqual(2);
        }
        if (depth === 0) {
          expect(scroll.scrollTop).toBe(0);
        }
      }
      expect(scroll.style.overflowAnchor).toBe("none");
    });
  }

  it("keeps images through repeated width changes without changing columns", () => {
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 30_000);
    for (const containerWidth of [1000, 960, 920, 880, 920, 960, 1024]) {
      const before = capture(scroll);
      view.rerender(<MasonryGrid {...props} containerWidth={containerWidth} />);
      expectRetained(scroll, before);
      const anchor = before[0];
      const card = requireElement(scroll, `[data-photo-id="${anchor.id}"]`);
      expect(position(card).top - scroll.scrollTop).toBeCloseTo(
        anchor.offset,
        4
      );
    }
  });

  it("anchors by ID when items shift during a resize and tail pagination", () => {
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    const before = capture(scroll);
    const items = [
      { id: 9000, width: 1000, height: 1000 },
      ...photos,
      { id: 9001, width: 800, height: 1000 },
    ];
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        items={items}
      />
    );
    expectRetained(scroll, before);
    const anchor = before[0];
    const card = requireElement(scroll, `[data-photo-id="${anchor.id}"]`);
    expect(position(card).top - scroll.scrollTop).toBeCloseTo(anchor.offset, 4);
  });

  it("keeps the same anchor through a continuous resize across column counts", () => {
    const view = render(
      <MasonryGrid {...props} columnCount={4} containerWidth={910} />
    );
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 35_119);
    const anchor = capture(scroll)[0];
    for (const containerWidth of [896, 882, 869, 855, 841, 828]) {
      view.rerender(
        <MasonryGrid
          {...props}
          columnCount={containerWidth >= 860 ? 4 : 3}
          containerWidth={containerWidth}
        />
      );
      const card = requireElement(scroll, `[data-photo-id="${anchor.id}"]`);
      expect(position(card).top - scroll.scrollTop).toBeCloseTo(
        anchor.offset,
        4
      );
      act(() => {
        // Native scroll notifications can repeat the same programmatic offset
        // while the detail panel is being resized. They are not user scrolling.
        fireEvent.scroll(scroll);
        fireEvent.scroll(scroll);
        vi.advanceTimersByTime(40);
      });
    }
    // A real scroll must release the previous resize anchor.
    scrollTo(scroll, 10_000);
    const nextAnchor = capture(scroll)[0];
    view.rerender(
      <MasonryGrid {...props} columnCount={3} containerWidth={810} />
    );
    const card = requireElement(scroll, `[data-photo-id="${nextAnchor.id}"]`);
    expect(position(card).top - scroll.scrollTop).toBeCloseTo(
      nextAnchor.offset,
      4
    );
  });

  it("starts a new resize gesture from the current visible anchor", () => {
    const gestureProps = {
      ...props,
      containerWidth: 1196,
      items: [...photos].reverse(),
      topInset: 137,
    };
    const view = render(<MasonryGrid {...gestureProps} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 30_000);
    view.rerender(
      <MasonryGrid {...gestureProps} columnCount={4} containerWidth={896} />
    );
    act(() => {
      fireEvent.scroll(scroll);
      vi.advanceTimersByTime(350);
    });
    const anchor = capture(scroll)[0];
    // The detail-panel handle is outside the grid. Its pointer gesture must
    // release the anchor retained for the previous panel opening.
    fireEvent.pointerDown(window);
    for (const containerWidth of [882, 869, 855, 841, 828, 814]) {
      view.rerender(
        <MasonryGrid
          {...gestureProps}
          columnCount={containerWidth >= 860 ? 4 : 3}
          containerWidth={containerWidth}
        />
      );
      const card = requireElement(scroll, `[data-photo-id="${anchor.id}"]`);
      expect(position(card).top - scroll.scrollTop).toBeCloseTo(
        anchor.offset,
        4
      );
      act(() => {
        fireEvent.scroll(scroll);
        vi.advanceTimersByTime(40);
      });
    }
  });

  it("keeps grouped layouts and full-width sequence trays continuous", () => {
    const items = photos.map((photo, index) =>
      index % 100 === 0
        ? { ...photo, id: -photo.id, fullWidth: true, height: 800 }
        : photo
    );
    const groupHeaders = [0, 100, 200, 300, 400].map((beforeIndex) => ({
      beforeIndex,
      label: `Group ${beforeIndex}`,
    }));
    const view = render(
      <MasonryGrid
        {...props}
        groupHeaders={groupHeaders}
        items={items}
        topInset={60}
      />
    );
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    const before = capture(scroll);
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        groupHeaders={groupHeaders}
        items={items}
        topInset={60}
      />
    );
    expectRetained(scroll, before);
  });

  it("prioritizes explicit selection and return requests over resize anchoring", () => {
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        scrollToId={1000}
      />
    );
    expect(
      visibleCards(scroll).some((card) => card.dataset.photoId === "1000")
    ).toBe(true);
    view.rerender(
      <MasonryGrid {...props} returnToPhotoId={1500} returnToPhotoRequest={1} />
    );
    expect(
      visibleCards(scroll).some((card) => card.dataset.photoId === "1500")
    ).toBe(true);
  });

  it("leaves pending route restoration in control of positioning", () => {
    restoration.positioned = false;
    const view = render(<MasonryGrid {...props} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    view.rerender(
      <MasonryGrid {...props} columnCount={3} containerWidth={664} />
    );
    expect(scroll.scrollTop).toBe(10_000);
  });

  it("does not reposition a selected card already visible below the toolbar", () => {
    const view = render(<MasonryGrid {...props} topInset={80} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    const initial = visibleCards(scroll)[0];
    const top = position(initial).top;
    scrollTo(scroll, top + 4);
    view.rerender(
      <MasonryGrid
        {...props}
        scrollToId={Number(initial.dataset.photoId)}
        topInset={80}
      />
    );
    expect(scroll.scrollTop).toBe(top + 4);
    view.rerender(
      <MasonryGrid
        {...props}
        returnToPhotoId={Number(initial.dataset.photoId)}
        returnToPhotoRequest={1}
        topInset={80}
      />
    );
    act(() => vi.advanceTimersByTime(48));
    expect(scroll.scrollTop).toBe(top + 4);
  });

  it("uses an active restored anchor lock during resizing", () => {
    const ref = createRef<MasonryGridHandle>();
    const view = render(<MasonryGrid {...props} ref={ref} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    act(() => ref.current?.scrollToItem(1000, 0.5));
    view.rerender(
      <MasonryGrid {...props} columnCount={3} containerWidth={664} ref={ref} />
    );
    const card = requireElement(scroll, '[data-photo-id="1000"]');
    const bounds = position(card);
    expect(scroll.scrollTop).toBeCloseTo(bounds.top + bounds.height * 0.5, 4);
  });

  it("preserves the screen offset when only the toolbar height changes", () => {
    const view = render(<MasonryGrid {...props} topInset={80} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 30_000);
    const before = capture(scroll);
    view.rerender(<MasonryGrid {...props} topInset={120} />);
    expectRetained(scroll, before);
    expect(scroll.scrollTop).toBe(30_040);
  });

  it("waits for measured width before completing a return request", () => {
    const located = vi.fn();
    const view = render(<MasonryGrid {...props} onReturnLocated={located} />);
    const scroll = requireElement(view.container, "[data-masonry-scroll]");
    scrollTo(scroll, 10_000);
    Object.defineProperty(scroll, "clientWidth", {
      configurable: true,
      value: 664,
    });
    view.rerender(
      <MasonryGrid
        {...props}
        onReturnLocated={located}
        returnToPhotoId={1000}
        returnToPhotoRequest={1}
      />
    );
    act(() => vi.advanceTimersByTime(32));
    expect(scroll.scrollTop).toBe(10_000);
    expect(located).not.toHaveBeenCalled();
    view.rerender(
      <MasonryGrid
        {...props}
        columnCount={3}
        containerWidth={664}
        onReturnLocated={located}
        returnToPhotoId={1000}
        returnToPhotoRequest={1}
      />
    );
    fireEvent.scroll(scroll);
    act(() => vi.advanceTimersByTime(48));
    expect(
      visibleCards(scroll).some((card) => card.dataset.photoId === "1000")
    ).toBe(true);
    expect(located).toHaveBeenCalledWith(1);
  });
});
