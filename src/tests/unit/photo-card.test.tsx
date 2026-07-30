import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoCard } from "@/components/PhotoCard";

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
  });

  it("does not render image element without thumbnailPath", () => {
    const { container } = render(<PhotoCard {...baseProps} />);
    const img = container.querySelector("img");
    expect(img).not.toBeInTheDocument();
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

  it("uses thumbnailPath as src when provided", () => {
    render(
      <PhotoCard
        {...baseProps}
        thumbnailSmallPath="C:/AppData/thumbnails/small123.webp"
        thumbnailPath="C:/AppData/thumbnails/abc123.jpg"
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
      <PhotoCard
        {...baseProps}
        match={{ kind: "exact", source: "tag" }}
      />
    );
    expect(screen.getByText("标签命中")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("labels an automatic tag source in pure tag-filter results", () => {
    render(
      <PhotoCard
        {...baseProps}
        match={{ kind: "tagFilter", origin: "auto" }}
      />
    );
    expect(screen.getByText("AI 标签")).toBeInTheDocument();
  });
});
