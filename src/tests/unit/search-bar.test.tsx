import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "@/components/SearchBar";
import type { ExifFilters } from "@/types/search";

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      faces: { listFaceIdentities: vi.fn().mockResolvedValue([]) },
      photos: {
        getExifCandidates: vi.fn().mockResolvedValue({}),
        getTags: vi
          .fn()
          .mockResolvedValue([{ color: "#4f46e5", id: 42, name: "自行车" }]),
      },
    },
  },
}));

const SEARCH_HISTORY_KEY = "search_history";
const FILTER_COUNT_PATTERN = /· 1/;

type SearchBarProps = ComponentProps<typeof SearchBar>;

function ControlledSearchBar(
  props: Omit<
    Partial<SearchBarProps>,
    "filters" | "onFiltersChange" | "onQueryChange" | "query"
  > & { initialFilters?: ExifFilters; initialQuery?: string }
) {
  const { initialFilters = {}, initialQuery = "", ...searchBarProps } = props;
  const [query, setQuery] = useState(initialQuery);
  const [filters, setFilters] = useState<ExifFilters>(initialFilters);
  return (
    <SearchBar
      filters={filters}
      onClear={vi.fn()}
      onFiltersChange={setFilters}
      onQueryChange={setQuery}
      onSearch={vi.fn()}
      query={query}
      {...searchBarProps}
    />
  );
}

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
    render(<ControlledSearchBar {...baseProps} />);

    expect(
      screen.getByPlaceholderText("试试搜索“去年秋天的红叶”")
    ).toBeInTheDocument();
  });

  it("reflects a controlled query and filter reset without searching", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onSearch = vi.fn();

    function ResetHarness() {
      const [query, setQuery] = useState("sunset");
      const [filters, setFilters] = useState<ExifFilters>({
        cameraModel: "Example Camera",
      });
      return (
        <>
          <button
            onClick={() => {
              setQuery("");
              setFilters({});
            }}
            type="button"
          >
            reset
          </button>
          <SearchBar
            filters={filters}
            onClear={onClear}
            onFiltersChange={setFilters}
            onQueryChange={setQuery}
            onSearch={onSearch}
            query={query}
          />
        </>
      );
    }
    render(<ResetHarness />);

    expect(screen.getByText(FILTER_COUNT_PATTERN)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "reset" }));

    expect(screen.getByRole("combobox")).toHaveValue("");
    expect(screen.queryByText(FILTER_COUNT_PATTERN)).not.toBeInTheDocument();
    expect(onClear).not.toHaveBeenCalled();
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("shows starter examples when an empty search input is focused", async () => {
    const user = userEvent.setup();
    render(<ControlledSearchBar {...baseProps} />);

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
    render(<ControlledSearchBar {...baseProps} onSearch={onSearch} />);

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
    render(<ControlledSearchBar {...baseProps} />);

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
    render(<ControlledSearchBar {...baseProps} />);
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
    render(<ControlledSearchBar {...baseProps} onSearch={onSearch} />);

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onSearch).toHaveBeenCalledWith("去年秋天的红叶", undefined);
  });

  it("closes suggestions with Escape without clearing typed text", async () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["海边旅行"]));
    const user = userEvent.setup();
    render(<ControlledSearchBar {...baseProps} />);
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
      <ControlledSearchBar
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
      <ControlledSearchBar
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
    render(
      <ControlledSearchBar
        {...baseProps}
        imageSearchActive
        imageSearchReference={{
          imagePath: "C:\\photos\\reference.jpg",
          previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
        }}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: "参考图片：reference.jpg，点击更换",
      })
    );

    expect(screen.queryByText("试试这样搜索")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue("[以图搜图]")).not.toBeInTheDocument();
  });

  it("shows the image-search thumbnail and filename with a shared tooltip", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ControlledSearchBar
        {...baseProps}
        imageSearchActive
        imageSearchReference={{
          imagePath: "D:\\references\\seaside sunset.jpg",
          previewDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
        }}
      />
    );

    const reference = screen.getByRole("button", {
      name: "参考图片：seaside sunset.jpg，点击更换",
    });
    expect(screen.getByText("seaside sunset.jpg")).toBeInTheDocument();
    expect(
      container.querySelector(".home-image-search-reference img")
    ).toHaveAttribute("src", "data:image/jpeg;base64,cHJldmlldw==");

    await user.hover(reference);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "参考图片：seaside sunset.jpg，点击更换"
    );
  });

  it("falls back to the image icon when the reference preview cannot load", () => {
    const { container } = render(
      <ControlledSearchBar
        {...baseProps}
        imageSearchActive
        imageSearchReference={{
          imagePath: "D:\\references\\unsupported.raw",
          previewDataUrl: "data:image/jpeg;base64,broken",
        }}
      />
    );

    const image = container.querySelector(".home-image-search-reference img");
    expect(image).not.toBeNull();
    if (image) {
      fireEvent.error(image);
    }

    expect(
      container.querySelector(".home-image-search-reference img")
    ).not.toBeInTheDocument();
    expect(screen.getByText("unsupported.raw")).toBeInTheDocument();
  });

  it("shows a labeled image search action and opens the file input", async () => {
    const user = userEvent.setup();
    const inputClick = vi
      .spyOn(HTMLInputElement.prototype, "click")
      .mockImplementation(() => undefined);
    render(<ControlledSearchBar {...baseProps} onImageSearch={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: "以图搜图" }));

    expect(inputClick).toHaveBeenCalledOnce();
    inputClick.mockRestore();
  });

  it("shows the shared tooltip for the image search action", async () => {
    const user = userEvent.setup();
    render(<ControlledSearchBar {...baseProps} onImageSearch={vi.fn()} />);

    const button = screen.getByRole("button", { name: "以图搜图" });
    await user.hover(button);

    const tooltip = await screen.findByRole("tooltip");
    expect(tooltip).toHaveTextContent("以图搜图 — 选择参考图片寻找相似照片");
    const tooltipContent = tooltip.closest('[data-slot="tooltip-content"]');
    expect(tooltipContent).not.toBeNull();
    expect(tooltipContent).toHaveAttribute("data-slot", "tooltip-content");
    expect(tooltipContent).toHaveClass(
      "rounded-[6px]",
      "border-border",
      "bg-popover",
      "px-2.5",
      "py-1.5",
      "text-[12px]",
      "shadow-md",
      "ring-1",
      "surface-elevated"
    );

    await user.unhover(button);
    fireEvent.pointerLeave(button);
    fireEvent.blur(button);
    fireEvent.pointerMove(document, { clientX: 1000, clientY: 1000 });
    await waitFor(() => {
      expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    });
  });

  it("calls onSearch when the form is submitted", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<ControlledSearchBar {...baseProps} onSearch={onSearch} />);
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

  it("selects a tag suggestion as a pure tag filter without text search", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    const onTagSelect = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        onSearch={onSearch}
        onTagSelect={onTagSelect}
      />
    );

    await user.type(screen.getByRole("combobox"), "自行车");
    const tagOption = (await screen.findAllByRole("option")).find((option) =>
      option.textContent?.includes("标签")
    );
    expect(tagOption).toBeDefined();
    if (!tagOption) {
      return;
    }
    await user.click(tagOption);

    expect(onTagSelect).toHaveBeenCalledWith({
      color: "#4f46e5",
      id: 42,
      name: "自行车",
    });
    expect(onSearch).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox")).toHaveValue("");
  });

  it("applies periodic month and hour filters", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<ControlledSearchBar {...baseProps} onSearch={onSearch} />);

    await user.click(screen.getByRole("button", { name: "exifFilterTitle" }));
    await user.click(screen.getByLabelText("dateMonthLabel"));
    await user.click(screen.getByRole("option", { name: "7 月" }));
    await user.click(screen.getByLabelText("dateHourLabel"));
    await user.click(screen.getByRole("option", { name: "00:00–01:00" }));
    await user.click(screen.getByRole("button", { name: "applyFilters" }));

    expect(onSearch).toHaveBeenCalledWith("", {
      dateMonth: "7",
      dateHour: "0",
    });
  });

  it("applies a creator EXIF filter", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<ControlledSearchBar {...baseProps} onSearch={onSearch} />);

    await user.click(screen.getByRole("button", { name: "exifFilterTitle" }));
    await user.type(screen.getByLabelText("creatorLabel"), "Jane Doe");
    await user.click(screen.getByRole("button", { name: "applyFilters" }));

    expect(onSearch).toHaveBeenCalledWith("", { creator: "Jane Doe" });
  });

  it("does not search an empty query", () => {
    const onSearch = vi.fn();
    render(<ControlledSearchBar {...baseProps} onSearch={onSearch} />);

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
    render(<ControlledSearchBar {...baseProps} onClear={onClear} />);
    const input = screen.getByRole("combobox");

    await user.type(input, "x");
    await user.click(screen.getByRole("button", { name: "clearSearch" }));

    expect(onClear).toHaveBeenCalled();
  });
});
