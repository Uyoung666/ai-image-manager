import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BATCH_RENAME_PATTERN_STORAGE_KEY,
  DEFAULT_BATCH_RENAME_PATTERN,
  readBatchRenamePattern,
  saveBatchRenamePattern,
} from "@/actions/batch-rename-preferences";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";

const mocks = vi.hoisted(() => ({
  onRename: vi.fn(),
}));

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      photos: {
        previewRename: vi.fn(),
      },
    },
  },
}));

function renderDialog(
  onRename = mocks.onRename,
  open = true,
  onClose = vi.fn()
) {
  return render(
    <BatchRenameDialog
      onClose={onClose}
      onRename={onRename}
      open={open}
      photoCount={2}
      sampleFilename="IMG_0001.JPG"
    />
  );
}

const result = {
  errors: 0,
  renamed: 2,
  results: [{ id: 1, newName: "IMG_0001_01.JPG", oldName: "IMG_0001.JPG" }],
};

describe("BatchRenameDialog preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.onRename.mockResolvedValue(result);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hydrates the last successful template on reopen and keeps its preview", () => {
    saveBatchRenamePattern("{orig}_{index:2}");

    const { rerender } = renderDialog();
    const pattern = screen.getByRole("textbox", {
      name: "batchRenamePattern",
    });

    expect(pattern).toHaveValue("{orig}_{index:2}");
    expect(screen.getByText("IMG_0001_01.JPG")).toBeInTheDocument();
    expect(mocks.onRename).not.toHaveBeenCalled();

    rerender(
      <BatchRenameDialog
        onClose={vi.fn()}
        onRename={mocks.onRename}
        open={false}
        photoCount={2}
        sampleFilename="IMG_0001.JPG"
      />
    );
    rerender(
      <BatchRenameDialog
        onClose={vi.fn()}
        onRename={mocks.onRename}
        open
        photoCount={2}
        sampleFilename="IMG_0001.JPG"
      />
    );

    expect(
      screen.getByRole("textbox", { name: "batchRenamePattern" })
    ).toHaveValue("{orig}_{index:2}");
    expect(screen.getByText("IMG_0001_01.JPG")).toBeInTheDocument();
    expect(mocks.onRename).not.toHaveBeenCalled();
  });

  it("stores a template only after a successful rename", async () => {
    renderDialog();
    const pattern = "{yyyy}_{orig}";
    fireEvent.change(
      screen.getByRole("textbox", { name: "batchRenamePattern" }),
      {
        target: { value: pattern },
      }
    );
    expect(
      screen.getByText(`${new Date().getFullYear()}_IMG_0001.JPG`)
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "batchRenameAction" }));

    await waitFor(() => expect(mocks.onRename).toHaveBeenCalledWith(pattern));
    expect(localStorage.getItem(BATCH_RENAME_PATTERN_STORAGE_KEY)).toBe(
      pattern
    );
    expect(screen.getByText("batchRenameSuccess")).toBeInTheDocument();
  });

  it("keeps the last successful template after an all-failed rename", async () => {
    const lastSuccessful = "{orig}_{index:2}";
    saveBatchRenamePattern(lastSuccessful);
    mocks.onRename.mockResolvedValueOnce({
      errors: 2,
      renamed: 0,
      results: [],
    });

    const { rerender } = renderDialog();
    fireEvent.change(
      screen.getByRole("textbox", { name: "batchRenamePattern" }),
      {
        target: { value: "{camera}_{index}" },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "batchRenameAction" }));

    await waitFor(() =>
      expect(screen.getByText("batchRenameSuccess")).toBeInTheDocument()
    );
    expect(localStorage.getItem(BATCH_RENAME_PATTERN_STORAGE_KEY)).toBe(
      lastSuccessful
    );

    rerender(
      <BatchRenameDialog
        onClose={vi.fn()}
        onRename={mocks.onRename}
        open={false}
        photoCount={2}
        sampleFilename="IMG_0001.JPG"
      />
    );
    rerender(
      <BatchRenameDialog
        onClose={vi.fn()}
        onRename={mocks.onRename}
        open
        photoCount={2}
        sampleFilename="IMG_0001.JPG"
      />
    );

    expect(
      screen.getByRole("textbox", { name: "batchRenamePattern" })
    ).toHaveValue(lastSuccessful);
  });

  it("uses the default for an empty persisted template and ignores storage failures", async () => {
    localStorage.setItem(BATCH_RENAME_PATTERN_STORAGE_KEY, "   ");
    expect(readBatchRenamePattern()).toBe(DEFAULT_BATCH_RENAME_PATTERN);

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "batchRenameAction" }));

    await waitFor(() =>
      expect(screen.getByText("batchRenameSuccess")).toBeInTheDocument()
    );
  });

  it("closes on Escape without reaching ancestor or window handlers", () => {
    const onClose = vi.fn();
    const ancestorEscape = vi.fn();
    const windowEscape = vi.fn();
    window.addEventListener("keydown", windowEscape);

    try {
      render(
        <button onKeyDown={ancestorEscape} type="button">
          <BatchRenameDialog
            onClose={onClose}
            onRename={mocks.onRename}
            open
            photoCount={2}
            sampleFilename="IMG_0001.JPG"
          />
        </button>
      );

      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

      expect(onClose).toHaveBeenCalledOnce();
      expect(ancestorEscape).not.toHaveBeenCalled();
      expect(windowEscape).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("keydown", windowEscape);
    }
  });
});
