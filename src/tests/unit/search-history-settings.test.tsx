import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import {
  readSearchHistory,
  SEARCH_HISTORY_STORAGE_KEY,
} from "@/actions/search-history";
import { SearchHistorySettings } from "@/components/settings/SearchHistorySettings";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      settings: {
        getSearchHistoryPreferences: mocks.get,
        setSearchHistoryPreferences: mocks.set,
      },
    },
  },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));
vi.mock("@/components/filter-dropdown", () => ({
  FilterDropdown: ({
    value,
    onChange,
    ariaLabel,
    options,
    disabled,
  }: {
    value: string;
    onChange: (value: string) => void;
    ariaLabel: string;
    options: { value: string; label: string }[];
    disabled: boolean;
  }) => (
    <select
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      value={value}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.value}
        </option>
      ))}
    </select>
  ),
}));
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ enabled: true, limit: 20 });
  mocks.set.mockResolvedValue({ ok: true });
  localStorage.setItem(
    SEARCH_HISTORY_STORAGE_KEY,
    JSON.stringify({
      version: 2,
      entries: Array.from({ length: 9 }, (_, i) => ({
        kind: "text",
        query: String(i),
        lastUsedAt: 10 - i,
      })),
    })
  );
});
it("loads the saved policy and rolls back a failed reduction without losing history", async () => {
  render(<SearchHistorySettings />);
  const limit = screen.getByRole("combobox", { name: "searchHistoryUi.limit" });
  await waitFor(() => expect(limit).toHaveValue("20"));
  mocks.set.mockRejectedValueOnce(new Error("failed"));
  fireEvent.change(limit, { target: { value: "5" } });
  expect(readSearchHistory()).toHaveLength(9);
  expect(mocks.set).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "searchHistoryUi.reduceConfirm" })
  );
  await waitFor(() => expect(mocks.error).toHaveBeenCalledWith("saveFailed"));
  expect(limit).toHaveValue("20");
  expect(readSearchHistory()).toHaveLength(9);
});
it("only removes older records after confirming a reduction, including while history is hidden", async () => {
  mocks.get.mockResolvedValue({ enabled: false, limit: 20 });
  render(<SearchHistorySettings />);
  const limit = screen.getByRole("combobox", { name: "searchHistoryUi.limit" });
  await waitFor(() => expect(limit).toHaveValue("20"));
  fireEvent.change(limit, { target: { value: "5" } });
  expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "cancel" }));
  expect(limit).toHaveValue("20");
  expect(readSearchHistory()).toHaveLength(9);
  fireEvent.change(limit, { target: { value: "5" } });
  fireEvent.click(
    screen.getByRole("button", { name: "searchHistoryUi.reduceConfirm" })
  );
  await waitFor(() => expect(limit).toHaveValue("5"));
  expect(readSearchHistory()).toHaveLength(5);
});
it("uses the shared switch and keeps history when recording is turned off", async () => {
  render(<SearchHistorySettings />);
  const toggle = screen.getByRole("checkbox", {
    name: "searchHistoryUi.enabled",
  });
  await waitFor(() => expect(toggle).toBeEnabled());
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle).not.toBeChecked());
  expect(mocks.set).toHaveBeenCalledWith({ enabled: false, limit: 20 });
  expect(readSearchHistory()).toHaveLength(9);
  fireEvent.click(
    screen.getByRole("button", { name: "searchHistoryUi.clear" })
  );
  expect(readSearchHistory()).toEqual([]);
});
