import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";

const {
  getPhotoTagAnalysisStatusMock,
  getPhotoTagsMock,
  getTagsMock,
  suggestTagsMock,
} = vi.hoisted(() => ({
  getPhotoTagAnalysisStatusMock: vi.fn(),
  getPhotoTagsMock: vi.fn(() => new Promise(() => undefined)),
  getTagsMock: vi.fn(() => new Promise(() => undefined)),
  suggestTagsMock: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getPhotoExif: vi.fn(() => new Promise(() => undefined)),
        getPhotoTagAnalysisStatus: getPhotoTagAnalysisStatusMock,
        getPhotoTags: getPhotoTagsMock,
        getTags: getTagsMock,
        suggestTags: suggestTagsMock,
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
  beforeEach(() => {
    getPhotoTagAnalysisStatusMock.mockResolvedValue({ state: "ready" });
    suggestTagsMock.mockReset();
  });
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

  it("shows a return-to-sequence action when provided", () => {
    const onReturnToSequence = vi.fn();
    render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        onReturnToSequence={onReturnToSequence}
        photo={basePhoto}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "returnToSequence" }));

    expect(onReturnToSequence).toHaveBeenCalledOnce();
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

  it("keeps unconfirmed tags readable in the light theme", async () => {
    getPhotoTagsMock.mockResolvedValue([
      {
        color: null,
        confidence: 0.8,
        id: 1,
        isConfirmed: false,
        name: "人物",
      },
    ]);
    getTagsMock.mockResolvedValue([]);

    render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("人物")).toHaveClass(
        "border-foreground/30",
        "bg-foreground/5",
        "text-foreground"
      );
    });
  });

  it("hides manual analysis while the photo is being auto-tagged", async () => {
    getPhotoTagAnalysisStatusMock.mockResolvedValue({ state: "tagging" });
    render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("正在自动分析此照片")).toBeInTheDocument();
    });
    expect(
      screen.queryByRole("button", { name: "分析建议标签" })
    ).not.toBeInTheDocument();
  });

  it("ignores a suggestion response after navigating to another photo", async () => {
    let resolveSuggestion: ((value: unknown) => void) | undefined;
    suggestTagsMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSuggestion = resolve;
        })
    );
    const { rerender } = render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "analyzeSuggestedTags" })
    );
    rerender(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={{ ...basePhoto, id: 2, filename: "second.jpg" }}
      />
    );
    resolveSuggestion?.({ suggestions: [{ confidence: 0.9, tag: "stale" }] });

    await waitFor(() => {
      expect(screen.queryByText("stale")).not.toBeInTheDocument();
    });
  });

  it("ignores a stale tag-analysis status after navigating to another photo", async () => {
    const statusResolvers: Array<(value: unknown) => void> = [];
    getPhotoTagAnalysisStatusMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          statusResolvers.push(resolve);
        })
    );
    const { rerender } = render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );
    await waitFor(() => expect(statusResolvers).toHaveLength(1));

    rerender(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={{ ...basePhoto, id: 2, filename: "second.jpg" }}
      />
    );
    await waitFor(() => expect(statusResolvers).toHaveLength(2));
    statusResolvers[1]?.({ state: "ready" });
    statusResolvers[0]?.({ state: "tagging" });

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "analyzeSuggestedTags" })
      ).toBeInTheDocument();
    });
  });
});
