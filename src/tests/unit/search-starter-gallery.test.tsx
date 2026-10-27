import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SearchStarterGallery } from "@/features/search-bar/SearchStarterGallery";
import { useGalleryThumbnail } from "@/hooks/useGalleryThumbnail";

vi.mock("@/hooks/useGalleryThumbnail", () => ({
  useGalleryThumbnail: vi.fn(),
}));
const observers: IntersectionObserverCallback[] = [];
beforeEach(() => {
  observers.length = 0;
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: IntersectionObserverCallback) {
        observers.push(callback);
      }
      observe() {
        /* visibility is controlled by the test */
      }
      disconnect() {
        /* no native observer exists in this fixture */
      }
    }
  );
  vi.mocked(useGalleryThumbnail)
    .mockReset()
    .mockImplementation(({ id }) => ({
      ref: { current: null },
      url: `/managed-thumbnail/${id}`,
      failed: false,
      onDisplayed: vi.fn(),
    }));
});
afterEach(() => vi.unstubAllGlobals());

function showCover(index = 0) {
  act(() =>
    observers[index](
      [{ isIntersecting: true } as IntersectionObserverEntry],
      {} as IntersectionObserver
    )
  );
}

const example = {
  kind: "tag" as const,
  type: "example" as const,
  key: "tag:1",
  text: "海滩",
  query: '"海滩"',
  source: "library" as const,
  previewPhotoIds: [1, 2, 3],
};
function gallery(onSelect = vi.fn()) {
  return render(
    <SearchStarterGallery
      examples={[example]}
      loading={false}
      onHighlight={vi.fn()}
      onSelect={onSelect}
      status="ready"
      suggestionIndex={-1}
    />
  );
}

describe("search discovery photo cards", () => {
  it("requests managed thumbnails only after a cover becomes visible", () => {
    gallery();
    expect(useGalleryThumbnail).not.toHaveBeenCalled();
    expect(screen.getByText("按标签探索")).toBeInTheDocument();
    showCover();
    expect(useGalleryThumbnail).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, enabled: true })
    );
    const image = document.querySelector("img");
    expect(image).toHaveAttribute("src", "/managed-thumbnail/1");
    expect(image).toHaveAttribute("alt", "");
  });

  it("tries verified alternate photos and keeps the whole card actionable when every image fails", () => {
    const select = vi.fn();
    gallery(select);
    showCover();
    for (const id of [1, 2, 3]) {
      const image = document.querySelector("img");
      expect(image).toHaveAttribute("src", `/managed-thumbnail/${id}`);
      fireEvent.error(image as HTMLImageElement);
    }
    expect(document.querySelector("img")).toBeNull();
    const button = screen.getByRole("option", { name: "海滩" });
    fireEvent.click(button);
    expect(select).toHaveBeenCalledWith(example);
    expect(button).toHaveTextContent("海滩");
    expect(button).not.toHaveAttribute("title");
  });

  it("handles failures reported by the shared loading queue without waiting for an img event", () => {
    vi.mocked(useGalleryThumbnail).mockImplementation(({ id }) => ({
      ref: { current: null },
      url: id === 1 ? "" : `/managed-thumbnail/${id}`,
      failed: id === 1,
      onDisplayed: vi.fn(),
    }));
    gallery();
    showCover();
    expect(document.querySelector("img")).toHaveAttribute(
      "src",
      "/managed-thumbnail/2"
    );
  });
});
