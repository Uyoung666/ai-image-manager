import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ComponentProps, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SearchBar } from "@/components/SearchBar";
import { ipc } from "@/ipc/manager";
import type { ExifFilters } from "@/types/search";

const presetToast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: presetToast }));

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

const NUMERIC_TAG_PATTERN = /55555/;
const SEARCH_HISTORY_KEY = "search_history";
const PRESET_STORAGE_KEY = "exif-filter-presets";
const FILTER_COUNT_PATTERN = /· 1/;
const REMOVE_FILTER_PATTERN = /移除筛选条件 Example/;
const REMOVE_ADVANCED_FILTER_PATTERN = /移除筛选条件.*Example Vendor/;

type SearchBarProps = ComponentProps<typeof SearchBar>;

interface StoredFilterPreset {
  createdAt: number;
  filters: ExifFilters;
  name: string;
}

function seedFilterPresets(presets: StoredFilterPreset[]) {
  localStorage.setItem(PRESET_STORAGE_KEY, JSON.stringify(presets));
}

function readFilterPresets() {
  return JSON.parse(
    localStorage.getItem(PRESET_STORAGE_KEY) ?? "[]"
  ) as StoredFilterPreset[];
}

async function openExifFilterPanel() {
  await userEvent
    .setup()
    .click(screen.getByRole("button", { name: "exifFilterTitle" }));
  expect(
    screen.getByRole("button", { name: "exifFilterTitle" })
  ).toHaveAttribute("aria-expanded", "true");
}

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
    vi.mocked(ipc.client.photos.getTags)
      .mockReset()
      .mockResolvedValue([
        { color: "#4f46e5", id: 42, name: "自行车" },
      ] as never);
  });

  it("refreshes numeric tag suggestions after creation and deletion without remounting", async () => {
    const getTags = vi.mocked(ipc.client.photos.getTags);
    getTags.mockResolvedValue([] as never);
    render(<ControlledSearchBar />);
    await userEvent.setup().type(screen.getByRole("combobox"), "5");
    expect(
      screen.queryByRole("option", { name: NUMERIC_TAG_PATTERN })
    ).toBeNull();
    getTags.mockResolvedValue([{ id: 55, name: "55555" }] as never);
    act(() => window.dispatchEvent(new CustomEvent("tags-changed")));
    expect(
      await screen.findByRole("option", { name: NUMERIC_TAG_PATTERN })
    ).toBeInTheDocument();
    getTags.mockResolvedValue([] as never);
    act(() => window.dispatchEvent(new CustomEvent("tags-changed")));
    await waitFor(() =>
      expect(
        screen.queryByRole("option", { name: NUMERIC_TAG_PATTERN })
      ).toBeNull()
    );
    expect(screen.getByRole("combobox")).toHaveValue("5");
  });

  it("does not restore deleted suggestions from an older tag request", async () => {
    const getTags = vi.mocked(ipc.client.photos.getTags);
    let finishOld!: (value: never) => void;
    getTags.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        })
    );
    render(<ControlledSearchBar />);
    await userEvent.setup().type(screen.getByRole("combobox"), "5");
    getTags.mockResolvedValue([] as never);
    act(() => window.dispatchEvent(new CustomEvent("tags-changed")));
    await waitFor(() => expect(getTags).toHaveBeenCalledTimes(2));
    await act(async () => finishOld([{ id: 55, name: "55555" }] as never));
    expect(
      screen.queryByRole("option", { name: NUMERIC_TAG_PATTERN })
    ).toBeNull();
  });

  it("renders the simplified search placeholder", () => {
    render(<ControlledSearchBar {...baseProps} />);

    expect(
      screen.getByPlaceholderText("试试搜索“去年秋天的红叶”")
    ).toBeInTheDocument();
  });

  it("focuses and selects the gallery query with Ctrl+F", () => {
    render(<ControlledSearchBar {...baseProps} initialQuery="sunset" />);
    const input = screen.getByRole("combobox") as HTMLInputElement;

    fireEvent.keyDown(document, { ctrlKey: true, key: "f" });

    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });

  it("supports Cmd+F and preserves shifted/global shortcuts", () => {
    render(<ControlledSearchBar {...baseProps} initialQuery="sunset" />);
    const input = screen.getByRole("combobox") as HTMLInputElement;

    fireEvent.keyDown(document, { key: "f", metaKey: true });
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);

    input.blur();
    fireEvent.keyDown(document, { ctrlKey: true, key: "f", shiftKey: true });
    expect(input).not.toHaveFocus();

    fireEvent.keyDown(document, { ctrlKey: true, key: "k" });
    expect(input).not.toHaveFocus();
  });

  it("does not steal Ctrl+F from other editing or modal surfaces", () => {
    render(
      <>
        <ControlledSearchBar {...baseProps} initialQuery="sunset" />
        <input aria-label="other editor" />
        <div data-slot="dialog-content">
          <button aria-label="modal action" type="button" />
        </div>
        <div data-slot="alert-dialog-content" role="alertdialog">
          <button aria-label="alert action" type="button" />
        </div>
      </>
    );
    const searchInput = screen.getByRole("combobox");
    const otherEditor = screen.getByRole("textbox", { name: "other editor" });
    const modalAction = screen.getByRole("button", { name: "modal action" });
    const alertAction = screen.getByRole("button", { name: "alert action" });

    otherEditor.focus();
    fireEvent.keyDown(otherEditor, { ctrlKey: true, key: "f" });
    expect(otherEditor).toHaveFocus();
    expect(searchInput).not.toHaveFocus();

    modalAction.focus();
    fireEvent.keyDown(modalAction, { ctrlKey: true, key: "f" });
    expect(modalAction).toHaveFocus();
    expect(searchInput).not.toHaveFocus();

    alertAction.focus();
    fireEvent.keyDown(alertAction, { ctrlKey: true, key: "f" });
    expect(alertAction).toHaveFocus();
    expect(searchInput).not.toHaveFocus();
  });

  it("focuses the gallery search through a persistent non-modal sidebar", () => {
    render(
      <>
        <ControlledSearchBar {...baseProps} initialQuery="sunset" />
        <div
          aria-label="sidebar"
          className="compact-sidebar-layer relative h-full shrink-0"
          role="dialog"
        >
          <button type="button">sidebar action</button>
        </div>
      </>
    );
    const searchInput = screen.getByRole("combobox");
    const sidebarAction = screen.getByRole("button", {
      name: "sidebar action",
    });

    sidebarAction.focus();
    fireEvent.keyDown(sidebarAction, { ctrlKey: true, key: "f" });

    expect(searchInput).toHaveFocus();
    expect(searchInput).toHaveValue("sunset");
  });

  it("does not steal Ctrl+F while the compact sidebar is modal", () => {
    render(
      <>
        <ControlledSearchBar {...baseProps} initialQuery="sunset" />
        <div
          aria-label="sidebar"
          aria-modal="true"
          className="compact-sidebar-layer is-open relative h-full shrink-0"
          role="dialog"
        >
          <button type="button">compact sidebar action</button>
        </div>
      </>
    );
    const searchInput = screen.getByRole("combobox");
    const sidebarAction = screen.getByRole("button", {
      name: "compact sidebar action",
    });

    sidebarAction.focus();
    fireEvent.keyDown(sidebarAction, { ctrlKey: true, key: "f" });

    expect(sidebarAction).toHaveFocus();
    expect(searchInput).not.toHaveFocus();
  });

  it("does not handle a Ctrl+F event already prevented by another handler", () => {
    const preventDefault = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", preventDefault, { once: true });
    render(<ControlledSearchBar {...baseProps} initialQuery="sunset" />);
    const input = screen.getByRole("combobox");

    fireEvent.keyDown(document, { ctrlKey: true, key: "f" });

    expect(input).not.toHaveFocus();
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

  it("shows active EXIF filter details and removes one filter with a localized name", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{
          cameraModel: "Example Camera",
          lensModel: "Example Lens",
        }}
        onSearch={onSearch}
      />
    );

    expect(screen.getByText("Example Camera")).toBeInTheDocument();
    expect(screen.getByText("Example Lens")).toBeInTheDocument();

    const removeButtons = screen.getAllByRole("button", {
      name: REMOVE_FILTER_PATTERN,
    });
    expect(removeButtons).toHaveLength(2);

    await user.click(removeButtons[0]);

    await waitFor(() => {
      expect(screen.queryByText("Example Camera")).not.toBeInTheDocument();
      expect(screen.getByText("Example Lens")).toBeInTheDocument();
      expect(onSearch).toHaveBeenCalledWith("", {
        cameraModel: "",
        lensModel: "Example Lens",
      });
    });
  });

  it("searches with the remaining filters when removing an advanced EXIF chip", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{
          advancedField: "vendor",
          advancedValue: "Example Vendor",
          cameraModel: "Example Camera",
        }}
        onSearch={onSearch}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: REMOVE_ADVANCED_FILTER_PATTERN,
      })
    );

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledWith("", {
        advancedField: undefined,
        advancedValue: undefined,
        cameraModel: "Example Camera",
      });
    });
  });

  it("omits filter options when removing the only advanced EXIF chip", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{
          advancedField: "vendor",
          advancedValue: "Example Vendor",
        }}
        onSearch={onSearch}
      />
    );

    await user.click(
      screen.getByRole("button", {
        name: REMOVE_ADVANCED_FILTER_PATTERN,
      })
    );

    await waitFor(() => {
      expect(onSearch).toHaveBeenCalledWith("", undefined);
    });
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

  it("saves a preset from the nested EXIF panel without closing it", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
        onSearch={onSearch}
      />
    );

    await openExifFilterPanel();
    await user.click(screen.getByRole("button", { name: "filterSavePreset" }));
    const nameInput = await screen.findByPlaceholderText(
      "filterPresetNamePlaceholder"
    );
    await user.type(nameInput, "Travel");

    const saveButton = screen.getByRole("button", { name: "保存" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(readFilterPresets()).toEqual([
        expect.objectContaining({
          filters: { creator: "Jane" },
          name: "Travel",
        }),
      ]);
    });
    expect(onSearch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByRole("button", { name: "filterLoadPresets" })
    ).toBeInTheDocument();
  });

  it("saves with Enter without applying the nested EXIF filters", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
        onSearch={onSearch}
      />
    );

    await openExifFilterPanel();
    await user.click(screen.getByRole("button", { name: "filterSavePreset" }));
    const nameInput = await screen.findByPlaceholderText(
      "filterPresetNamePlaceholder"
    );
    await user.type(nameInput, "Travel");
    const dispatchResult = fireEvent.keyDown(nameInput, {
      code: "Enter",
      key: "Enter",
    });

    await waitFor(() => {
      expect(readFilterPresets()).toEqual([
        expect.objectContaining({
          filters: { creator: "Jane" },
          name: "Travel",
        }),
      ]);
    });
    expect(dispatchResult).toBe(false);
    expect(onSearch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.queryByPlaceholderText("filterPresetNamePlaceholder")
    ).not.toBeInTheDocument();
  });

  it("deletes a preset through the nested portal and keeps the EXIF panel open", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    seedFilterPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
    ]);
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
        onSearch={onSearch}
      />
    );

    await openExifFilterPanel();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "filterLoadPresets" })
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "filterLoadPresets" }));
    const deleteButton = screen.getAllByRole("button", { name: "delete" })[0];
    expect(deleteButton).toBeDefined();
    if (!deleteButton) {
      return;
    }
    await user.click(deleteButton);

    await waitFor(() => {
      expect(readFilterPresets()).toEqual([
        { createdAt: 2, filters: { creator: "John" }, name: "Work" },
      ]);
    });
    expect(screen.getByRole("button", { name: "Work" })).toBeInTheDocument();
    expect(onSearch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("undoes a nested preset deletion without closing the EXIF panel", async () => {
    const user = userEvent.setup();
    seedFilterPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
    ]);
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
      />
    );

    await openExifFilterPanel();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "filterLoadPresets" })
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "filterLoadPresets" }));
    const deleteButton = screen.getByRole("button", { name: "delete" });
    await user.click(deleteButton);

    await waitFor(() => {
      expect(readFilterPresets()).toEqual([]);
    });
    const toastCall = presetToast.success.mock.calls[0];
    const toastOptions = toastCall?.[1] as
      | { action?: { onClick: () => void | Promise<void> } }
      | undefined;
    expect(toastOptions?.action?.onClick).toBeDefined();

    await act(async () => {
      await toastOptions?.action?.onClick();
    });

    await waitFor(() => {
      expect(readFilterPresets()).toEqual([
        { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      ]);
    });
    expect(screen.getByRole("button", { name: "Travel" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("activates the focused save button without applying nested EXIF filters", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
        onSearch={onSearch}
      />
    );

    await openExifFilterPanel();
    await user.click(screen.getByRole("button", { name: "filterSavePreset" }));
    const nameInput = await screen.findByPlaceholderText(
      "filterPresetNamePlaceholder"
    );
    await user.type(nameInput, "Travel");
    await user.tab();

    const saveButton = screen.getByRole("button", { name: "保存" });
    expect(saveButton).toHaveFocus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readFilterPresets()).toEqual([
        expect.objectContaining({
          filters: { creator: "Jane" },
          name: "Travel",
        }),
      ]);
    });
    expect(onSearch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("activates a focused preset item without applying nested EXIF filters", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    seedFilterPresets([
      { createdAt: 1, filters: { creator: "John" }, name: "Work" },
    ]);
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
        onSearch={onSearch}
      />
    );

    await openExifFilterPanel();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "filterLoadPresets" })
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "filterLoadPresets" }));
    const presetButton = screen.getByRole("button", { name: "Work" });
    presetButton.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(screen.getByLabelText("creatorLabel")).toHaveValue("John");
    });
    expect(onSearch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("activates a focused delete button without applying nested EXIF filters", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    seedFilterPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
    ]);
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
        onSearch={onSearch}
      />
    );

    await openExifFilterPanel();
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "filterLoadPresets" })
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "filterLoadPresets" }));
    const deleteButton = screen.getAllByRole("button", { name: "delete" })[0];
    expect(deleteButton).toBeDefined();
    if (!deleteButton) {
      return;
    }
    deleteButton.focus();
    await user.keyboard("{Enter}");

    await waitFor(() => {
      expect(readFilterPresets()).toEqual([
        { createdAt: 2, filters: { creator: "John" }, name: "Work" },
      ]);
    });
    expect(onSearch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("does not save an IME composition confirmation as a preset", async () => {
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ creator: "Jane" }}
        onSearch={onSearch}
      />
    );

    await openExifFilterPanel();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "filterSavePreset" }));
    const nameInput = await screen.findByPlaceholderText(
      "filterPresetNamePlaceholder"
    );
    fireEvent.compositionStart(nameInput);
    fireEvent.change(nameInput, { target: { value: "旅行" } });
    const dispatchResult = fireEvent.keyDown(nameInput, {
      code: "Enter",
      isComposing: true,
      key: "Enter",
      keyCode: 229,
    });
    fireEvent.compositionEnd(nameInput);

    expect(dispatchResult).toBe(true);
    expect(readFilterPresets()).toEqual([]);
    expect(onSearch).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByPlaceholderText("filterPresetNamePlaceholder")
    ).toBeInTheDocument();
  });

  it("still closes the EXIF panel on a pointerdown outside the toolbar", async () => {
    const user = userEvent.setup();
    render(
      <>
        <ControlledSearchBar
          {...baseProps}
          initialFilters={{ creator: "Jane" }}
        />
        <button type="button">outside</button>
      </>
    );

    await openExifFilterPanel();
    await user.click(screen.getByRole("button", { name: "outside" }));

    expect(
      screen.getByRole("button", { name: "exifFilterTitle" })
    ).toHaveAttribute("aria-expanded", "false");
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
