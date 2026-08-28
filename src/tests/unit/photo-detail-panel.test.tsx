import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";

const ADD_TAG_BUTTON_PATTERN = /添加/;
const ADDED_BEACH_TAG_PATTERN = /海滩.*已添加/;

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
    getPhotoTagAnalysisStatusMock.mockReset();
    getPhotoTagsMock.mockReset();
    getTagsMock.mockReset();
    suggestTagsMock.mockReset();
    getPhotoTagAnalysisStatusMock.mockResolvedValue({ state: "ready" });
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

  it("shows eight detailed tags first and keeps parents under view all", async () => {
    const childNames = [
      "海滩",
      "雾天",
      "手机",
      "婚礼",
      "咖啡",
      "猫咪",
      "日落",
      "街拍",
      "雪景",
    ];
    getPhotoTagsMock.mockResolvedValue([]);
    getTagsMock.mockResolvedValue([
      {
        color: "#5e6ad2",
        id: 1,
        name: "场景",
        parentId: null,
        photoCount: 500,
      },
      ...childNames.map((name, index) => ({
        color: "#5e6ad2",
        id: index + 2,
        name,
        parentId: 1,
        photoCount: 100 - index,
      })),
    ]);

    render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );
    await waitFor(() => expect(getTagsMock).toHaveBeenCalled());
    fireEvent.click(
      screen.getByRole("button", { name: ADD_TAG_BUTTON_PATTERN })
    );

    for (const name of childNames.slice(0, 8)) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: "场景" })).toBeNull();
    expect(screen.queryByRole("button", { name: "雪景" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "查看全部（10）" }));
    expect(screen.getByRole("button", { name: "场景" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "雪景" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "收起" })).toBeInTheDocument();
  });

  it("shows existing tag matches while typing and marks assigned tags", async () => {
    getPhotoTagsMock.mockResolvedValue([
      {
        color: "#5e6ad2",
        confidence: null,
        id: 2,
        isConfirmed: true,
        name: "海滩",
        parentId: 1,
      },
    ]);
    getTagsMock.mockResolvedValue([
      {
        color: "#5e6ad2",
        id: 1,
        name: "场景",
        parentId: null,
        photoCount: 200,
      },
      {
        color: "#5e6ad2",
        id: 2,
        name: "海滩",
        parentId: 1,
        photoCount: 100,
      },
      {
        color: "#5e6ad2",
        id: 3,
        name: "海浪",
        parentId: 1,
        photoCount: 50,
      },
      {
        color: "#5e6ad2",
        id: 4,
        name: "咖啡",
        parentId: null,
        photoCount: 20,
      },
    ]);

    render(
      <PhotoDetailPanel
        onClose={vi.fn()}
        onOpenExplorer={vi.fn()}
        photo={basePhoto}
      />
    );
    await screen.findByText("海滩");
    fireEvent.click(
      screen.getByRole("button", { name: ADD_TAG_BUTTON_PATTERN })
    );
    const input = screen.getByPlaceholderText("输入新标签名称...");

    fireEvent.change(input, { target: { value: "海" } });

    expect(screen.getByText("匹配到 2 个已有标签")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: ADDED_BEACH_TAG_PATTERN })
    ).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("button", { name: "海浪" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "咖啡" })).toBeNull();

    fireEvent.change(input, { target: { value: "火山" } });

    expect(screen.getByText("未找到已有标签")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "海浪" })).toBeNull();
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
