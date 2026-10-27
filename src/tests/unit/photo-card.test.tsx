import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoCard } from "@/components/PhotoCard";
import { useGalleryThumbnail } from "@/hooks/useGalleryThumbnail";
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

const PERCENTAGE_PATTERN = /%/;

describe("PhotoCard", () => {
  const baseProps = {
    filename: "test-photo.jpg",
    height: 3000,
    id: 1,
    isSelected: false,
    onClick: vi.fn(),
    onDoubleClick: vi.fn(),
    path: "C:/Photos/test-photo.jpg",
    thumbnailPath: null as string | null,
    width: 4000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    baseProps.onClick.mockClear();
    baseProps.onDoubleClick.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.mocked(useGalleryThumbnail).mockReset();
    vi.mocked(toGalleryThumbnailUrl).mockReset();
  });

  it("does not render image element without thumbnailPath", () => {
    const { container } = render(<PhotoCard {...baseProps} />);
    const img = container.querySelector("img");
    expect(img).not.toBeInTheDocument();
  });

  it("acknowledges a cached image only during committed effects under StrictMode", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    vi.mocked(toGalleryThumbnailUrl).mockReturnValue("http://gallery/1/256");
    const onDisplayed = vi.fn();
    vi.mocked(useGalleryThumbnail).mockReturnValue({
      ref: { current: null },
      url: "http://gallery/1/256",
      failed: false,
      onDisplayed,
    });
    render(
      <StrictMode>
        <PhotoCard {...baseProps} />
      </StrictMode>
    );
    expect(screen.getByRole("img", { name: "test-photo.jpg" })).toHaveAttribute(
      "data-load-state",
      "loaded"
    );
    // StrictMode commits the mount effect twice; replaying state calculations
    // must not send another acknowledgment that could release a newer request.
    expect(onDisplayed).toHaveBeenCalledTimes(2);
  });

  it("clears a failed placeholder only after a rebound managed resource succeeds", () => {
    vi.mocked(toGalleryThumbnailUrl).mockReturnValue("http://gallery/1/256");
    const thumbnail = {
      ref: { current: null },
      url: "",
      failed: true,
      onDisplayed: vi.fn(),
    };
    const hook = vi.mocked(useGalleryThumbnail).mockReturnValue(thumbnail);
    const { rerender } = render(<PhotoCard {...baseProps} />);
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();

    hook.mockReturnValue({ ...thumbnail, failed: false });
    rerender(<PhotoCard {...baseProps} path="C:/Photos/rebound.jpg" />);
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();

    hook.mockReturnValue({
      ...thumbnail,
      url: "http://gallery/1/256?v=source-1",
      failed: false,
    });
    rerender(
      <PhotoCard
        {...baseProps}
        path="C:/Photos/rebound.jpg"
        thumbnailVersion="new-source"
      />
    );
    expect(screen.queryByRole("button", { name: "retry" })).toBeNull();
    expect(screen.getByRole("img", { name: "test-photo.jpg" })).toHaveAttribute(
      "src",
      "http://gallery/1/256?v=source-1"
    );
  });

  it("can disable photo dragging for collection views", () => {
    const { container } = render(<PhotoCard {...baseProps} disableDrag />);
    const card = container.querySelector("[data-photo-id]");
    expect(card).toHaveAttribute("draggable", "false");
  });

  it("renders filename in overlay", () => {
    render(<PhotoCard {...baseProps} />);
    expect(screen.getByText("test-photo.jpg")).toBeInTheDocument();
  });

  it("shows dimensions in overlay", () => {
    render(<PhotoCard {...baseProps} />);
    expect(screen.getByText("4000 × 3000")).toBeInTheDocument();
  });

  it("calls onClick after the double-click window expires", () => {
    render(<PhotoCard {...baseProps} />);
    const card = screen.getByText("test-photo.jpg").closest("[class*='group']");
    expect(card).not.toBeNull();
    if (!card) {
      return;
    }
    fireEvent.click(card);
    expect(baseProps.onClick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(baseProps.onClick).toHaveBeenCalled();
  });

  it("cancels the pending single click when double-clicked", () => {
    render(<PhotoCard {...baseProps} />);
    const card = screen.getByText("test-photo.jpg").closest("[class*='group']");
    expect(card).not.toBeNull();
    if (!card) {
      return;
    }

    fireEvent.click(card, { detail: 1 });
    fireEvent.click(card, { detail: 2 });
    fireEvent.doubleClick(card);
    vi.advanceTimersByTime(250);

    expect(baseProps.onClick).not.toHaveBeenCalled();
    expect(baseProps.onDoubleClick).toHaveBeenCalledTimes(1);
  });

  it("shows selection indicator when selected", () => {
    render(<PhotoCard {...baseProps} isSelected={true} />);
    const svg = document.querySelector("svg[viewBox='0 0 12 12']");
    expect(svg).toBeInTheDocument();
  });

  it("shows the recently viewed marker without selecting the card", () => {
    render(<PhotoCard {...baseProps} recentlyViewed />);

    const marker = screen.getByRole("status");
    expect(marker).toHaveTextContent("刚刚浏览");
    expect(marker).toHaveAttribute("data-recently-viewed", "true");
    expect(screen.getByRole("option")).not.toHaveAttribute(
      "aria-selected",
      "true"
    );
  });

  it("limits the recently viewed highlight to the pulse window", () => {
    render(
      <PhotoCard
        {...baseProps}
        recentlyViewed
        recentlyViewedPulseActive
        recentlyViewedPulseKey={1}
      />
    );

    const card = screen.getByRole("option");
    expect(card).toHaveClass("photo-card-recently-viewed-pulse");

    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(card).not.toHaveClass("photo-card-recently-viewed-pulse");
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("uses thumbnailPath as src when provided", () => {
    render(
      <PhotoCard
        {...baseProps}
        thumbnailPath="C:/AppData/thumbnails/abc123.jpg"
        thumbnailSmallPath="C:/AppData/thumbnails/small123.webp"
      />
    );
    const img = document.querySelector("img");
    expect(img?.alt).toBe("test-photo.jpg");
    expect(img?.src).toContain("local-media://");
    expect(img?.srcset).toContain("256w");
    expect(img?.srcset).toContain("512w");
  });

  it("keeps an inline selection outline inside the card bounds", () => {
    render(
      <PhotoCard {...baseProps} isSelected={true} selectionInset={true} />
    );
    const card = screen.getByText("test-photo.jpg").closest("[data-photo-id]");
    expect(card).toHaveClass("ring-inset");
    expect(card).not.toHaveClass("ring-offset-1");
  });

  it("reveals a thumbnail only after its image load event", () => {
    render(
      <PhotoCard
        {...baseProps}
        thumbnailPath="C:/AppData/thumbnails/abc123.jpg"
      />
    );
    const img = screen.getByRole("img", { name: "test-photo.jpg" });
    expect(img).toHaveAttribute("data-load-state", "loading");
    expect(img).toHaveClass("opacity-0");

    fireEvent.load(img);

    expect(img).toHaveAttribute("data-load-state", "loaded");
    expect(img).toHaveClass("opacity-100");
    expect(img).toHaveClass("transition-opacity");
  });

  it("reveals an already cached thumbnail before waiting for another load event", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );

    render(
      <PhotoCard
        {...baseProps}
        thumbnailPath="C:/AppData/thumbnails/abc123.jpg"
      />
    );

    const img = screen.getByRole("img", { name: "test-photo.jpg" });
    expect(img).toHaveAttribute("data-load-state", "loaded");
    expect(img).toHaveClass("opacity-100");
    expect(img).toHaveClass("transition-none");
    expect(img).not.toHaveClass("transition-opacity");
    fireEvent.load(img);
    expect(img).toHaveClass("transition-none");
  });

  it("reveals a cached thumbnail when its virtualized image is mounted again", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    const props = {
      ...baseProps,
      thumbnailPath: "C:/AppData/thumbnails/abc123.jpg",
    };
    const { rerender } = render(<PhotoCard {...props} renderImage={false} />);

    rerender(<PhotoCard {...props} renderImage />);

    const img = screen.getByRole("img", { name: "test-photo.jpg" });
    expect(img).toHaveAttribute("data-load-state", "loaded");
    expect(img).toHaveClass("opacity-100");
    expect(img).toHaveClass("transition-none");
  });

  it("waits for a cold thumbnail after its previously loaded image is remounted", () => {
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    const props = {
      ...baseProps,
      thumbnailPath: "C:/AppData/thumbnails/abc123.jpg",
    };
    const { rerender } = render(<PhotoCard {...props} />);
    expect(screen.getByRole("img", { name: "test-photo.jpg" })).toHaveClass(
      "transition-none"
    );

    complete.mockReturnValue(false);
    rerender(<PhotoCard {...props} renderImage={false} />);
    rerender(<PhotoCard {...props} renderImage />);

    const img = screen.getByRole("img", { name: "test-photo.jpg" });
    expect(img).toHaveAttribute("data-load-state", "loading");
    expect(img).toHaveClass("opacity-0");
    fireEvent.load(img);
    expect(img).toHaveClass("opacity-100");
    expect(img).toHaveClass("transition-opacity");
  });

  it("resets the reveal when a responsive thumbnail source changes", () => {
    const complete = vi
      .spyOn(HTMLImageElement.prototype, "complete", "get")
      .mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      512
    );
    const props = {
      ...baseProps,
      thumbnailPath: "C:/AppData/thumbnails/abc123.jpg",
      thumbnailSmallPath: "C:/AppData/thumbnails/small123.webp",
    };
    const { rerender } = render(<PhotoCard {...props} />);
    const img = screen.getByRole("img", { name: "test-photo.jpg" });
    expect(img).toHaveClass("transition-none");

    complete.mockReturnValue(false);
    rerender(
      <PhotoCard
        {...props}
        thumbnailSmallPath="C:/AppData/thumbnails/small456.webp"
      />
    );

    expect(img).toHaveAttribute("data-load-state", "loading");
    expect(img).toHaveClass("opacity-0");
    fireEvent.load(img);
    expect(img).toHaveClass("opacity-100");
    expect(img).toHaveClass("transition-opacity");
  });

  it("waits for the replacement thumbnail when its URL changes", () => {
    const { rerender } = render(
      <PhotoCard
        {...baseProps}
        thumbnailPath="C:/AppData/thumbnails/abc123.jpg"
      />
    );
    fireEvent.load(screen.getByRole("img", { name: "test-photo.jpg" }));

    rerender(
      <PhotoCard
        {...baseProps}
        thumbnailPath="C:/AppData/thumbnails/abc456.jpg"
      />
    );

    const img = screen.getByRole("img", { name: "test-photo.jpg" });
    expect(img).toHaveAttribute("data-load-state", "loading");
    expect(img).toHaveClass("opacity-0");
    fireEvent.load(img);
    expect(img).toHaveClass("opacity-100");
  });

  it("does not reveal a completed image whose thumbnail failed to decode", () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(
      true
    );
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(
      0
    );

    render(
      <PhotoCard
        {...baseProps}
        thumbnailPath="C:/AppData/thumbnails/abc123.jpg"
      />
    );

    const img = screen.getByRole("img", { name: "test-photo.jpg" });
    expect(img).toHaveAttribute("data-load-state", "loading");
    expect(img).toHaveClass("opacity-0");
  });

  it("does not render image element when renderImage is false", () => {
    render(
      <PhotoCard
        {...baseProps}
        renderImage={false}
        thumbnailPath="C:/AppData/thumbnails/abc123.jpg"
      />
    );
    const img = document.querySelector("img");
    expect(img).not.toBeInTheDocument();
  });

  it("highlights search query in text", () => {
    render(<PhotoCard {...baseProps} searchQuery="photo" />);
    const mark = document.querySelector("mark");
    expect(mark).toBeInTheDocument();
    expect(mark?.textContent).toBe("photo");
  });

  it("labels a color result with color closeness instead of generic confidence", () => {
    render(<PhotoCard {...baseProps} match={{ kind: "color", score: 0.5 }} />);
    expect(screen.getByText("色彩接近度 50%")).toBeInTheDocument();
  });

  it("labels semantic results without presenting raw cosine as a percentage", () => {
    render(
      <PhotoCard {...baseProps} match={{ kind: "semantic", score: 0.73 }} />
    );
    expect(screen.getByText("语义匹配")).toBeInTheDocument();
  });

  it("labels exact tag matches without a percentage", () => {
    render(
      <PhotoCard {...baseProps} match={{ kind: "exact", source: "tag" }} />
    );
    expect(screen.getByText("标签命中")).toBeInTheDocument();
    expect(screen.queryByText(PERCENTAGE_PATTERN)).not.toBeInTheDocument();
  });

  it("labels an automatic tag source in pure tag-filter results", () => {
    render(
      <PhotoCard {...baseProps} match={{ kind: "tagFilter", origin: "auto" }} />
    );
    expect(screen.getByText("AI 标签")).toBeInTheDocument();
  });

  it("labels semantic results with a percentage normalized to the top match", () => {
    render(
      <PhotoCard
        {...baseProps}
        match={{ kind: "semantic", score: 0.73 }}
        semanticTopSimilarity={0.8}
      />
    );
    expect(screen.getByText("语义匹配 91%")).toBeInTheDocument();
  });

  it("falls back to the plain semantic label when top similarity is absent", () => {
    render(
      <PhotoCard
        {...baseProps}
        match={{ kind: "semantic", score: 0.73 }}
        semanticTopSimilarity={0}
      />
    );
    expect(screen.getByText("语义匹配")).toBeInTheDocument();
  });

  it("labels hybrid semantic results with a normalized percentage when a score is present", () => {
    render(
      <PhotoCard
        {...baseProps}
        match={{
          kind: "hybrid",
          evidence: ["semantic", "tag"],
          tagNames: ["海边"],
          score: 0.6,
        }}
        semanticTopSimilarity={0.8}
      />
    );
    expect(screen.getByText("语义匹配 75%")).toBeInTheDocument();
  });

  it("keeps the plain hybrid label when a hybrid result has no semantic score", () => {
    render(
      <PhotoCard
        {...baseProps}
        match={{ kind: "hybrid", evidence: ["tag"], tagNames: ["海边"] }}
        semanticTopSimilarity={0.8}
      />
    );
    expect(screen.getByText("标签命中")).toBeInTheDocument();
  });
});
