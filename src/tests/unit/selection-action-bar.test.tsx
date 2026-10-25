import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SelectionActionBar } from "@/components/SelectionActionBar";

const { translate } = vi.hoisted(() => ({
  translate: vi.fn((key: string, options?: Record<string, unknown>) => {
    const values: Record<string, string> = {
      clearSelection: "清除选择",
      cullRequiresTwoPhotos: "至少选择两张照片才能开始筛选",
      cullStart: "开始筛选",
      moreActions: "更多操作",
      selectedPhotos: "已选 {{count}} 张",
    };
    const value = values[key] ?? key;
    return options
      ? Object.entries(options).reduce(
          (text, [name, option]) =>
            text.replace(new RegExp(`{{${name}}}`, "g"), String(option)),
          value
        )
      : value;
  }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

function renderSelectionActionBar(
  selectedCount: number,
  onStartCull: () => void
) {
  render(
    <SelectionActionBar
      onClearSelection={vi.fn()}
      onStartCull={onStartCull}
      selectedCount={selectedCount}
    />
  );
}

describe("SelectionActionBar", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {
          /* Resize is dispatched explicitly by the test. */
        }
        disconnect() {
          /* No native observation exists in jsdom. */
        }
      }
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it("positions notifications above the measured selection bar and releases the space on unmount", async () => {
    const view = render(
      <SelectionActionBar onClearSelection={vi.fn()} selectedCount={2} />
    );
    const layer = document.querySelector<HTMLDivElement>(
      ".selection-action-layer"
    );
    if (!layer) {
      throw new Error("Selection bar missing");
    }
    await waitFor(() =>
      expect(layer).toHaveAttribute("data-selection-visible", "true")
    );
    vi.spyOn(layer, "getBoundingClientRect").mockReturnValue({
      top: 500,
      height: 50,
    } as DOMRect);
    fireEvent.resize(window);
    expect(
      document.documentElement.style.getPropertyValue(
        "--selection-notification-bottom"
      )
    ).toBe(`${window.innerHeight - 500 + 12}px`);
    view.unmount();
    expect(
      document.documentElement.style.getPropertyValue(
        "--selection-notification-bottom"
      )
    ).toBe("");
  });

  it("keeps explicit accessible names when action text is hidden in a narrow window", () => {
    render(
      <SelectionActionBar
        onAddToAlbum={vi.fn()}
        onClearSelection={vi.fn()}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onStartCull={vi.fn()}
        selectedCount={2}
        selectedIds={[1, 2]}
      />
    );
    for (const label of [
      "batchTagsAction",
      "addToAlbum",
      "export",
      "delete",
      "更多操作",
      "清除选择",
    ]) {
      expect(screen.getByRole("button", { name: label })).toHaveAttribute(
        "aria-label",
        label
      );
    }
  });
  it("shows the selection denominator and selects only the advertised scope", () => {
    const selectAll = vi.fn();
    render(
      <SelectionActionBar
        onClearSelection={vi.fn()}
        onSelectAll={selectAll}
        selectedCount={2}
        selectionScopeLabel="选择当前已加载的 80 张照片"
        selectionTotal={80}
      />
    );
    expect(screen.getByText("selectedPhotosInScope")).toBeInTheDocument();
    expect(translate).toHaveBeenCalledWith("selectedPhotosInScope", {
      count: 2,
      total: 80,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "选择当前已加载的 80 张照片" })
    );
    expect(selectAll).toHaveBeenCalledOnce();
    expect(
      screen
        .getByRole("button", { name: "选择当前已加载的 80 张照片" })
        .querySelector(".selection-menu-title")
    ).toHaveTextContent("selectAll");
  });
  it("disables culling below two selected photos and explains why", async () => {
    const user = userEvent.setup();
    const onStartCull = vi.fn();
    renderSelectionActionBar(1, onStartCull);

    await user.click(screen.getByRole("button", { name: "更多操作" }));

    const cullAction = await screen.findByRole("button", { name: "开始筛选" });
    expect(cullAction).toBeDisabled();
    await user.click(cullAction);
    expect(onStartCull).not.toHaveBeenCalled();

    const tooltipTrigger = cullAction.parentElement;
    expect(tooltipTrigger).not.toBeNull();
    if (!tooltipTrigger) {
      return;
    }
    expect(tooltipTrigger).toHaveAttribute("tabindex", "0");

    fireEvent.focus(tooltipTrigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "至少选择两张照片才能开始筛选"
    );
  });

  it("keeps culling available with two selected photos", async () => {
    const user = userEvent.setup();
    const onStartCull = vi.fn();
    renderSelectionActionBar(2, onStartCull);

    await user.click(screen.getByRole("button", { name: "更多操作" }));

    const cullAction = await screen.findByRole("button", { name: "开始筛选" });
    expect(cullAction).toBeEnabled();
    await user.click(cullAction);

    expect(onStartCull).toHaveBeenCalledOnce();
  });
});
