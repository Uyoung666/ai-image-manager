import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "@/components/Sidebar";

// Mock react-router navigation
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}));

// Mock AiProgressBar
vi.mock("@/components/AiProgressBar", () => ({
  AiProgressBar: () => null,
}));

describe("Sidebar", () => {
  const baseProps = {
    activeFolderId: null,
    folders: [],
    onAddFolder: vi.fn(),
    onSelectFolder: vi.fn(),
    scanningFolder: null,
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
    expect(screen.getByText("添加文件夹")).toBeInTheDocument();
  });

  it("shows all photos button", () => {
    render(<Sidebar {...baseProps} />);
    expect(screen.getByText("全部照片")).toBeInTheDocument();
  });

  it("renders folder list", () => {
    const folderProps = {
      ...baseProps,
      folders: [
        { id: 1, path: "C:/Photos", displayName: "Photos", photoCount: 500 },
        { id: 2, path: "C:/Travel", displayName: "Travel", photoCount: 200 },
      ],
    };
    render(<Sidebar {...folderProps} />);
    expect(screen.getByText("Photos")).toBeInTheDocument();
    expect(screen.getByText("Travel")).toBeInTheDocument();
  });

  it("highlights active folder", () => {
    const activeProps = {
      ...baseProps,
      activeFolderId: 1,
      folders: [
        { id: 1, path: "C:/Photos", displayName: "Photos", photoCount: 500 },
      ],
    };
    render(<Sidebar {...activeProps} />);
    const folderBtn = screen.getByText("Photos").closest("button");
    expect(folderBtn).not.toBeNull();
    expect(folderBtn?.className).toContain("#5e6ad2");
  });

  it("shows scan progress when provided", () => {
    render(
      <Sidebar
        {...baseProps}
        scanProgress="扫描完成，共索引 100 张照片"
      />
    );
    expect(
      screen.getByText("扫描完成，共索引 100 张照片")
    ).toBeInTheDocument();
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
