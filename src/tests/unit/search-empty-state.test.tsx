import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SearchEmptyState } from "@/components/SearchEmptyState";

describe("search empty-state recovery", () => {
  it("offers independent recovery for a text search with EXIF conditions", () => {
    const clearExif = vi.fn();
    const keepQuery = vi.fn();
    const clearAll = vi.fn();
    render(
      <SearchEmptyState
        hasActiveFilters
        hasAiVectors
        onClearExifFilters={clearExif}
        onClearFilters={keepQuery}
        onClearSearch={clearAll}
        query="海边"
        searchMode="text"
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "仅清除 EXIF 筛选" }));
    expect(clearExif).toHaveBeenCalledOnce();
    expect(clearAll).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "仅保留关键字搜索" }));
    expect(keepQuery).toHaveBeenCalledOnce();
  });
  it("clears the time clause through its own callback", () => {
    const clearTime = vi.fn();
    const clearAll = vi.fn();
    render(
      <SearchEmptyState
        hasActiveFilters={false}
        hasAiVectors
        onClearSearch={clearAll}
        onClearTimeFilter={clearTime}
        parsedTimeFilter={{
          dateFrom: "2025-01-01",
          dateTo: "2025-12-31",
          keyword: "去年",
        }}
        query="去年海边"
        searchMode="text"
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "emptyClearTimeFilter" })
    );
    expect(clearTime).toHaveBeenCalledOnce();
    expect(clearAll).not.toHaveBeenCalled();
  });
});
