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
import { clearSearchStarterCache } from "@/features/search-bar/use-search-starters";
import { ipc } from "@/ipc/manager";
import type { ExifFilters } from "@/types/search";

const presetToast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => navigateMock }));

vi.mock("sonner", () => ({ toast: presetToast }));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      faces: { listFaceIdentities: vi.fn().mockResolvedValue([]) },
      photos: {
        getSearchStarters: vi.fn(),
        getSearchStarterFallbacks: vi.fn(),
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
    clearSearchStarterCache();
    vi.clearAllMocks();
    vi.mocked(ipc.client.photos.getSearchStarterFallbacks)
      .mockReset()
      .mockResolvedValue({
        candidates: [],
        day: "2026-10-27",
        revision: "fixture",
        validity: "fixture",
        status: "empty",
      });
    vi.mocked(ipc.client.photos.getSearchStarters)
      .mockReset()
      .mockResolvedValue({
        status: "ready",
        revision: "fixture",
        validity: "fixture",
        day: "2026-10-27",
        candidates: [
          "去年秋天的红叶",
          "海边的日落",
          "可爱的猫咪",
          "夜晚的城市街道",
        ].map((text) => ({
          key: text,
          text,
          topics: [text],
          source: "library",
        })),
      });
    vi.mocked(ipc.client.photos.getTags)
      .mockReset()
      .mockResolvedValue([
        { color: "#4f46e5", id: 42, name: "自行车" },
      ] as never);
  });

  it("keeps saved search controls inside the search dropdown without a persistent extra row", async () => {
    const user = userEvent.setup();
    const apply = vi.fn();
    const context = { query: "Travel", sort: "name", order: "asc" } as const;
    render(
      <ControlledSearchBar
        initialFilters={{ creator: "Jane" }}
        initialQuery="Travel"
        onLoadSearchPreset={apply}
        searchPresetContext={context}
      />
    );
    expect(screen.queryByText("搜索预设 (0)")).not.toBeInTheDocument();
    const input = screen.getByPlaceholderText("搜索文件名、标签或人物");
    await user.click(input);
    const heading = await screen.findByText("搜索预设 (0)");
    expect(
      heading.closest('[data-overlay-kind="search-suggestions"]')
    ).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "保存搜索条件" }));
    const name = await screen.findByPlaceholderText(
      "filterPresetNamePlaceholder"
    );
    await user.type(name, "Travel preset");
    await user.click(screen.getByRole("button", { name: "保存" }));
    expect(readFilterPresets()).toMatchObject([
      { name: "Travel preset", filters: { creator: "Jane" }, search: context },
    ]);
    await user.click(screen.getByRole("button", { name: "Travel preset" }));
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Travel preset", search: context })
    );
    expect(screen.queryByText("搜索预设 (1)")).not.toBeInTheDocument();
  });

  it("keeps reopened suggestions after a pending blur close and closes when focus leaves", async () => {
    render(
      <>
        <ControlledSearchBar
          initialQuery="Travel"
          searchPresetContext={{ query: "Travel", sort: "name", order: "asc" }}
        />
        <button type="button">outside</button>
      </>
    );
    const input = screen.getByPlaceholderText("搜索文件名、标签或人物");
    const outside = screen.getByRole("button", { name: "outside" });
    act(() => input.focus());
    act(() => outside.focus());
    act(() => input.focus());
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("搜索预设 (0)")).toBeInTheDocument();

    act(() => outside.focus());
    await act(() => new Promise((resolve) => setTimeout(resolve, 200)));
    expect(input).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the EXIF panel above the gallery status bar so its actions remain clickable", async () => {
    const { container } = render(
      <div className="home-gallery-canvas">
        <ControlledSearchBar />
        <div className="home-gallery-status-bar" />
      </div>
    );
    const toolbar = container.querySelector("search");
    const statusBar = container.querySelector(".home-gallery-status-bar");
    if (!(toolbar && statusBar)) {
      throw new Error("Gallery toolbar fixture is missing");
    }
    vi.spyOn(toolbar, "getBoundingClientRect").mockReturnValue({
      bottom: 100,
    } as DOMRect);
    vi.spyOn(statusBar, "getBoundingClientRect").mockReturnValue({
      top: window.innerHeight - 28,
      height: 28,
    } as DOMRect);
    await openExifFilterPanel();
    expect(
      container.querySelector('[data-overlay-kind="search-filter"]')
    ).toHaveStyle({ maxHeight: `${window.innerHeight - 148}px` });
  });

  it("explains an incompatible index before searching and opens its exact settings page", async () => {
    const status = {
      coverageState: "error" as const,
      model: "loading",
      vectorDB: "error",
      hasVectors: false,
      vectorCount: 0,
      indexReady: false,
      isEmbedding: false,
      rebuildRequired: true,
      embeddingProgress: { processed: 0, total: 8, phase: "idle" },
    };
    const { rerender } = render(<ControlledSearchBar aiStatus={status} />);
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "placeholder",
      "搜索文件名、标签或人物"
    );
    expect(
      screen.getByRole("alert", { name: "aiIndexRebuildRequired" })
    ).toBeInTheDocument();
    expect(
      screen.getByText("aiIndexRebuildNoticeDescription")
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        "AI 语义搜索暂不可用，当前仅显示文件名、标签和人名匹配。"
      )
    ).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "aiIndexOpenSettings" }));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/settings/ai-index" });
    rerender(
      <ControlledSearchBar
        aiStatus={{
          ...status,
          rebuildRequired: false,
          coverageState: "ready",
          model: "ready",
          vectorDB: "ready",
          hasVectors: true,
          indexReady: true,
        }}
      />
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("combobox")).toHaveAttribute(
      "placeholder",
      "搜索文件名、标签或人物"
    );
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
      screen.getByPlaceholderText("搜索文件名、标签或人物")
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

  it("keeps drill-down actions visible when no EXIF chip is active", async () => {
    const user = userEvent.setup();
    const onReturn = vi.fn();
    const onReset = vi.fn();

    render(
      <ControlledSearchBar
        {...baseProps}
        filterBarLeadingContent={
          <button onClick={onReturn} type="button">
            back to dashboard
          </button>
        }
        filterBarTrailingContent={
          <button onClick={onReset} type="button">
            reset drill-down
          </button>
        }
      />
    );

    await user.click(screen.getByRole("button", { name: "back to dashboard" }));
    await user.click(screen.getByRole("button", { name: "reset drill-down" }));

    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(onReset).toHaveBeenCalledTimes(1);
  });

  it("uses the drill-down reset action instead of a duplicate chip-row clear action", () => {
    render(
      <ControlledSearchBar
        {...baseProps}
        filterBarTrailingContent={
          <button type="button">reset drill-down</button>
        }
        initialFilters={{ cameraModel: "Example Camera" }}
      />
    );

    expect(
      screen.queryByRole("button", { name: "clearSearchFilters" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "reset drill-down" })
    ).toBeInTheDocument();
  });

  it("labels the chip-row action as clearing filters while preserving the query", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        {...baseProps}
        initialFilters={{ cameraModel: "Example Camera" }}
        initialQuery="sunset"
        onSearch={onSearch}
      />
    );

    await user.click(
      screen.getByRole("button", { name: "clearSearchFilters" })
    );

    expect(onSearch).toHaveBeenCalledWith("sunset", undefined);
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
    expect(screen.getByText("探索你的图库")).toBeInTheDocument();
    expect(screen.getByText("去年秋天的红叶")).toBeInTheDocument();
    expect(screen.getByText("海边的日落")).toBeInTheDocument();
    expect(screen.queryByText("最近搜索")).not.toBeInTheDocument();
  });

  it("executes a trusted tag card without a model and preserves the current filters", async () => {
    vi.mocked(ipc.client.photos.getSearchStarterFallbacks).mockResolvedValue({
      status: "ready",
      revision: "metadata",
      validity: "fixture",
      day: "2026-10-27",
      candidates: [
        {
          kind: "tag",
          key: "tag:1",
          text: "海滩",
          query: '"海滩"',
          topics: ["海滩"],
          source: "library",
          previewPhotoIds: [1],
        },
      ],
    });
    const onSearch = vi.fn();
    const onTagSelect = vi.fn();
    const user = userEvent.setup();
    render(
      <ControlledSearchBar
        aiStatus={null}
        initialFilters={{ cameraModel: "Canon" }}
        onSearch={onSearch}
        onTagSelect={onTagSelect}
      />
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "海滩" }));
    expect(onSearch).toHaveBeenCalledWith('"海滩"', { cameraModel: "Canon" });
    expect(onTagSelect).not.toHaveBeenCalled();
    expect(ipc.client.photos.getSearchStarters).not.toHaveBeenCalled();
  });

  it("executes a month card as a date-filter search instead of searching its display title", async () => {
    vi.mocked(ipc.client.photos.getSearchStarterFallbacks).mockResolvedValue({
      status: "ready",
      revision: "metadata",
      validity: "fixture",
      day: "2026-10-27",
      candidates: [
        {
          kind: "month",
          key: "month:2023-02",
          text: "2023年2月",
          query: "",
          filters: { dateFrom: "2023-02-10", dateTo: "2023-02-20" },
          topics: ["month:2023-02"],
          source: "library",
        },
      ],
    });
    const onSearch = vi.fn();
    const user = userEvent.setup();
    render(
      <ControlledSearchBar
        aiStatus={null}
        initialFilters={{
          cameraModel: "Canon",
          dateFrom: "2023-02-10",
          dateTo: "2023-02-20",
        }}
        onSearch={onSearch}
      />
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: "2023年2月" }));
    expect(onSearch).toHaveBeenCalledWith("", {
      cameraModel: "Canon",
      dateFrom: "2023-02-10",
      dateTo: "2023-02-20",
    });
    expect(localStorage.getItem(SEARCH_HISTORY_KEY)).toBeNull();
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
    expect(screen.queryByText("探索你的图库")).not.toBeInTheDocument();
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
    expect(screen.getByText("探索你的图库")).toBeInTheDocument();
    expect(screen.getByText("去年秋天的红叶")).toBeInTheDocument();
  });

  it("switches from starter content to matching suggestions while typing", async () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["海边旅行"]));
    const user = userEvent.setup();
    render(<ControlledSearchBar {...baseProps} />);
    const input = screen.getByRole("combobox");

    await user.click(input);
    await user.type(input, "海边旅");

    expect(screen.queryByText("探索你的图库")).not.toBeInTheDocument();
    expect(screen.getByText("搜索建议")).toBeInTheDocument();
    expect(screen.getByText("海边旅行")).toBeInTheDocument();

    await user.clear(input);
    expect(screen.getByText("探索你的图库")).toBeInTheDocument();
  });

  it("supports keyboard selection for starter examples", async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<ControlledSearchBar {...baseProps} onSearch={onSearch} />);

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("option", { name: "去年秋天的红叶" })
    ).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(onSearch).toHaveBeenCalledWith("去年秋天的红叶", undefined);
  });

  it("keeps suggestion navigation from reaching the background gallery shortcuts", async () => {
    const user = userEvent.setup();
    render(<ControlledSearchBar />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}");
    const background = vi.fn();
    document.addEventListener("keydown", background);
    try {
      await user.keyboard("{ArrowRight}{ArrowLeft}{ArrowUp}{ArrowDown}");
      expect(background).not.toHaveBeenCalled();
      expect(screen.getByRole("listbox")).toBeVisible();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.getByRole("combobox")).toHaveFocus();
      expect(background).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", background);
    }
  });

  it("navigates from keyboard focus even if another card has been highlighted by the pointer", async () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["最后一条历史"]));
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(<ControlledSearchBar onSearch={onSearch} />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}");
    const first = screen.getByRole("option", { name: "去年秋天的红叶" });
    expect(first).toHaveFocus();
    fireEvent.pointerMove(screen.getByRole("option", { name: "可爱的猫咪" }));
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { name: "最后一条历史" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSearch).toHaveBeenCalledWith("最后一条历史", undefined);
  });

  it("keeps search history free of redundant tooltips", async () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["我的搜索记录"]));
    const user = userEvent.setup();
    render(<ControlledSearchBar />);
    await user.click(screen.getByRole("combobox"));
    const history = screen.getByRole("option", { name: "我的搜索记录" });
    expect(history).not.toHaveAttribute("data-slot", "tooltip-trigger");
    expect(history).not.toHaveAttribute("title");
    act(() => history.focus());
    await user.hover(history);
    await act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
  });

  it.each([
    "hover",
    "focus",
  ] as const)("explains refreshing themes on %s", async (interaction) => {
    const user = userEvent.setup();
    render(<ControlledSearchBar />);
    await user.click(screen.getByRole("combobox"));
    const refresh = screen.getByRole("button", { name: "换一批" });
    if (interaction === "hover") {
      await user.hover(refresh);
    } else {
      act(() => refresh.focus());
    }
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "更换推荐主题，内容每天更新"
    );
    expect(refresh).not.toHaveAttribute("title");
  });

  it("reserves four skeleton slots until personalized recommendations arrive", async () => {
    let resolve:
      | ((
          value: Awaited<ReturnType<typeof ipc.client.photos.getSearchStarters>>
        ) => void)
      | undefined;
    vi.mocked(ipc.client.photos.getSearchStarters).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const user = userEvent.setup();
    const { container } = render(<ControlledSearchBar {...baseProps} />);
    await user.click(screen.getByRole("combobox"));
    await waitFor(() => expect(resolve).toBeDefined());
    const grid = container.querySelector("[data-starter-grid]");
    expect(grid).toHaveAttribute("aria-busy", "true");
    expect(grid?.querySelectorAll('[aria-hidden="true"]')).toHaveLength(4);
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
    await act(async () => {
      resolve?.({
        status: "ready",
        revision: "loaded",
        validity: "fixture",
        day: "2026-10-27",
        candidates: [
          {
            key: "beach",
            text: "海边的日落",
            source: "library",
            topics: ["海滩", "日落"],
          },
        ],
      });
      await Promise.resolve();
    });
    expect(grid).toHaveAttribute("aria-busy", "false");
    expect(screen.getByRole("option", { name: "海边的日落" })).toBeVisible();
  });

  it("keeps a keyboard-selected history entry selected when delayed ideas arrive above it", async () => {
    localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(["海边旅行"]));
    let resolve:
      | ((
          value: Awaited<ReturnType<typeof ipc.client.photos.getSearchStarters>>
        ) => void)
      | undefined;
    vi.mocked(ipc.client.photos.getSearchStarters).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );
    const onSearch = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSearchBar onSearch={onSearch} />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { name: "海边旅行" })).toHaveFocus();
    await act(async () => {
      resolve?.({
        status: "ready",
        revision: "delayed",
        validity: "fixture",
        day: "2026-10-27",
        candidates: [
          {
            key: "new",
            text: "城市的日落",
            topics: ["城市"],
            source: "library",
          },
        ],
      });
      await Promise.resolve();
    });
    expect(screen.getByRole("option", { name: "海边旅行" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    expect(screen.getByRole("option", { name: "海边旅行" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onSearch).toHaveBeenCalledWith("海边旅行", undefined);
  });

  it("executes a localized dated idea using its semantic query and explicit date filters", async () => {
    vi.mocked(ipc.client.photos.getSearchStarters).mockResolvedValue({
      status: "ready",
      revision: "dated",
      validity: "fixture",
      day: "2026-10-27",
      candidates: [
        {
          key: "beach:2023-02",
          text: "beach in February 2023",
          query: "beach",
          filters: { dateFrom: "2023-02-01", dateTo: "2023-02-28" },
          source: "rediscovery",
          topics: ["海滩"],
        },
      ],
    });
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <ControlledSearchBar
        initialFilters={{ cameraModel: "Canon" }}
        onSearch={onSearch}
      />
    );
    await user.click(screen.getByRole("combobox"));
    await user.click(
      await screen.findByRole("option", { name: "beach in February 2023" })
    );
    expect(onSearch).toHaveBeenCalledWith("beach", {
      cameraModel: "Canon",
      dateFrom: "2023-02-01",
      dateTo: "2023-02-28",
    });
    expect(
      JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) ?? "[]")
    ).toContain("beach");
  });

  it("explains why semantic recommendations are unavailable in color search", async () => {
    const user = userEvent.setup();
    render(<ControlledSearchBar {...baseProps} colorHex="ff0000" />);
    vi.mocked(ipc.client.photos.getSearchStarters).mockResolvedValue({
      status: "color",
      revision: "color",
      validity: "fixture",
      day: "2026-10-27",
      candidates: [],
    });
    await user.click(screen.getByRole("combobox"));
    expect(
      await screen.findByText(
        "颜色搜索使用当前色彩条件，清除颜色后可查看语义推荐。"
      )
    ).toBeVisible();
    expect(screen.queryByRole("option")).not.toBeInTheDocument();
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
      await screen.findByText(
        "暂时没有可用的图库入口，可以稍后换一批或直接输入搜索。"
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "去年秋天的红叶" })
    ).not.toBeInTheDocument();
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

    expect(screen.queryByText("探索你的图库")).not.toBeInTheDocument();
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
