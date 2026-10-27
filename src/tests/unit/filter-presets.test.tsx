import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FilterPresets } from "@/components/FilterPresets";

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("sonner", () => ({ toast }));

const STORAGE_KEY = "exif-filter-presets";

interface StoredPreset {
  createdAt: number;
  filters: Record<string, string>;
  name: string;
}

function seedPresets(presets: StoredPreset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

async function openPresetList() {
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "filterLoadPresets" })
    ).toBeInTheDocument()
  );
  fireEvent.click(screen.getByRole("button", { name: "filterLoadPresets" }));
}

function deleteToastOptions() {
  const call = toast.success.mock.calls[0];
  expect(call).toBeDefined();
  return call?.[1] as {
    action: { onClick: () => void | Promise<void> };
    duration: number;
  };
}

function deleteToastOptionsAt(index: number) {
  const call = toast.success.mock.calls[index];
  expect(call).toBeDefined();
  return call?.[1] as {
    action: { onClick: () => void | Promise<void> };
    duration: number;
  };
}

describe("FilterPresets", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  function renderScrollablePresets() {
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
    ]);
    const view = render(
      <FilterPresets
        currentFilters={{}}
        onLoadPreset={vi.fn()}
        presentation="inline"
      />
    );
    const strip = view.container.querySelector<HTMLElement>(
      "[data-search-preset-strip]"
    );
    if (!strip) {
      throw new Error("Search preset strip is missing");
    }
    let offset = 0;
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 300 },
      scrollWidth: { configurable: true, value: 900 },
      scrollLeft: {
        configurable: true,
        get: () => offset,
        set: (value: number) => {
          offset = Math.max(
            0,
            Math.min(strip.scrollWidth - strip.clientWidth, value)
          );
        },
      },
    });
    return { strip, ...view };
  }

  it("scrolls presets horizontally with a wheel over a preset and updates edge fades", () => {
    const { strip } = renderScrollablePresets();
    const preset = screen.getByRole("button", { name: "Travel" });
    expect(fireEvent.wheel(preset, { deltaY: 120 })).toBe(false);
    expect(strip.scrollLeft).toBe(120);
    expect(strip).toHaveAttribute("data-left-fade", "true");
    expect(strip).toHaveAttribute("data-right-fade", "true");
    expect(fireEvent.wheel(preset, { deltaY: -200 })).toBe(false);
    expect(strip.scrollLeft).toBe(0);
    expect(strip).toHaveAttribute("data-left-fade", "false");
    expect(fireEvent.wheel(preset, { deltaY: 900 })).toBe(false);
    expect(strip.scrollLeft).toBe(600);
    expect(strip).toHaveAttribute("data-right-fade", "false");
  });

  it.each([
    { deltaMode: 1, deltaY: 3, offset: 48 },
    { deltaMode: 2, deltaY: 1, offset: 300 },
  ])("supports wheel delta mode $deltaMode", ({
    deltaMode,
    deltaY,
    offset,
  }) => {
    const { strip } = renderScrollablePresets();
    expect(fireEvent.wheel(strip, { deltaMode, deltaY })).toBe(false);
    expect(strip.scrollLeft).toBe(offset);
  });

  it.each([
    { position: 0, deltaY: -120 },
    { position: 600, deltaY: 120 },
  ])("allows panel scrolling at the $position edge", ({ position, deltaY }) => {
    const { strip } = renderScrollablePresets();
    strip.scrollLeft = position;
    expect(fireEvent.wheel(strip, { deltaY })).toBe(true);
    expect(strip.scrollLeft).toBe(position);
  });

  it("keeps native horizontal gestures, zoom and nonoverflowing content unchanged", () => {
    const { strip } = renderScrollablePresets();
    expect(fireEvent.wheel(strip, { deltaX: 100, deltaY: 10 })).toBe(true);
    expect(fireEvent.wheel(strip, { ctrlKey: true, deltaY: 120 })).toBe(true);
    Object.defineProperty(strip, "scrollWidth", { value: 300 });
    expect(fireEvent.wheel(strip, { deltaY: 120 })).toBe(true);
    expect(strip.scrollLeft).toBe(0);
  });

  it.each([
    599.5, 600.5,
  ])("allows panel scrolling at a fractional right edge of %s", (limit) => {
    const { strip } = renderScrollablePresets();
    let offset = limit;
    Object.defineProperty(strip, "scrollLeft", {
      get: () => offset,
      set: (value: number) => {
        offset = Math.min(limit, value);
      },
    });
    expect(fireEvent.wheel(strip, { deltaY: 120 })).toBe(true);
    expect(strip.scrollLeft).toBe(limit);
  });

  it("removes the native wheel listener when the preset strip unmounts", () => {
    const { strip, unmount } = renderScrollablePresets();
    unmount();
    expect(fireEvent.wheel(strip, { deltaY: 120 })).toBe(true);
    expect(strip.scrollLeft).toBe(0);
  });

  it("deletes a preset immediately and offers an eight-second undo", async () => {
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
    ]);
    render(
      <FilterPresets
        currentFilters={{ creator: "Jane" }}
        onLoadPreset={vi.fn()}
      />
    );

    await openPresetList();
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[0]);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
    ]);
    expect(toast.success).toHaveBeenCalledWith(
      "已删除筛选预设「Travel」",
      expect.objectContaining({
        action: expect.objectContaining({ label: "撤销" }),
        duration: 8000,
      })
    );
    expect(screen.getByRole("button", { name: "Work" })).toBeVisible();
    expect(deleteToastOptions().duration).toBe(8000);
  });

  it("merges undo with the latest storage while restoring the original position", async () => {
    const target: StoredPreset = {
      createdAt: 2,
      filters: { creator: "John" },
      name: "Work",
    };
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      target,
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
    ]);
    render(
      <FilterPresets
        currentFilters={{ creator: "Jane" }}
        onLoadPreset={vi.fn()}
      />
    );

    await openPresetList();
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[1]);
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
      { createdAt: 4, filters: { creator: "Lee" }, name: "New" },
    ]);

    await act(async () => {
      await deleteToastOptions().action.onClick();
    });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      target,
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
      { createdAt: 4, filters: { creator: "Lee" }, name: "New" },
    ]);
    expect(toast.success).toHaveBeenLastCalledWith("已恢复筛选预设「Work」");
  });

  it("does not overwrite a same-name preset created or edited after deletion", async () => {
    const edited: StoredPreset = {
      createdAt: 4,
      filters: { creator: "Different" },
      name: "Work",
    };
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
    ]);
    render(
      <FilterPresets
        currentFilters={{ creator: "Jane" }}
        onLoadPreset={vi.fn()}
      />
    );

    await openPresetList();
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[1]);
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      edited,
    ]);

    await act(async () => {
      await deleteToastOptions().action.onClick();
    });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      edited,
    ]);
    expect(toast.error).toHaveBeenCalledWith(
      "筛选预设「Work」已被重新创建或修改，未恢复"
    );
  });

  it("keeps the list open and restores consecutive deletions in reverse undo order", async () => {
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
    ]);
    render(<FilterPresets currentFilters={{}} onLoadPreset={vi.fn()} />);

    await openPresetList();
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[1]);
    expect(
      screen.getByRole("button", { name: "filterLoadPresets" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[1]);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
    ]);

    await act(async () => {
      await deleteToastOptionsAt(1).action.onClick();
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
    ]);

    await act(async () => {
      await deleteToastOptionsAt(0).action.onClick();
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
    ]);
  });

  it("restores consecutive deletions in deletion order", async () => {
    seedPresets([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
    ]);
    render(<FilterPresets currentFilters={{}} onLoadPreset={vi.fn()} />);

    await openPresetList();
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[1]);
    fireEvent.click(screen.getAllByRole("button", { name: "delete" })[1]);

    await act(async () => {
      await deleteToastOptionsAt(0).action.onClick();
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
    ]);

    await act(async () => {
      await deleteToastOptionsAt(1).action.onClick();
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]")).toEqual([
      { createdAt: 1, filters: { creator: "Jane" }, name: "Travel" },
      { createdAt: 2, filters: { creator: "John" }, name: "Work" },
      { createdAt: 3, filters: { creator: "Ada" }, name: "Family" },
    ]);
  });
});
