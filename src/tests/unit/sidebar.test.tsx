import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";

const PHOTOS_TITLE_PATTERN = /Photos/;
const TRAVEL_TITLE_PATTERN = /Travel/;
const { updateFolderAppearanceMock, useAiStatusMock } = vi.hoisted(() => ({
  updateFolderAppearanceMock: vi.fn(),
  useAiStatusMock: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      app: {
        getUpdateStatus: vi.fn().mockResolvedValue({ phase: "idle" }),
      },
      photos: {
        getTags: vi.fn(() => new Promise(() => undefined)),
        updateFolderAppearance: updateFolderAppearanceMock,
      },
      settings: {
        getAppPreferences: vi.fn().mockResolvedValue({
          updateReminder: false,
        }),
      },
    },
  },
}));

// Mock react-router navigation
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: "/" }),
}));

// Mock AiProgressBar
vi.mock("@/components/AiProgressBar", () => ({
  AiProgressBar: () => null,
}));

vi.mock("@/hooks/useAiStatus", () => ({
  useAiStatus: useAiStatusMock,
}));

describe("Sidebar", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    useAiStatusMock.mockReturnValue({
      data: {
        coverageState: "ready",
        embeddingProgress: { phase: "complete", processed: 10, total: 10 },
        isEmbedding: false,
        pendingPhotos: 0,
      },
    });
  });
  const baseProps = {
    activeFolderId: null as number | null,
    activeTagIds: [] as number[],
    tagMode: "or" as "and" | "or",
    collapsed: false,
    folders: [] as Array<{
      id: number;
      parentId: number | null;
      path: string;
      displayName: string;
      photoCount: number;
    }>,
    onAddFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onSelectAllPhotos: vi.fn(),
    onSelectFolder: vi.fn(),
    onToggleCollapse: vi.fn(),
    totalPhotos: 1250,
  };

  it("uses the app name as the primary navigation label", () => {
    render(<Sidebar {...baseProps} />);
    expect(
      screen.getByRole("navigation", { name: "AI 图片管理器" })
    ).toBeInTheDocument();
  });

  it("does not repeat the total photo count in the resource panel", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.queryByText("1,250 张照片")).not.toBeInTheDocument();
  });

  it("shows Add Folder button", () => {
    render(<Sidebar {...baseProps} />);
    expect(
      screen.getByRole("button", { name: "添加文件夹" })
    ).toBeInTheDocument();
  });

  it("shows all photos button", () => {
    render(<Sidebar {...baseProps} />);
    expect(
      screen.getAllByRole("button", { name: "全部照片" }).length
    ).toBeGreaterThan(0);
  });

  it("uses one atomic action when all photos is selected", () => {
    const onSelectAllPhotos = vi.fn();
    render(<Sidebar {...baseProps} onSelectAllPhotos={onSelectAllPhotos} />);

    fireEvent.click(screen.getAllByRole("button", { name: "全部照片" })[0]);

    expect(onSelectAllPhotos).toHaveBeenCalledTimes(1);
    expect(baseProps.onSelectFolder).not.toHaveBeenCalled();
  });

  it("renders folder list", () => {
    const folderProps = {
      ...baseProps,
      folders: [
        {
          id: 1,
          parentId: null,
          path: "C:/Photos",
          displayName: "Photos",
          photoCount: 500,
        },
        {
          id: 2,
          parentId: null,
          path: "C:/Travel",
          displayName: "Travel",
          photoCount: 200,
        },
      ],
    };
    render(<Sidebar {...folderProps} />);
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText("Travel")).toBeInTheDocument();
    expect(
      screen.getByText("Photos").closest("button")?.querySelector("svg")
    ).toBeNull();
  });

  it("filters folders by display name", () => {
    render(
      <Sidebar
        {...baseProps}
        folders={[
          {
            id: 1,
            parentId: null,
            path: "C:/Photos",
            displayName: "Photos",
            photoCount: 500,
          },
          {
            id: 2,
            parentId: null,
            path: "C:/Travel",
            displayName: "Travel",
            photoCount: 200,
          },
        ]}
      />
    );

    fireEvent.change(
      screen.getByRole("searchbox", { name: "folderSearchPlaceholder" }),
      {
        target: { value: "travel" },
      }
    );

    expect(screen.queryByText("Photos")).not.toBeInTheDocument();
    expect(screen.getByText("Travel")).toBeInTheDocument();
  });

  it("expands a nested folder tree on initial load", async () => {
    render(
      <Sidebar
        {...baseProps}
        folders={[
          {
            id: 1,
            parentId: null,
            path: "C:/Photos",
            displayName: "Photos",
            photoCount: 0,
          },
          {
            id: 2,
            parentId: 1,
            path: "C:/Photos/Travel",
            displayName: "Travel",
            photoCount: 200,
          },
        ]}
      />
    );

    expect(await screen.findByText("Travel")).toBeInTheDocument();
  });

  it("keeps the primary navigation rail when resources are collapsed", () => {
    render(
      <Sidebar
        {...baseProps}
        collapsed
        folders={[
          {
            id: 1,
            parentId: null,
            path: "C:/Photos",
            displayName: "Photos",
            photoCount: 500,
          },
        ]}
      />
    );

    expect(
      screen.getByRole("button", { name: "全部照片" })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: PHOTOS_TITLE_PATTERN })
    ).not.toBeInTheDocument();
  });

  it("opens folder shortcuts from the collapsed navigation rail", () => {
    render(<Sidebar {...baseProps} collapsed />);

    fireEvent.click(screen.getByRole("button", { name: "文件夹快捷入口" }));

    expect(
      screen.getByText("暂无快捷文件夹。展开侧边栏后，可右键文件夹将其置顶。")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "查看全部文件夹" })
    ).toBeInTheDocument();
  });

  it("shows current, pinned, and recent folders without duplicates", () => {
    localStorage.setItem("sidebar-pinned-folder-ids", JSON.stringify([1, 2]));
    localStorage.setItem("sidebar-recent-folder-ids", JSON.stringify([2, 3]));
    render(
      <Sidebar
        {...baseProps}
        activeFolderId={1}
        collapsed
        folders={[
          {
            displayName: "Current",
            id: 1,
            parentId: null,
            path: "C:/Current",
            photoCount: 10,
          },
          {
            displayName: "Pinned",
            id: 2,
            parentId: null,
            path: "C:/Pinned",
            photoCount: 20,
          },
          {
            displayName: "Recent",
            id: 3,
            parentId: null,
            path: "C:/Recent",
            photoCount: 30,
          },
        ]}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "文件夹快捷入口" }));

    expect(
      screen.getByRole("region", { name: "当前文件夹" })
    ).toHaveTextContent("Current");
    expect(
      screen.getByRole("region", { name: "置顶文件夹" })
    ).toHaveTextContent("Pinned");
    expect(screen.getByRole("region", { name: "最近访问" })).toHaveTextContent(
      "Recent"
    );
    expect(screen.getAllByText("Current")).toHaveLength(1);
    expect(screen.getAllByText("Pinned")).toHaveLength(1);
    expect(screen.getAllByText("Recent")).toHaveLength(1);
  });

  it("selects a shortcut, closes the popover, and records recent folders", async () => {
    const onSelectFolder = vi.fn();
    const folders = [
      {
        displayName: "Photos",
        id: 1,
        parentId: null,
        path: "C:/Photos",
        photoCount: 500,
      },
      {
        displayName: "Travel",
        id: 2,
        parentId: null,
        path: "C:/Travel",
        photoCount: 200,
      },
    ];
    localStorage.setItem("sidebar-pinned-folder-ids", JSON.stringify([1]));
    const { rerender } = render(
      <Sidebar
        {...baseProps}
        activeFolderId={2}
        collapsed
        folders={folders}
        onSelectFolder={onSelectFolder}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "文件夹快捷入口" }));
    fireEvent.click(screen.getByRole("button", { name: "Photos (500)" }));

    expect(onSelectFolder).toHaveBeenCalledWith(1);
    await waitFor(() =>
      expect(screen.queryByText("当前文件夹")).not.toBeInTheDocument()
    );

    rerender(
      <Sidebar
        {...baseProps}
        activeFolderId={1}
        collapsed
        folders={folders}
        onSelectFolder={onSelectFolder}
      />
    );
    await waitFor(() =>
      expect(
        JSON.parse(localStorage.getItem("sidebar-recent-folder-ids") ?? "[]")
      ).toEqual([1, 2])
    );
  });

  it("pins and unpins a folder from its context menu", () => {
    render(
      <Sidebar
        {...baseProps}
        folders={[
          {
            displayName: "Photos",
            id: 1,
            parentId: null,
            path: "C:/Photos",
            photoCount: 500,
          },
        ]}
      />
    );

    fireEvent.contextMenu(
      screen.getByText("Photos").closest("button") as Element
    );
    fireEvent.click(screen.getByRole("button", { name: "置顶文件夹" }));
    expect(localStorage.getItem("sidebar-pinned-folder-ids")).toBe("[1]");

    fireEvent.contextMenu(
      screen.getByText("Photos").closest("button") as Element
    );
    fireEvent.click(screen.getByRole("button", { name: "取消置顶" }));
    expect(localStorage.getItem("sidebar-pinned-folder-ids")).toBe("[]");
  });

  it("does not replace pinned folders when the five-folder limit is reached", () => {
    localStorage.setItem(
      "sidebar-pinned-folder-ids",
      JSON.stringify([1, 2, 3, 4, 5])
    );
    const folders = Array.from({ length: 6 }, (_, index) => ({
      displayName: `Folder ${index + 1}`,
      id: index + 1,
      parentId: null,
      path: `C:/Folder-${index + 1}`,
      photoCount: index + 1,
    }));
    render(<Sidebar {...baseProps} folders={folders} />);

    fireEvent.contextMenu(
      screen.getByText("Folder 6").closest("button") as Element
    );
    fireEvent.click(screen.getByRole("button", { name: "置顶文件夹" }));

    expect(localStorage.getItem("sidebar-pinned-folder-ids")).toBe(
      "[1,2,3,4,5]"
    );
  });

  it("removes folder shortcut ids that no longer exist", async () => {
    localStorage.setItem("sidebar-pinned-folder-ids", JSON.stringify([1, 999]));
    localStorage.setItem("sidebar-recent-folder-ids", JSON.stringify([999, 1]));
    render(
      <Sidebar
        {...baseProps}
        folders={[
          {
            displayName: "Photos",
            id: 1,
            parentId: null,
            path: "C:/Photos",
            photoCount: 500,
          },
        ]}
      />
    );

    await waitFor(() => {
      expect(localStorage.getItem("sidebar-pinned-folder-ids")).toBe("[1]");
      expect(localStorage.getItem("sidebar-recent-folder-ids")).toBe("[1]");
    });
  });

  it("expands to all folders and focuses folder search", async () => {
    const onToggleCollapse = vi.fn();
    const { rerender } = render(
      <Sidebar {...baseProps} collapsed onToggleCollapse={onToggleCollapse} />
    );

    fireEvent.click(screen.getByRole("button", { name: "文件夹快捷入口" }));
    fireEvent.click(screen.getByRole("button", { name: "查看全部文件夹" }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);

    rerender(
      <Sidebar
        {...baseProps}
        collapsed={false}
        onToggleCollapse={onToggleCollapse}
      />
    );
    await waitFor(() =>
      expect(
        screen.getByRole("searchbox", { name: "folderSearchPlaceholder" })
      ).toHaveFocus()
    );
  });

  it("renders a custom folder icon in the resource panel", () => {
    const folder = {
      appearanceColor: "#DC2626",
      appearanceIcon: "camera" as const,
      displayName: "Photos",
      id: 1,
      parentId: null,
      path: "C:/Photos",
      photoCount: 500,
    };
    render(<Sidebar {...baseProps} folders={[folder]} />);
    expect(
      screen.getByText("Photos").closest("button")?.querySelector("svg")
    ).not.toBeNull();
  });

  it("saves a customized folder appearance from the context menu", async () => {
    updateFolderAppearanceMock.mockResolvedValue({
      appearanceColor: "#5E6AD2",
      appearanceIcon: "folder",
      id: 1,
    });
    render(
      <Sidebar
        {...baseProps}
        folders={[
          {
            displayName: "Photos",
            id: 1,
            parentId: null,
            path: "C:/Photos",
            photoCount: 500,
          },
        ]}
      />
    );

    fireEvent.contextMenu(
      screen.getByText("Photos").closest("button") as Element
    );
    fireEvent.click(screen.getByText("自定义外观"));
    fireEvent.click(screen.getByLabelText("使用 folder 图标"));
    fireEvent.click(screen.getByLabelText("#5E6AD2"));
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(updateFolderAppearanceMock).toHaveBeenCalledWith({
        color: "#5E6AD2",
        icon: "folder",
        id: 1,
      })
    );
  });

  it("resets a customized folder appearance to automatic values", async () => {
    updateFolderAppearanceMock.mockResolvedValue({
      appearanceColor: null,
      appearanceIcon: null,
      id: 1,
    });
    render(
      <Sidebar
        {...baseProps}
        folders={[
          {
            appearanceColor: "#DC2626",
            appearanceIcon: "camera",
            displayName: "Photos",
            id: 1,
            parentId: null,
            path: "C:/Photos",
            photoCount: 500,
          },
        ]}
      />
    );

    fireEvent.contextMenu(
      screen.getByText("Photos").closest("button") as Element
    );
    fireEvent.click(screen.getByText("自定义外观"));
    fireEvent.click(screen.getByText("恢复自动样式"));
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() =>
      expect(updateFolderAppearanceMock).toHaveBeenCalledWith({
        color: null,
        icon: null,
        id: 1,
      })
    );
  });

  it("hides folder resources in the collapsed sidebar", () => {
    render(
      <Sidebar
        {...baseProps}
        collapsed
        folders={[
          {
            id: 1,
            parentId: null,
            path: "C:/Photos",
            displayName: "Photos",
            photoCount: 0,
          },
          {
            id: 2,
            parentId: 1,
            path: "C:/Photos/Travel",
            displayName: "Travel",
            photoCount: 200,
          },
        ]}
      />
    );

    expect(
      screen.queryByRole("button", { name: PHOTOS_TITLE_PATTERN })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: TRAVEL_TITLE_PATTERN })
    ).not.toBeInTheDocument();
  });

  it("supports keyboard navigation and selection in the folder tree", async () => {
    const onSelectFolder = vi.fn();
    render(
      <Sidebar
        {...baseProps}
        folders={[
          {
            id: 1,
            parentId: null,
            path: "C:/Alpha",
            displayName: "Alpha",
            photoCount: 10,
          },
          {
            id: 2,
            parentId: null,
            path: "C:/Beta",
            displayName: "Beta",
            photoCount: 20,
          },
        ]}
        onSelectFolder={onSelectFolder}
      />
    );
    const items = screen.getAllByRole("treeitem");
    items[0].focus();
    fireEvent.keyDown(items[0], { key: "ArrowDown" });

    await waitFor(() => expect(items[1]).toHaveFocus());
    fireEvent.keyDown(items[1], { key: "Enter" });
    expect(onSelectFolder).toHaveBeenCalledWith(2);
  });

  it("highlights active folder", () => {
    const activeProps = {
      ...baseProps,
      activeFolderId: 1,
      folders: [
        {
          id: 1,
          parentId: null,
          path: "C:/Photos",
          displayName: "Photos",
          photoCount: 500,
        },
      ],
    };
    render(<Sidebar {...activeProps} />);
    const folderBtn = screen.getByText("Photos").closest("button");
    expect(folderBtn).not.toBeNull();
    expect(folderBtn?.className).toContain("bg-primary/15");
  });

  it("shows empty folder message when no folders", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByText("尚未添加文件夹")).toBeInTheDocument();
  });

  it("has dashboard and settings links", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByRole("button", { name: "仪表盘" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toBeInTheDocument();
  });

  it("shows automatic tag status instead of a batch action while AI is pending", () => {
    useAiStatusMock.mockReturnValue({
      data: {
        coverageState: "unavailable",
        embeddingProgress: { phase: "embedding", processed: 2, total: 10 },
        isEmbedding: true,
        pendingPhotos: 8,
      },
    });
    render(<Sidebar {...baseProps} />);
    fireEvent.click(screen.getByRole("button", { name: "标签" }));

    expect(screen.getByText("AI 索引完成后将自动生成标签")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "批量生成 AI 标签" })
    ).not.toBeInTheDocument();
  });
});
