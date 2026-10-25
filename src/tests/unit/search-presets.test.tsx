import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  markSearchPresetUsed,
  readSearchPresets,
  writeSearchPresets,
} from "@/actions/search-presets";
import { FilterPresets } from "@/components/FilterPresets";

beforeEach(() => localStorage.clear());
it("saves and loads the complete criteria and synchronizes another preset entry", async () => {
  const apply = vi.fn();
  const search = {
    query: "Travel",
    colorHex: "4b87b9",
    sort: "name",
    order: "asc",
  } as const;
  render(
    <>
      <FilterPresets
        currentFilters={{ creator: "Jane" }}
        currentSearch={search}
        onLoadPreset={vi.fn()}
        onLoadSearchPreset={apply}
      />
      <FilterPresets currentFilters={{}} onLoadPreset={vi.fn()} />
    </>
  );
  fireEvent.click(screen.getByRole("button", { name: "保存搜索条件" }));
  fireEvent.change(screen.getByPlaceholderText("filterPresetNamePlaceholder"), {
    target: { value: "My search" },
  });
  fireEvent.click(screen.getByRole("button", { name: "保存" }));
  const stored = readSearchPresets();
  expect(stored).toMatchObject([
    { name: "My search", filters: { creator: "Jane" }, search },
  ]);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "filterLoadPresets" })
    ).toBeVisible()
  );
  fireEvent.click(screen.getByRole("button", { name: "搜索预设 (1)" }));
  fireEvent.click(screen.getByRole("button", { name: "My search" }));
  expect(apply).toHaveBeenCalledWith(stored[0]);
});
it("keeps old EXIF presets readable without inventing a query or sort", () => {
  localStorage.setItem(
    "exif-filter-presets",
    JSON.stringify([
      { name: "Legacy", filters: { isoMin: "100" }, createdAt: 1 },
    ])
  );
  expect(readSearchPresets()).toEqual([
    { name: "Legacy", filters: { isoMin: "100" }, createdAt: 1 },
  ]);
});
it("ignores invalid presets and excludes temporary image paths", () => {
  localStorage.setItem(
    "exif-filter-presets",
    JSON.stringify([
      null,
      { name: "Bad", filters: [], createdAt: 1 },
      {
        name: "Bad color",
        filters: {},
        createdAt: 2,
        search: { query: "a", colorHex: "wrong", sort: "name", order: "asc" },
      },
      {
        name: "Valid",
        filters: {},
        createdAt: 3,
        search: {
          query: "a",
          sort: "date",
          order: "desc",
          imagePath: "C:/private/file.png",
        },
      },
    ])
  );
  expect(readSearchPresets()).toEqual([
    {
      name: "Valid",
      createdAt: 3,
      filters: {},
      search: { query: "a", sort: "date", order: "desc", colorHex: undefined },
    },
  ]);
  expect(writeSearchPresets(readSearchPresets())).toBe(true);
  expect(localStorage.getItem("exif-filter-presets")).not.toContain(
    "imagePath"
  );
});

it("keeps an explicitly cleared color as an empty color condition", () => {
  localStorage.setItem(
    "exif-filter-presets",
    JSON.stringify([
      {
        name: "No color",
        filters: {},
        createdAt: 1,
        search: { query: "Travel", colorHex: "", sort: "date", order: "desc" },
      },
    ])
  );
  expect(readSearchPresets()).toMatchObject([
    { search: { query: "Travel", colorHex: undefined } },
  ]);
});

it("shows inline presets immediately and remembers the most recently used across remounts", () => {
  writeSearchPresets([
    { name: "New", filters: {}, createdAt: 3 },
    { name: "Older", filters: { creator: "Jane" }, createdAt: 1 },
    { name: "Recent", filters: {}, createdAt: 2, lastUsedAt: 100 },
  ]);
  const apply = vi.fn();
  const props = {
    currentFilters: {},
    currentSearch: { query: "", sort: "date", order: "desc" } as const,
    onLoadPreset: apply,
    presentation: "inline" as const,
  };
  const { container, unmount } = render(<FilterPresets {...props} />);
  const names = () =>
    [...document.querySelectorAll("[data-search-preset]")].map((element) =>
      element.getAttribute("data-search-preset")
    );
  expect(names()).toEqual(["Recent", "New", "Older"]);
  expect(
    screen.queryByRole("button", { name: "搜索预设 (3)" })
  ).not.toBeInTheDocument();
  expect(container.querySelector("[data-search-preset-strip]")).toHaveClass(
    "overflow-x-auto",
    "min-w-0"
  );
  fireEvent.click(screen.getByRole("button", { name: "Older" }));
  expect(apply).toHaveBeenCalledWith({ creator: "Jane" });
  expect(names()).toEqual(["Older", "Recent", "New"]);
  expect(readSearchPresets()[1]?.lastUsedAt).toBeGreaterThan(100);
  unmount();
  render(<FilterPresets {...props} />);
  expect(names()).toEqual(["Older", "Recent", "New"]);
  fireEvent.click(screen.getByRole("button", { name: "delete Older" }));
  expect(names()).toEqual(["Recent", "New"]);
  expect(apply).toHaveBeenCalledTimes(1);
});

it("updates only the latest stored preset and never recreates a deleted one when recording use", () => {
  writeSearchPresets([
    { name: "Updated", filters: { creator: "New creator" }, createdAt: 3 },
    { name: "Other", filters: {}, createdAt: 2, lastUsedAt: Date.now() },
  ]);
  expect(markSearchPresetUsed("Updated")).toBe(true);
  const firstUse = readSearchPresets()[0]?.lastUsedAt;
  expect(readSearchPresets()[0]?.filters).toEqual({ creator: "New creator" });
  expect(firstUse).toBeGreaterThan(readSearchPresets()[1]?.lastUsedAt ?? 0);
  expect(markSearchPresetUsed("Updated")).toBe(true);
  expect(readSearchPresets()[0]?.lastUsedAt).toBeGreaterThan(firstUse ?? 0);
  expect(markSearchPresetUsed("Deleted")).toBe(false);
  expect(readSearchPresets()).toHaveLength(2);
});

it("fades only the sides with hidden presets and clears the fade when everything fits", () => {
  writeSearchPresets([{ name: "Preset", filters: {}, createdAt: 1 }]);
  const { container } = render(
    <FilterPresets
      currentFilters={{}}
      onLoadPreset={vi.fn()}
      presentation="inline"
    />
  );
  const strip = container.querySelector(
    "[data-search-preset-strip]"
  ) as HTMLElement;
  Object.defineProperties(strip, {
    clientWidth: { configurable: true, value: 100 },
    scrollWidth: { configurable: true, value: 300 },
    scrollLeft: { configurable: true, writable: true, value: 0 },
  });
  fireEvent.scroll(strip);
  expect(strip).toHaveAttribute("data-left-fade", "false");
  expect(strip).toHaveAttribute("data-right-fade", "true");
  strip.scrollLeft = 100;
  fireEvent.scroll(strip);
  expect(strip).toHaveAttribute("data-left-fade", "true");
  expect(strip).toHaveAttribute("data-right-fade", "true");
  strip.scrollLeft = 200;
  fireEvent.scroll(strip);
  expect(strip).toHaveAttribute("data-left-fade", "true");
  expect(strip).toHaveAttribute("data-right-fade", "false");
  Object.defineProperty(strip, "clientWidth", { value: 400 });
  strip.scrollLeft = 0;
  fireEvent.scroll(strip);
  expect(strip).toHaveAttribute("data-left-fade", "false");
  expect(strip).toHaveAttribute("data-right-fade", "false");
});

it("ignores invalid usage metadata while keeping legacy criteria readable", () => {
  localStorage.setItem(
    "exif-filter-presets",
    JSON.stringify([
      { name: "Legacy", filters: {}, createdAt: 1, lastUsedAt: "bad" },
      { name: "Negative", filters: {}, createdAt: 2, lastUsedAt: -1 },
    ])
  );
  expect(readSearchPresets()).toEqual([
    { name: "Legacy", filters: {}, createdAt: 1 },
    { name: "Negative", filters: {}, createdAt: 2 },
  ]);
});
