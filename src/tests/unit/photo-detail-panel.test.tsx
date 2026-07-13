import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getPhotoExif: vi.fn(() => new Promise(() => undefined)),
        getPhotoTags: vi.fn(() => new Promise(() => undefined)),
        getTags: vi.fn(() => new Promise(() => undefined)),
      },
    },
  },
}));

const basePhoto = {
  fileSize: 1024,
  filename: "first.jpg",
  height: 3000,
  id: 1,
  path: "C:/Photos/first.jpg",
  thumbnailPath: "C:/Thumbs/first.webp",
  width: 4000,
};

describe("PhotoDetailPanel preview", () => {
  it("keeps a stable preview frame and uses the cached thumbnail", () => {
    const { container } = render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );

    const image = container.querySelector("img[alt='first.jpg']");
    expect(image?.parentElement).toHaveClass("h-[200px]");
    expect(image?.getAttribute("src")).toContain("first.webp");
    expect(image).toHaveClass("opacity-0");

    if (image) {
      fireEvent.load(image);
    }
    expect(image).toHaveClass("opacity-100");
  });

  it("does not reuse the previous preview while the next image loads", () => {
    const { container, rerender } = render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );

    rerender(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={{
          ...basePhoto,
          filename: "second.jpg",
          id: 2,
          path: "C:/Photos/second.jpg",
          thumbnailPath: "C:/Thumbs/second.webp",
        }}
      />
    );

    const image = container.querySelector("img[alt='second.jpg']");
    expect(container.querySelector("img[alt='first.jpg']")).toBeNull();
    expect(image?.getAttribute("src")).toContain("second.webp");
    expect(image).toHaveClass("opacity-0");
  });
});
