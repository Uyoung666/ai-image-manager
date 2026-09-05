import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
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
