import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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

  it("calls onClick when clicked", () => {
    render(<PhotoCard {...baseProps} />);
    const card = screen.getByText("test-photo.jpg").closest("[class*='group']");
    expect(card).not.toBeNull();
    if (!card) {
      return;
    }
    fireEvent.click(card);
    expect(baseProps.onClick).toHaveBeenCalled();
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
});
