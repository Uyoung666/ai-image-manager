import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "@/components/SearchBar";

const SEARCH_HISTORY_KEY = "search_history";

describe("SearchBar", () => {
  const baseProps = {
    onClear: vi.fn(),
    onSearch: vi.fn(),
  };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("renders the simplified search placeholder", () => {
    render(<SearchBar {...baseProps} />);

    expect(
      screen.getByPlaceholderText("试试搜索“去年秋天的红叶”")
    ).toBeInTheDocument();
  });

  it("shows starter examples when an empty search input is focused", async () => {
    const user = userEvent.setup();
    render(<SearchBar {...baseProps} />);

    expect(
      screen.queryByRole("button", { name: "today" })
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("combobox"));

    expect(screen.getByRole("button", { name: "today" })).toBeInTheDocument();
    expect(screen.getByText("试试这样搜索")).toBeInTheDocument();
    expect(screen.getByText("去年秋天的红叶")).toBeInTheDocument();
    expect(screen.getByText("海边的日落")).toBeInTheDocument();
    expect(screen.queryByText("最近搜索")).not.toBeInTheDocument();
  });

  it("runs an example search and stores it in recent history", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<SearchBar {...baseProps} onSearch={onSearch} />);

    await user.click(screen.getByRole("combobox"));
    await user.click(screen.getByRole("option", { name: "海边的日落" }));

    expect(onSearch).toHaveBeenCalledWith("海边的日落", undefined);
    expect(
      JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || "[]")
    ).toContain("海边的日落");
    expect(screen.queryByText("试试这样搜索")).not.toBeInTheDocument();
  });

  it("shows recent history below examples and clearing it keeps examples open", async () => {
    localStorage.setItem(
      SEARCH_HISTORY_KEY,
      JSON.stringify(["海边旅行", "夜景"])
    );
    const user = userEvent.setup();
    render(<SearchBar {...baseProps} />);

    await user.click(screen.getByRole("combobox"));

    expect(screen.getByText("最近搜索")).toBeInTheDocument();
    expect(screen.getByText("海边旅行")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除全部" }));

    expect(screen.queryByText("最近搜索")).not.toBeInTheDocument();
    expect(screen.getByText("试试这样搜索")).toBeInTheDocument();
    expect(screen.getByText("去年秋天的红叶")).toBeInTheDocument();
  });

  it("switches from starter content to matching suggestions while typing", async () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["海边旅行"]));
    const user = userEvent.setup();
    render(<SearchBar {...baseProps} />);
    const input = screen.getByRole("combobox");

    await user.click(input);
    await user.type(input, "海边旅");

    expect(screen.queryByText("试试这样搜索")).not.toBeInTheDocument();
    expect(screen.getByText("搜索建议")).toBeInTheDocument();
    expect(screen.getByText("海边旅行")).toBeInTheDocument();

    await user.clear(input);
    expect(screen.getByText("试试这样搜索")).toBeInTheDocument();
  });

  it("supports keyboard selection for starter examples", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<SearchBar {...baseProps} onSearch={onSearch} />);

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onSearch).toHaveBeenCalledWith("去年秋天的红叶", undefined);
  });

  it("closes suggestions with Escape without clearing typed text", async () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["海边旅行"]));
    const user = userEvent.setup();
    render(<SearchBar {...baseProps} />);
    const input = screen.getByRole("combobox");

    await user.click(input);
    await user.type(input, "海边");
    await user.keyboard("{Escape}");

    expect(input).toHaveValue("海边");
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("disables semantic examples while AI indexing is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <SearchBar
        {...baseProps}
        aiStatus={{
          model: "ready",
          vectorDB: "ready",
          hasVectors: false,
          vectorCount: 0,
          indexReady: false,
          isEmbedding: false,
          embeddingProgress: { processed: 0, total: 0, phase: "idle" },
        }}
      />
    );

    await user.click(screen.getByRole("combobox"));

    expect(
      screen.getByText("请先完成 AI 索引，再使用语义搜索示例")
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "去年秋天的红叶" })
    ).toBeDisabled();
  });

  it("shows indexed coverage while semantic indexing is partial", () => {
    render(
      <SearchBar
        {...baseProps}
        aiStatus={{
          coverageState: "partial",
          model: "ready",
          vectorDB: "ready",
          hasVectors: true,
          vectorCount: 25,
          indexReady: true,
          indexedPhotos: 25,
          totalPhotos: 100,
          isEmbedding: true,
          embeddingProgress: { processed: 25, total: 100, phase: "embedding" },
        }}
      />
    );

    expect(
      screen.getByRole("status", {
        name: "AI 已索引 25/100 张照片，当前结果可能不完整；索引完成后将自动刷新。",
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox")).not.toBeDisabled();
  });

  it("does not open the text starter panel in image search mode", async () => {
    const user = userEvent.setup();
    render(<SearchBar {...baseProps} imageSearchActive />);

    await user.click(screen.getByRole("combobox"));

    expect(screen.queryByText("试试这样搜索")).not.toBeInTheDocument();
  });

  it("shows a labeled image search action and opens the file input", async () => {
    const user = userEvent.setup();
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(<SearchBar {...baseProps} onImageSearch={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "以图搜图" }));

    expect(inputClick).toHaveBeenCalledOnce();
    inputClick.mockRestore();
  });

  it("calls onSearch when the form is submitted", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<SearchBar {...baseProps} onSearch={onSearch} />);
    const input = screen.getByRole("combobox");

    await user.type(input, "test query");
    const form = input.closest("form");
    expect(form).not.toBeNull();
    if (!form) {
      return;
    }
    fireEvent.submit(form);

    expect(onSearch).toHaveBeenCalledWith("test query", undefined);
  });

  it("does not search an empty query", () => {
    const onSearch = vi.fn();
    render(<SearchBar {...baseProps} onSearch={onSearch} />);

    const form = screen.getByRole("combobox").closest("form");
    expect(form).not.toBeNull();
    if (!form) {
      return;
    }
    fireEvent.submit(form);

    expect(onSearch).not.toHaveBeenCalled();
  });

  it("calls onClear when the query clear button is clicked", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(<SearchBar {...baseProps} onClear={onClear} />);
    const input = screen.getByRole("combobox");

    await user.type(input, "x");
    await user.click(screen.getByRole("button", { name: "" }));

    expect(onClear).toHaveBeenCalled();
  });
});
