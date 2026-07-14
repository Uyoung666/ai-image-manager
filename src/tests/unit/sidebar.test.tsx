import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";

const PHOTOS_TITLE_PATTERN = /Photos/;
const { updateFolderAppearanceMock } = vi.hoisted(() => ({
  updateFolderAppearanceMock: vi.fn(),
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

describe("Sidebar", () => {
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
    importPhase: "idle" as "idle" | "scanning" | "embedding",
    onAddFolder: vi.fn(),
    onDeleteFolder: vi.fn(),
    onSelectFolder: vi.fn(),
    onToggleCollapse: vi.fn(),
    scanningFolder: null as string | null,
    scanProgress: "",
    totalPhotos: 1250,
  };

  it("renders app name", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByText("AI 图片管理器")).toBeInTheDocument();
  });

  it("shows total photo count", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByText("1,250 张照片")).toBeInTheDocument();
  });

  it("shows Add Folder button", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByRole("button", { name: "添加文件夹" })).toBeInTheDocument();
  });

  it("shows all photos button", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByText("全部照片")).toBeInTheDocument();
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

  it("keeps folder badges in the collapsed sidebar", () => {
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
      screen
        .getByRole("button", { name: PHOTOS_TITLE_PATTERN })
        .querySelector('[data-folder-badge="true"]')
    ).not.toBeNull();
  });

  it("renders a custom folder icon in both sidebar modes", () => {
    const folder = {
      appearanceColor: "#DC2626",
      appearanceIcon: "camera" as const,
      displayName: "Photos",
      id: 1,
      parentId: null,
      path: "C:/Photos",
      photoCount: 500,
    };
    const { rerender } = render(
      <Sidebar {...baseProps} collapsed folders={[folder]} />
    );
    expect(
      screen.getByRole("button", { name: PHOTOS_TITLE_PATTERN }).querySelector("svg")
    ).not.toBeNull();

    rerender(<Sidebar {...baseProps} folders={[folder]} />);
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

  it("shows only root folders in the collapsed sidebar", () => {
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
      screen.getByRole("button", { name: PHOTOS_TITLE_PATTERN })
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Travel/ })).not.toBeInTheDocument();
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

  it("shows scan progress when provided", () => {
    render(
      <Sidebar {...baseProps} scanProgress="扫描完成，共索引 100 张照片" />
    );
    expect(screen.getByText("扫描完成，共索引 100 张照片")).toBeInTheDocument();
  });

  it("shows empty folder message when no folders", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByText("尚未添加文件夹")).toBeInTheDocument();
  });

  it("has dashboard and settings links", () => {
    render(<Sidebar {...baseProps} />);
    const allButtons = screen.getAllByRole("button");
    const buttonTexts = allButtons.map((btn) => btn.textContent);
    expect(buttonTexts.some((t) => t?.includes("仪表盘"))).toBe(true);
    expect(buttonTexts.some((t) => t?.includes("设置"))).toBe(true);
  });
});
