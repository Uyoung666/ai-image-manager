import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SequenceCard } from "@/components/SequenceCard";
import type { PhotoSequence } from "@/types/photo-sequence";

const sequence: PhotoSequence = {
  endedAt: 1000,
  frameCount: 3,
  id: 42,
  photo: {
    filename: "frame-1.jpg",
    fileSize: 1024,
    height: 1000,
    id: 1,
    isIndexed: true,
    path: "C:/photos/frame-1.jpg",
    thumbnailPath: "C:/thumbnails/frame-1.jpg",
    width: 1500,
  },
  representativePhotoId: 1,
  source: "auto",
  startedAt: 0,
  type: "burst",
};

describe("SequenceCard", () => {
  it("shows a full-order frame marker without selecting the sequence", () => {
    const { rerender } = render(
      <SequenceCard
        isSelected={false}
        onClick={vi.fn()}
        onOpen={vi.fn()}
        onOpenDetails={vi.fn()}
        recentlyViewed
        recentlyViewedFrame={80}
        recentlyViewedPulseActive
        sequence={sequence}
      />
    );
    expect(screen.getByRole("status")).toHaveTextContent("刚刚浏览 · 第 80 帧");
    expect(
      screen.getByRole("button", { name: "sequenceCardLabel" })
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "sequenceCardLabel" })
    ).toHaveClass("photo-card-recently-viewed-pulse");
    rerender(
      <SequenceCard
        isSelected={false}
        onClick={vi.fn()}
        onOpen={vi.fn()}
        onOpenDetails={vi.fn()}
        recentlyViewed
        recentlyViewedFrame={80}
        sequence={sequence}
      />
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "sequenceCardLabel" })
    ).not.toHaveClass("photo-card-recently-viewed-pulse");
  });
  it("fades the cover in after an eager image load", () => {
    const { container } = render(
      <SequenceCard
        isSelected={false}
        loading="eager"
        onClick={vi.fn()}
        onOpen={vi.fn()}
        onOpenDetails={vi.fn()}
        sequence={sequence}
      />
    );
    const image = container.querySelector("img");
    expect(image).toHaveAttribute("loading", "eager");
    expect(image).toHaveClass("opacity-0");

    if (image) {
      fireEvent.load(image);
    }
    expect(image).toHaveClass("opacity-100");
  });

  it("selects and opens sequence details on a normal click", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onOpenDetails = vi.fn();

    render(
      <SequenceCard
        isSelected={false}
        onClick={onClick}
        onOpen={vi.fn()}
        onOpenDetails={onOpenDetails}
        sequence={sequence}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "sequenceCardLabel" }));
    expect(onClick).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(250));
    expect(onClick).toHaveBeenCalledWith(
      sequence.photo.id,
      expect.objectContaining({ ctrlKey: false })
    );
    expect(onOpenDetails).toHaveBeenCalledWith(sequence.id);
    vi.useRealTimers();
  });

  it("selects the folded group on a modified click", () => {
    const onClick = vi.fn();
    const onOpenDetails = vi.fn();

    render(
      <SequenceCard
        isSelected={false}
        onClick={onClick}
        onOpen={vi.fn()}
        onOpenDetails={onOpenDetails}
        sequence={sequence}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "sequenceCardLabel" }), {
      ctrlKey: true,
    });

    expect(onClick).toHaveBeenCalledWith(
      sequence.photo.id,
      expect.objectContaining({ ctrlKey: true })
    );
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it("opens the sequence lightbox on double click", () => {
    const onOpen = vi.fn();
    const onOpenDetails = vi.fn();

    render(
      <SequenceCard
        isSelected={false}
        onClick={vi.fn()}
        onOpen={onOpen}
        onOpenDetails={onOpenDetails}
        sequence={sequence}
      />
    );

    fireEvent.doubleClick(
      screen.getByRole("button", { name: "sequenceCardLabel" })
    );

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen).toHaveBeenCalledWith(sequence.id);
    expect(onOpenDetails).not.toHaveBeenCalled();
  });

  it("cancels pending selection and details when a double click follows real clicks", () => {
    vi.useFakeTimers();
    const onClick = vi.fn();
    const onOpenDetails = vi.fn();
    const onOpen = vi.fn();
    render(
      <SequenceCard
        isSelected={false}
        onClick={onClick}
        onOpen={onOpen}
        onOpenDetails={onOpenDetails}
        sequence={sequence}
      />
    );
    const card = screen.getByRole("button", { name: "sequenceCardLabel" });
    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    fireEvent.doubleClick(card);
    act(() => vi.advanceTimersByTime(250));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(sequence.id);
    expect(onClick).not.toHaveBeenCalled();
    expect(onOpenDetails).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("expands from its top-right control without opening details", () => {
    const onOpen = vi.fn();
    const onOpenDetails = vi.fn();
    const onToggleExpand = vi.fn();

    render(
      <SequenceCard
        isSelected={false}
        onClick={vi.fn()}
        onOpen={onOpen}
        onOpenDetails={onOpenDetails}
        onToggleExpand={onToggleExpand}
        sequence={sequence}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "sequenceExpand" }));

    expect(onToggleExpand).toHaveBeenCalledWith(sequence.id);
    expect(onOpen).not.toHaveBeenCalled();
    expect(onOpenDetails).not.toHaveBeenCalled();
  });
});
