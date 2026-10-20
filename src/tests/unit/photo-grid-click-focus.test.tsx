import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MasonryGrid,
  MasonryPhotoFocusRequest,
} from "@/components/MasonryGrid";
import { PhotoGrid } from "@/components/PhotoGrid";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";

const grid = vi.hoisted(() => ({
  indexOffset: 0,
  renderImage: true,
  latestRequest: null as MasonryPhotoFocusRequest | null,
  onBackToTop: undefined as ComponentProps<typeof MasonryGrid>["onBackToTop"],
  onPhotoFocusSettled: undefined as ComponentProps<
    typeof MasonryGrid
  >["onPhotoFocusSettled"],
}));

vi.mock("@/components/MasonryGrid", () => ({
  MasonryGrid: ({
    items,
    photoFocusRequest,
    onPhotoFocusSettled,
    onBackToTop,
    renderItem,
  }: ComponentProps<typeof MasonryGrid>) => {
    grid.latestRequest = photoFocusRequest ?? null;
    grid.onPhotoFocusSettled = onPhotoFocusSettled;
    grid.onBackToTop = onBackToTop;
    return (
      <div data-testid="grid">
        {items.map((photo, index) => (
          <div key={photo.id}>
            {renderItem(
              photo,
              index + grid.indexOffset,
              {},
              { renderImage: grid.renderImage }
            )}
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
const sequence: PhotoSequence = {
  id: 7,
  type: "burst",
  source: "manual",
  startedAt: 0,
  endedAt: 3,
  frameCount: 3,
  representativePhotoId: 1,
  memberPhotoIds: [1, 2, 3],
  photo: photos[0],
};
const sequenceProps = {
  ...props,
  sequences: [sequence],
  sequenceMode: "sequences" as const,
  inlineDetailPhotoId: null,
  onOpenSequence: vi.fn(),
  onOpenSequenceDetails: vi.fn(),
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
  grid.indexOffset = 0;
  grid.renderImage = true;
  grid.latestRequest = null;
  grid.onPhotoFocusSettled = undefined;
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

describe("sequence grid click focus", () => {
  it.each([
    "inline",
    "overlay",
  ])("keeps member arrows inside a middle sequence with %s details", (mode) => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(900);
    const members = photos.map((photo) => ({ ...photo, id: photo.id + 200 }));
    const currentSequence = {
      ...sequence,
      photo: members[0],
      representativePhotoId: members[0].id,
      memberPhotoIds: members.map((member) => member.id),
    };
    const before = { ...photos[0], id: 101 };
    const after = { ...photos[0], id: 301 };
    const onKeyboardSelect = vi.fn();
    const onPanelArrow = vi.fn();
    const sidebarButton = document.createElement("button");
    sidebarButton.dataset.surface = "inspector";
    const otherControl = document.createElement("button");
    document.body.append(sidebarButton);
    document.body.append(otherControl);
    window.addEventListener("keydown", onPanelArrow);
    const keyboardProps = {
      ...sequenceProps,
      photos: [before, ...members, after],
      sequences: [
        {
          ...sequence,
          id: 6,
          photo: before,
          representativePhotoId: before.id,
          memberPhotoIds: [before.id],
        },
        currentSequence,
        {
          ...sequence,
          id: 8,
          photo: after,
          representativePhotoId: after.id,
          memberPhotoIds: [after.id],
        },
      ],
      expandedSequence: { ...currentSequence, members, userLocked: false },
      inlineDetailPhotoId: mode === "inline" ? null : undefined,
      columnWidth: 100,
      onKeyboardSelect,
    };
    try {
      const view = render(
        <PhotoGrid {...keyboardProps} selectedIds={new Set([201])} />
      );
      for (const target of [view.getByTestId("grid"), sidebarButton]) {
        fireEvent.keyDown(target, { key: "ArrowLeft" });
        fireEvent.keyDown(target, { key: "ArrowUp" });
      }
      expect(onKeyboardSelect).not.toHaveBeenCalled();
      expect(onPanelArrow).not.toHaveBeenCalled();
      expect(grid.latestRequest).toBeNull();
      fireEvent.keyDown(otherControl, { key: "ArrowLeft" });
      expect(onPanelArrow).toHaveBeenCalledOnce();
      onPanelArrow.mockClear();
      fireEvent.keyDown(view.getByTestId("grid"), { key: "ArrowRight" });
      expect(onKeyboardSelect).toHaveBeenLastCalledWith(202);
      onKeyboardSelect.mockClear();
      onPanelArrow.mockClear();
      view.rerender(
        <PhotoGrid {...keyboardProps} selectedIds={new Set([202])} />
      );
      fireEvent.keyDown(view.getByTestId("grid"), { key: "ArrowDown" });
      expect(onKeyboardSelect).toHaveBeenLastCalledWith(203);
      fireEvent.keyDown(view.getByTestId("grid"), { key: "ArrowUp" });
      expect(onKeyboardSelect).toHaveBeenLastCalledWith(201);
      onKeyboardSelect.mockClear();
      onPanelArrow.mockClear();
      view.rerender(
        <PhotoGrid {...keyboardProps} selectedIds={new Set([203])} />
      );
      for (const target of [view.getByTestId("grid"), sidebarButton]) {
        fireEvent.keyDown(target, { key: "ArrowRight" });
        fireEvent.keyDown(target, { key: "ArrowDown" });
      }
      expect(onKeyboardSelect).not.toHaveBeenCalled();
      expect(onPanelArrow).not.toHaveBeenCalled();
      fireEvent.keyDown(view.getByTestId("grid"), { key: "ArrowLeft" });
      expect(onKeyboardSelect).toHaveBeenLastCalledWith(202);
    } finally {
      window.removeEventListener("keydown", onPanelArrow);
      sidebarButton.remove();
      otherControl.remove();
      width.mockRestore();
    }
  });

  it.each([
    "before",
    "after",
  ])("owns member arrows when the detail listener is registered %s the grid", (registration) => {
    const onPanelArrow = vi.fn();
    const panelListener = (event: KeyboardEvent) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        onPanelArrow();
      }
    };
    const onKeyboardSelect = vi.fn();
    const keyboardProps = {
      ...sequenceProps,
      expandedSequence: { ...sequence, members: photos, userLocked: false },
      onKeyboardSelect,
    };
    if (registration === "before") {
      window.addEventListener("keydown", panelListener);
    }
    try {
      const view = render(
        <PhotoGrid {...keyboardProps} selectedIds={new Set([1])} />
      );
      if (registration === "after") {
        window.addEventListener("keydown", panelListener);
      }
      fireEvent.keyDown(view.getByTestId("grid"), { key: "ArrowDown" });
      expect(onKeyboardSelect).toHaveBeenLastCalledWith(3);
      expect(onPanelArrow).not.toHaveBeenCalled();

      view.rerender(
        <PhotoGrid {...keyboardProps} selectedIds={new Set([3])} />
      );
      fireEvent.keyDown(document.body, { key: "ArrowDown" });
      expect(onKeyboardSelect).toHaveBeenCalledTimes(1);
      expect(onPanelArrow).not.toHaveBeenCalled();
      view.rerender(
        <PhotoGrid {...keyboardProps} selectedIds={new Set([1])} />
      );
      fireEvent.keyDown(document.body, { key: "ArrowUp" });
      expect(onKeyboardSelect).toHaveBeenCalledTimes(1);
      expect(onPanelArrow).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", panelListener);
    }
  });

  it("leaves text fields, sidebar controls and overlay mode out of member arrow ownership", () => {
    const onPanelArrow = vi.fn();
    window.addEventListener("keydown", onPanelArrow);
    const sidebarButton = document.createElement("button");
    document.body.append(sidebarButton);
    const keyboardProps = {
      ...sequenceProps,
      expandedSequence: { ...sequence, members: photos, userLocked: false },
      onKeyboardSelect: vi.fn(),
      selectedIds: new Set([2]),
    };
    try {
      const view = render(<PhotoGrid {...keyboardProps} />);
      for (const tag of ["input", "textarea"]) {
        const field = document.createElement(tag);
        view.getByTestId("grid").append(field);
        fireEvent.keyDown(field, { key: "ArrowDown" });
        field.remove();
      }
      expect(onPanelArrow).toHaveBeenCalledTimes(2);
      expect(keyboardProps.onKeyboardSelect).not.toHaveBeenCalled();
      fireEvent.keyDown(sidebarButton, { key: "ArrowDown" });
      expect(onPanelArrow).toHaveBeenCalledTimes(3);
      view.rerender(
        <PhotoGrid {...keyboardProps} inlineDetailPhotoId={undefined} />
      );
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(onPanelArrow).toHaveBeenCalledTimes(4);
      view.rerender(<PhotoGrid {...keyboardProps} expandedSequence={null} />);
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(onPanelArrow).toHaveBeenCalledTimes(5);
    } finally {
      window.removeEventListener("keydown", onPanelArrow);
      sidebarButton.remove();
    }
  });

  it("follows keyboard selection using the expanded tray's six-column limit", () => {
    const width = vi
      .spyOn(HTMLElement.prototype, "clientWidth", "get")
      .mockReturnValue(2000);
    try {
      const members = Array.from({ length: 30 }, (_, index) => ({
        ...photos[0],
        id: index + 1,
      }));
      const sequence = {
        ...sequenceProps.sequences[0],
        photo: members[0],
        memberPhotoIds: members.map((member) => member.id),
        matchedPhotoIds: members.map((member) => member.id),
      };
      const expanded: PhotoSequenceDetail = {
        ...sequence,
        members,
        userLocked: false,
      };
      const onKeyboardSelect = vi.fn();
      const keyboardProps = {
        ...sequenceProps,
        photos: members,
        sequences: [sequence],
        expandedSequence: expanded,
        columnWidth: 100,
        onKeyboardSelect,
      };
      const view = render(
        <PhotoGrid
          {...keyboardProps}
          inlineDetailPhotoId={1}
          selectedIds={new Set([1])}
        />
      );
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(onKeyboardSelect).toHaveBeenLastCalledWith(7);
      view.rerender(
        <PhotoGrid
          {...keyboardProps}
          inlineDetailPhotoId={7}
          selectedIds={new Set([7])}
        />
      );
      expect(grid.latestRequest).toEqual(
        expect.objectContaining({
          photoId: -sequence.id,
          memberId: 7,
          keyboard: true,
          targetRect: null,
        })
      );
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(onKeyboardSelect).toHaveBeenLastCalledWith(8);
      view.rerender(
        <PhotoGrid
          {...keyboardProps}
          inlineDetailPhotoId={8}
          selectedIds={new Set([8])}
        />
      );
      expect(grid.latestRequest).toEqual(
        expect.objectContaining({
          photoId: -sequence.id,
          memberId: 8,
          keyboard: true,
        })
      );
      view.rerender(
        <PhotoGrid
          {...keyboardProps}
          expandedSequence={null}
          inlineDetailPhotoId={8}
          selectedIds={new Set([8])}
        />
      );
      expect(grid.latestRequest).toBeNull();
      view.rerender(
        <PhotoGrid
          {...keyboardProps}
          inlineDetailPhotoId={8}
          selectedIds={new Set([8])}
        />
      );
      expect(grid.latestRequest).toBeNull();
    } finally {
      width.mockRestore();
    }
  });
  it.each([
    "empty",
    "group",
  ])("centers the sequence cover with %s selection", (selection) => {
    render(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={7}
        selectedIds={new Set(selection === "group" ? [1, 2, 3] : [])}
        sequenceFocusRequest={{ id: 42, sequenceId: 7, memberId: null }}
      />
    );
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 1, photoId: 1 })
    );
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it("retains a sequence request until its asynchronous inline detail is shown", () => {
    const request = { id: 42, sequenceId: 7, memberId: null };
    const view = render(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={null}
        sequenceFocusRequest={request}
      />
    );
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={7}
        sequenceFocusRequest={request}
      />
    );
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 1, photoId: 1 })
    );
  });

  it("maps a folded member to its cover and an expanded member to a pending tray rectangle", () => {
    const view = render(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailPhotoId={3}
        sequenceFocusRequest={{ id: 42, sequenceId: 7, memberId: 3 }}
      />
    );
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 1, photoId: 1 })
    );
    const expanded: PhotoSequenceDetail = {
      ...sequence,
      members: photos,
      userLocked: true,
    };
    view.rerender(
      <PhotoGrid
        {...sequenceProps}
        expandedSequence={expanded}
        inlineDetailPhotoId={3}
        sequenceFocusRequest={{ id: 43, sequenceId: 7, memberId: 3 }}
      />
    );
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 2, photoId: -7, targetRect: null })
    );
  });

  it("centers the expanded tray and consumes the request when a member is filtered out", () => {
    const handled = vi.fn();
    const expanded: PhotoSequenceDetail = {
      ...sequence,
      members: photos.slice(0, 2),
      userLocked: true,
    };
    const request = { id: 42, sequenceId: 7, memberId: 3 };
    const view = render(
      <PhotoGrid
        {...sequenceProps}
        expandedSequence={expanded}
        inlineDetailPhotoId={3}
        onSequenceFocusHandled={handled}
        sequenceFocusRequest={request}
      />
    );
    expect(grid.latestRequest).toEqual(
      expect.objectContaining({ id: 1, photoId: -7 })
    );
    expect(grid.latestRequest?.targetRect).toBeUndefined();
    act(() => grid.onPhotoFocusSettled?.(1));
    expect(handled).toHaveBeenCalledOnce();
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...sequenceProps}
        expandedSequence={expanded}
        inlineDetailPhotoId={3}
        onSequenceFocusHandled={handled}
        sequenceFocusRequest={request}
      />
    );
    expect(grid.latestRequest).toBeNull();
    expect(handled).toHaveBeenCalledOnce();
  });

  it("consumes a completed external request once without replaying it on rerender", () => {
    const request = { id: 42, sequenceId: 7, memberId: null };
    const handled = vi.fn();
    const view = render(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={7}
        onSequenceFocusHandled={handled}
        sequenceFocusRequest={request}
      />
    );
    const id = grid.latestRequest?.id;
    if (id === undefined) {
      throw new Error("Missing sequence focus request");
    }
    act(() => grid.onPhotoFocusSettled?.(id));
    expect(handled).toHaveBeenCalledOnce();
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={7}
        onSequenceFocusHandled={handled}
        sequenceFocusRequest={request}
      />
    );
    expect(grid.latestRequest).toBeNull();
    view.rerender(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={7}
        onSequenceFocusHandled={handled}
        sequenceFocusRequest={null}
      />
    );
    expect(handled).toHaveBeenCalledOnce();
    expect(grid.latestRequest).toBeNull();
  });

  it("cancels pending sequence focus on scrolling and does not activate it after loading", () => {
    const request = { id: 42, sequenceId: 7, memberId: null };
    const handled = vi.fn();
    const view = render(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={null}
        onSequenceFocusHandled={handled}
        sequenceFocusRequest={request}
      />
    );
    expect(grid.latestRequest).toBeNull();
    fireEvent.wheel(view.getByTestId("grid"));
    expect(handled).toHaveBeenCalledOnce();
    view.rerender(
      <PhotoGrid
        {...sequenceProps}
        inlineDetailSequenceId={7}
        onSequenceFocusHandled={handled}
        sequenceFocusRequest={request}
      />
    );
    expect(grid.latestRequest).toBeNull();
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("photo grid click focus", () => {
  it("loads restored visible thumbnails eagerly while keeping out-of-window images unmounted", () => {
    grid.indexOffset = 100;
    const thumbnailPhotos = photos.map((photo) => ({
      ...photo,
      thumbnailPath: `C:/thumbnails/${photo.id}.webp`,
    }));
    const { rerender } = render(
      <PhotoGrid {...props} photos={thumbnailPhotos} />
    );
    for (const image of screen.getAllByRole("img")) {
      expect(image).toHaveAttribute("loading", "eager");
    }
    grid.renderImage = false;
    rerender(
      <PhotoGrid {...props} columnWidth={150} photos={thumbnailPhotos} />
    );
    expect(screen.queryAllByRole("img")).toHaveLength(0);
  });
  it("consumes pending positioning when back to top is activated without a pointer gesture", () => {
    const onBackToTop = vi.fn();
    const view = render(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        onBackToTop={onBackToTop}
        selectedIds={new Set([1])}
      />
    );
    clickPhoto(photoCard(view.container));
    expect(grid.latestRequest).not.toBeNull();
    act(() => grid.onBackToTop?.());
    expect(grid.latestRequest).toBeNull();
    expect(onBackToTop).toHaveBeenCalledOnce();
    view.rerender(
      <PhotoGrid
        {...props}
        inlineDetailPhotoId={1}
        onBackToTop={onBackToTop}
        selectedIds={new Set([1])}
      />
    );
    expect(grid.latestRequest).toBeNull();
  });
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
