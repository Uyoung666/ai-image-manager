import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SequenceCard } from "@/components/SequenceCard";
import { useGalleryThumbnail } from "@/hooks/useGalleryThumbnail";
import type { PhotoSequence } from "@/types/photo-sequence";
import { toGalleryThumbnailUrl } from "@/utils/local-media-url";

vi.mock("@/hooks/useGalleryThumbnail", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/hooks/useGalleryThumbnail")>();
  return { ...actual, useGalleryThumbnail: vi.fn(actual.useGalleryThumbnail) };
});
vi.mock("@/utils/local-media-url", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/local-media-url")>();
  return {
    ...actual,
    toGalleryThumbnailUrl: vi.fn(actual.toGalleryThumbnailUrl),
  };
});

const SEQUENCE_BADGE_LABEL = /^sequenceBurst/;

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
const coverProps = {
  isSelected: false,
  onClick: vi.fn(),
  onOpen: vi.fn(),
  onOpenDetails: vi.fn(),
  sequence,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(useGalleryThumbnail).mockReset();
  vi.mocked(toGalleryThumbnailUrl).mockReset();
});

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
    expect(image).toHaveAttribute("data-load-state", "loading");
    expect(image).toHaveClass("opacity-0");

    if (image) {
      fireEvent.load(image);
    }
    expect(image).toHaveClass("opacity-100");
    expect(image).toHaveClass("transition-opacity");
  });

  it("reveals a cached cover before another load event without restarting its fade", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    const { container } = render(<SequenceCard {...coverProps} />);
    const image = screen.getByRole("img", { name: sequence.photo.filename });

    expect(image).toHaveAttribute("data-load-state", "loaded");
    expect(image).toHaveClass("opacity-100", "transition-none");
    expect(image).not.toHaveClass("transition-opacity");
    expect(container.querySelector('div[aria-hidden="true"]')).toBeNull();
    fireEvent.load(image);
    expect(image).toHaveClass("transition-none");
  });

  it("reveals a cached cover when the virtualized card mounts again", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    const { rerender } = render(<SequenceCard {...coverProps} />);
    rerender(<div />);
    rerender(<SequenceCard {...coverProps} />);

    expect(
      screen.getByRole("img", { name: sequence.photo.filename })
    ).toHaveClass("opacity-100", "transition-none");
  });

  it("waits for a cold replacement after a cached cover", () => {
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    const { rerender } = render(<SequenceCard {...coverProps} />);
    complete.mockReturnValue(false);
    rerender(
      <SequenceCard
        {...coverProps}
        sequence={{
          ...sequence,
          photo: {
            ...sequence.photo,
            thumbnailPath: "C:/thumbnails/replacement.jpg",
          },
        }}
      />
    );
    const image = screen.getByRole("img", { name: sequence.photo.filename });
    expect(image).toHaveAttribute("data-load-state", "loading");
    expect(image).toHaveClass("opacity-0");
    fireEvent.load(image);
    expect(image).toHaveClass("opacity-100", "transition-opacity");
  });

  it("keeps a completed but undecodable cover hidden and restores the placeholder on error", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      0
    );
    const { container } = render(<SequenceCard {...coverProps} />);
    const image = screen.getByRole("img", { name: sequence.photo.filename });
    expect(image).toHaveClass("opacity-0");
    fireEvent.error(image);
    expect(image).toHaveClass("opacity-0");
    fireEvent.load(image);
    expect(image).toHaveClass("opacity-100");
    fireEvent.error(image);
    expect(image).toHaveClass("opacity-0");
    expect(
      container.querySelector('div[aria-hidden="true"]')
    ).toBeInTheDocument();
  });

  it("acknowledges cached managed covers and keeps them visible during a resource upgrade", () => {
    vi.mocked(toGalleryThumbnailUrl).mockReturnValue("http://gallery/1/256");
    const thumbnail = {
      ref: { current: null },
      url: "http://gallery/1/256",
      failed: false,
      onDisplayed: vi.fn(),
    };
    const hook = vi.mocked(useGalleryThumbnail).mockReturnValue(thumbnail);
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    const { rerender } = render(<SequenceCard {...coverProps} />);
    expect(thumbnail.onDisplayed).toHaveBeenCalledWith(thumbnail.url);

    complete.mockReturnValue(false);
    const upgradedUrl = "http://gallery/1/512";
    hook.mockReturnValue({ ...thumbnail, url: upgradedUrl });
    rerender(<SequenceCard {...coverProps} imageWidth={400} />);
    const image = screen.getByRole("img", { name: sequence.photo.filename });
    expect(image).toHaveClass("opacity-100", "transition-none");
    fireEvent.load(image);
    expect(thumbnail.onDisplayed).toHaveBeenLastCalledWith(upgradedUrl);
    expect(image).toHaveClass("transition-none");

    hook.mockReturnValue({ ...thumbnail, url: upgradedUrl, failed: true });
    rerender(<SequenceCard {...coverProps} imageWidth={500} />);
    expect(image).toHaveClass("opacity-0");
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
    expect(onOpenDetails).toHaveBeenCalledWith(
      sequence.id,
      expect.objectContaining({ type: "click" })
    );
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

  it("forwards a details badge click without selecting the group", () => {
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
    fireEvent.click(
      screen.getByRole("button", { name: SEQUENCE_BADGE_LABEL }),
      {
        detail: 1,
      }
    );
    expect(onOpenDetails).toHaveBeenCalledWith(
      sequence.id,
      expect.objectContaining({ type: "click", detail: 1 })
    );
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps Enter detail opening separate from mouse click focus", () => {
    const onOpenDetails = vi.fn();
    render(
      <SequenceCard
        isSelected={false}
        onClick={vi.fn()}
        onOpen={vi.fn()}
        onOpenDetails={onOpenDetails}
        sequence={sequence}
      />
    );
    fireEvent.keyDown(
      screen.getByRole("button", { name: "sequenceCardLabel" }),
      {
        key: "Enter",
      }
    );
    expect(onOpenDetails).toHaveBeenCalledExactlyOnceWith(sequence.id);
  });
});
