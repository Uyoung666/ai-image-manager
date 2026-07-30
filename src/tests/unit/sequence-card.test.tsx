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
    expect(onClick).toHaveBeenCalledWith(
      sequence.photo.id,
      expect.objectContaining({ ctrlKey: false })
    );
    act(() => vi.advanceTimersByTime(250));
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
