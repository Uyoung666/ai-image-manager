import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SequenceCard } from "@/components/SequenceCard";
import type { PhotoSequence } from "@/types/photo-sequence";

const sequence: PhotoSequence = {
  endedAt: 1_000,
  frameCount: 3,
  id: 42,
  photo: {
    filename: "frame-1.jpg",
    fileSize: 1_024,
    height: 1_000,
    id: 1,
    isIndexed: true,
    path: "C:/photos/frame-1.jpg",
    thumbnailPath: "C:/thumbnails/frame-1.jpg",
    width: 1_500,
  },
  representativePhotoId: 1,
  source: "auto",
  startedAt: 0,
  type: "burst",
};

describe("SequenceCard", () => {
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
});
