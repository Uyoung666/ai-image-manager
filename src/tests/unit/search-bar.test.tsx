import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SearchBar } from "@/components/SearchBar";

describe("SearchBar", () => {
  const baseProps = {
    onClear: vi.fn(),
    onSearch: vi.fn(),
  };

  it("renders search input", () => {
    render(<SearchBar {...baseProps} />);
    const input = screen.getByPlaceholderText("搜索照片… (例如: 去年秋天的红叶)");
    expect(input).toBeInTheDocument();
  });

  it("calls onSearch when form submitted", async () => {
    const onSearch = vi.fn();
    render(<SearchBar {...baseProps} onSearch={onSearch} />);
    const input = screen.getByPlaceholderText("搜索照片… (例如: 去年秋天的红叶)");
    await userEvent.type(input, "test query");
    fireEvent.submit(input.closest("form")!);
    expect(onSearch).toHaveBeenCalledWith("test query", undefined);
  });

  it("does not search empty query", async () => {
    const onSearch = vi.fn();
    render(<SearchBar {...baseProps} onSearch={onSearch} />);
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    expect(onSearch).not.toHaveBeenCalled();
  });

  it("shows clear button when query is not empty", async () => {
    render(<SearchBar {...baseProps} />);
    const input = screen.getByPlaceholderText("搜索照片… (例如: 去年秋天的红叶)");
    await userEvent.type(input, "x");
    const clearBtn = document.querySelector(".lucide-x");
    expect(clearBtn).toBeInTheDocument();
  });

  it("calls onClear when clear button clicked", async () => {
    const onClear = vi.fn();
    render(<SearchBar {...baseProps} onClear={onClear} />);
    const input = screen.getByPlaceholderText("搜索照片… (例如: 去年秋天的红叶)");
    await userEvent.type(input, "x");
    const clearBtn = document.querySelector(".lucide-x")?.parentElement;
    if (clearBtn) fireEvent.click(clearBtn);
    expect(onClear).toHaveBeenCalled();
  });
});
