import { act, cleanup, fireEvent, render } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MasonryGrid,
  MasonryPhotoFocusRequest,
} from "@/components/MasonryGrid";
import { PhotoGrid } from "@/components/PhotoGrid";
import type { Photo } from "@/types/photo";

const grid = vi.hoisted(() => ({
  latestRequest: null as MasonryPhotoFocusRequest | null,
}));

vi.mock("@/components/MasonryGrid", () => ({
  MasonryGrid: ({
    items,
    photoFocusRequest,
    renderItem,
  }: ComponentProps<typeof MasonryGrid>) => {
    grid.latestRequest = photoFocusRequest ?? null;
    return (
      <div data-testid="grid">
        {items.map((photo, index) => (
          <div key={photo.id}>
            {renderItem(photo, index, {}, { renderImage: true })}
          </div>
        ))}
      </div>
    );
  },
}));

const photos: Photo[] = [1, 2, 3].map((id) => ({
  id,
  filename: `${id}.jpg`,
  fileDate: id,
  fileSize: 100,
  width: 100,
  height: 80,
  path: `C:/fixture/${id}.jpg`,
  isIndexed: true,
  thumbnailPath: null,
}));
const props = {
  loading: false,
  photos,
  routeKey: "click-focus-test",
  selectedIds: new Set<number>(),
  onSelect: vi.fn(),
  onDoubleClick: vi.fn(),
  onContextMenu: vi.fn(),
  showToolbar: false,
};

function photoCard(container: ParentNode, photoId = 1) {
  const card = container.querySelector<HTMLElement>(
    `[data-photo-id="${photoId}"][role="option"]`
  );
  if (!card) {
    throw new Error(`Missing photo card ${photoId}`);
  }
  return card;
}

function clickPhoto(card: HTMLElement, modifiers: MouseEventInit = {}) {
  fireEvent.click(card, { detail: 1, ...modifiers });
  act(() => vi.advanceTimersByTime(250));
}

beforeEach(() => {
  grid.latestRequest = null;
  vi.clearAllMocks();
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
      unobserve() {
        return undefined;
      }
    }
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("photo grid click focus", () => {
  it("waits for both a matching single selection and inline detail photo", () => {
    const view = render(<PhotoGrid {...props} inlineDetailPhotoId={null} />);
    fireEvent.click(photoCard(view.container), { detail: 1 });
    act(() => vi.advanceTimersByTime(249));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(grid.latestRequest).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(props.onSelect).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ type: "click" })
    );
    expect(grid.latestRequest).toBeNull();

    view.rerender(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        selectedIds={new Set([2])}
      />
    );
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        selectedIds={new Set([1, 2])}
      />
    );
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={2}
        selectedIds={new Set([1])}
      />
    );
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        selectedIds={new Set([1])}
      />
    );
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 1, photoId: 1 })
    );
  });

  it("issues another request when the same photo is clicked again", () => {
    const view = render(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        selectedIds={new Set([1])}
      />
    );
    clickPhoto(photoCard(view.container));
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 1, photoId: 1 })
    );
    clickPhoto(photoCard(view.container));
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 2, photoId: 1 })
    );
    expect(props.onSelect).toHaveBeenCalledTimes(2);
  });

  for (const modifier of ["ctrlKey", "metaKey", "shiftKey", "altKey"]) {
    it(`keeps ${modifier} selection out of click focus`, () => {
      const view = render(
        <PhotoGrid
          {...props}
          inlineDetailPhotoId={1}
          selectedIds={new Set([1])}
        />
      );
      clickPhoto(photoCard(view.container));
      expect(grid.latestRequest).toEqual(
        expect.objectContaining({ id: 1, photoId: 1 })
      );
      clickPhoto(photoCard(view.container), { [modifier]: true });
      expect(props.onSelect).toHaveBeenLastCalledWith(
        1,
        expect.objectContaining({ [modifier]: true })
      );
      expect(grid.latestRequest).toBeNull();
      clickPhoto(photoCard(view.container));
      expect(grid.latestRequest).toEqual(
        expect.objectContaining({ id: 2, photoId: 1 })
      );
    });
  }

  it("preserves Space selection without requesting mouse click focus", () => {
    const view = render(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        selectedIds={new Set([1])}
      />
    );
    clickPhoto(photoCard(view.container));
    expect(grid.latestRequest).not.toBeNull();
    fireEvent.keyDown(photoCard(view.container), { key: " " });
    expect(props.onSelect).toHaveBeenLastCalledWith(
      1,
      expect.objectContaining({ type: "keydown" })
    );
    expect(grid.latestRequest).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(grid.latestRequest).toBeNull();
  });

  it("lets double click cancel its delayed single click without a focus request", () => {
    const view = render(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        selectedIds={new Set([1])}
      />
    );
    const card = photoCard(view.container);
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    fireEvent.doubleClick(card);
    act(() => vi.advanceTimersByTime(250));
    expect(props.onDoubleClick).toHaveBeenCalledExactlyOnceWith(1);
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(grid.latestRequest).toBeNull();
  });

  it("does not retain overlay clicks when the same photo later has inline detail", () => {
    const view = render(<PhotoGrid {...props} />);
    clickPhoto(photoCard(view.container));
    expect(props.onSelect).toHaveBeenCalledOnce();
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        selectedIds={new Set([1])}
      />
    );
    expect(grid.latestRequest).toBeNull();
    clickPhoto(photoCard(view.container));
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 1, photoId: 1 })
    );
  });
});
