import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";

const RECENTLY_DELETED_PATTERN = /最近删除/;
const ORIGINAL_FILE_PATTERN = /原文件暂不移动/;
const ALBUM_TAG_ASSOCIATIONS_PATTERN = /其他相册和标签关系不会被改写/;

describe("ConfirmDialog responsive layout", () => {
  it("keeps long action labels inside a viewport-safe dialog", () => {
    render(
      <ConfirmDialog
        confirmText="Reset all face recognition results"
        description="This intentionally uses long localized copy."
        onConfirm={vi.fn()}
        open
        title="Reset recognition?"
      />
    );

    const dialog = screen.getByRole("alertdialog");
    const confirm = screen.getByRole("button", {
      name: "Reset all face recognition results",
    });
    const footer = confirm.parentElement;

    expect(dialog).toHaveClass(
      "w-[calc(100%-2rem)]",
      "data-[size=sm]:max-w-sm",
      "max-h-[calc(100dvh-2rem)]",
      "overflow-y-auto"
    );
    expect(footer).toHaveClass("sm:flex-wrap");
    expect(confirm).toHaveClass("min-w-0", "whitespace-normal", "text-center");
  });

  it("explains app trash semantics before deleting photos", () => {
    render(
      <ConfirmDeleteDialog
        count={2}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        open
      />
    );

    expect(screen.getByText(RECENTLY_DELETED_PATTERN)).toBeInTheDocument();
    expect(screen.getByText(ORIGINAL_FILE_PATTERN)).toBeInTheDocument();
    expect(
      screen.getByText(ALBUM_TAG_ASSOCIATIONS_PATTERN)
    ).toBeInTheDocument();
  });
});
