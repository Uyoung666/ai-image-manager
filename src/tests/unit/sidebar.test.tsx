import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";

const PHOTOS_TITLE_PATTERN = /Photos/;
const { updateFolderAppearanceMock, useAiStatusMock } = vi.hoisted(() => ({
  updateFolderAppearanceMock: vi.fn(),
  useAiStatusMock: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        getTags: vi.fn(() => new Promise(() => undefined)),
        updateFolderAppearance: updateFolderAppearanceMock,
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

  it("shows total photo count", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByText("1,250 张照片")).toBeInTheDocument();
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
      screen.queryByRole("button", { name: /Travel/ })
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
