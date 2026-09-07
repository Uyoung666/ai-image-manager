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
