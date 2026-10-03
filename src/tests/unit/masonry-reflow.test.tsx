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
          (Number.parseFloat(this.style.paddingTop) || 0)
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
      act(() => vi.advanceTimersByTime(40));
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
