import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchEmptyState } from "@/components/SearchEmptyState";
import { Welcome } from "@/components/Welcome";

const AI_INDEX_TEXT = /AI 智能索引/;

describe("gallery empty states", () => {
  it("keeps the first import state focused on adding a folder", () => {
    const onAddFolder = vi.fn();
    render(<Welcome onAddFolder={onAddFolder} />);

    expect(screen.getByText("添加照片文件夹开始整理")).toBeInTheDocument();
    expect(screen.queryByText(AI_INDEX_TEXT)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加文件夹" }));
    expect(onAddFolder).toHaveBeenCalledOnce();
  });

  it("shows a non-actionable importing state while the first folder is scanned", () => {
    render(<Welcome isImporting={true} onAddFolder={vi.fn()} />);

    expect(screen.getByText("正在导入照片")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "添加文件夹" })).toBeNull();
  });

  it("explains a partial AI index without treating it as unavailable", () => {
    render(
      <SearchEmptyState
        hasActiveFilters={false}
        hasAiVectors={true}
        indexedPhotos={12}
        onClearSearch={vi.fn()}
        onGoToAiSettings={vi.fn()}
        query="海边日落"
        searchMode="text"
        semanticState="partial"
        totalPhotos={24}
      />
    );

    expect(screen.getByText("AI 索引尚未完成（12 / 24）")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "前往 AI 设置" })
    ).toBeInTheDocument();
  });

  it("uses one clear action to preserve a query while clearing filters", () => {
    const onClearFilters = vi.fn();
    render(
      <SearchEmptyState
        hasActiveFilters={true}
        hasAiVectors={true}
        onClearFilters={onClearFilters}
        onClearSearch={vi.fn()}
        query="猫"
        searchMode="text"
        semanticState="ready"
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "仅保留关键字搜索" }));
    expect(onClearFilters).toHaveBeenCalledOnce();
    expect(screen.queryByText("清除所有过滤条件")).toBeNull();
  });

  it("shows retry and browse-all actions for a failed search", () => {
    const onClearSearch = vi.fn();
    const onRetry = vi.fn();
    render(
      <SearchEmptyState
        hasActiveFilters={false}
        hasAiVectors={true}
        onClearSearch={onClearSearch}
        onRetry={onRetry}
        query="海边"
        searchError="search"
        searchMode="text"
      />
    );

    expect(screen.getByText("搜索失败")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    fireEvent.click(screen.getByRole("button", { name: "浏览全部照片" }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onClearSearch).toHaveBeenCalledOnce();
  });

  it("uses the image-search failure label for image errors", () => {
    render(
      <SearchEmptyState
        hasActiveFilters={false}
        hasAiVectors={true}
        onClearSearch={vi.fn()}
        onRetry={vi.fn()}
        query=""
        searchError="image"
        searchMode="image"
      />
    );

    expect(screen.getByText("以图搜图失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "retry" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "浏览全部照片" })
    ).toBeInTheDocument();
  });
});
