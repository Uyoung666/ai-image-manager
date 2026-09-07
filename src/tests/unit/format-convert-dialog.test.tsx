import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FORMAT_CONVERT_PREFERENCES,
  FORMAT_CONVERT_PREFERENCES_STORAGE_KEY,
  saveFormatConvertPreferences,
} from "@/actions/format-convert-preferences";
import { FormatConvertDialog } from "@/components/FormatConvertDialog";

const mocks = vi.hoisted(() => ({
  onConvert: vi.fn(),
  openFolderDialog: vi.fn(),
}));
const AVIF_NAME = /AVIF/;
const JPEG_NAME = /JPEG/;
const PNG_NAME = /PNG/;
const WEBP_NAME = /WebP/;

vi.mock("@/ipc/manager", () => ({
  ipc: {
    client: {
      shell: {
        openFolderDialog: mocks.openFolderDialog,
      },
    },
  },
}));

function renderDialog(
  onConvert = mocks.onConvert,
  open = true,
  onClose = vi.fn()
) {
  return render(
    <FormatConvertDialog
      onClose={onClose}
      onConvert={onConvert}
      open={open}
      photoCount={2}
    />
  );
}

describe("FormatConvertDialog preferences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mocks.openFolderDialog.mockResolvedValue({ path: "D:/Exports" });
    mocks.onConvert.mockResolvedValue({
      converted: 2,
      outputDir: "D:/Exports",
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("hydrates saved values on reopen without starting another conversion", () => {
    saveFormatConvertPreferences({
      format: "jpg",
      quality: 72,
      maxWidth: "1600",
      outputDir: "D:/Exports",
    });

    const { rerender } = renderDialog();

    expect(screen.getByRole("slider", { name: "quality" })).toHaveValue("72");
    expect(
      screen.getByRole("textbox", { name: "maxWidthOptional" })
    ).toHaveValue("1600");
    expect(screen.getByText("D:/Exports")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: JPEG_NAME })).toHaveClass(
      "border-primary"
    );
    expect(mocks.onConvert).not.toHaveBeenCalled();

    rerender(
      <FormatConvertDialog
        onClose={vi.fn()}
        onConvert={mocks.onConvert}
        open={false}
        photoCount={2}
      />
    );
    rerender(
      <FormatConvertDialog
        onClose={vi.fn()}
        onConvert={mocks.onConvert}
        open
        photoCount={2}
      />
    );

    expect(screen.getByRole("slider", { name: "quality" })).toHaveValue("72");
    expect(
      screen.getByRole("textbox", { name: "maxWidthOptional" })
    ).toHaveValue("1600");
    expect(screen.getByText("D:/Exports")).toBeInTheDocument();
    expect(mocks.onConvert).not.toHaveBeenCalled();
  });

  it("saves the current values only after a successful conversion", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: JPEG_NAME }));
    fireEvent.change(screen.getByRole("slider", { name: "quality" }), {
      target: { value: "72" },
    });
    fireEvent.change(
      screen.getByRole("textbox", { name: "maxWidthOptional" }),
      {
        target: { value: "1600" },
      }
    );
    fireEvent.click(screen.getByRole("button", { name: "pickOutputDir" }));
    await waitFor(() =>
      expect(screen.getByText("D:/Exports")).toBeInTheDocument()
    );

    fireEvent.click(screen.getByRole("button", { name: "convertActionCount" }));

    await waitFor(() =>
      expect(mocks.onConvert).toHaveBeenCalledWith({
        format: "jpg",
        quality: 72,
        maxWidth: 1600,
        outputDir: "D:/Exports",
      })
    );
    expect(
      JSON.parse(
        localStorage.getItem(FORMAT_CONVERT_PREFERENCES_STORAGE_KEY) ?? ""
      )
    ).toEqual({
      format: "jpg",
      quality: 72,
      maxWidth: "1600",
      outputDir: "D:/Exports",
    });
    expect(screen.getByText("convertSuccessCount")).toBeInTheDocument();
  });

  it("keeps the last successful values when a later conversion fails", async () => {
    const lastSuccessful = {
      format: "png" as const,
      quality: 90,
      maxWidth: "1200",
      outputDir: "D:/Previous",
    };
    saveFormatConvertPreferences(lastSuccessful);
    mocks.onConvert.mockRejectedValueOnce(new Error("conversion failed"));

    const { rerender } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: AVIF_NAME }));
    fireEvent.click(screen.getByRole("button", { name: "convertActionCount" }));

    await waitFor(() =>
      expect(screen.getByText("conversion failed")).toBeInTheDocument()
    );
    expect(
      JSON.parse(
        localStorage.getItem(FORMAT_CONVERT_PREFERENCES_STORAGE_KEY) ?? ""
      )
    ).toEqual(lastSuccessful);

    rerender(
      <FormatConvertDialog
        onClose={vi.fn()}
        onConvert={mocks.onConvert}
        open={false}
        photoCount={2}
      />
    );
    rerender(
      <FormatConvertDialog
        onClose={vi.fn()}
        onConvert={mocks.onConvert}
        open
        photoCount={2}
      />
    );

    expect(screen.getByRole("button", { name: PNG_NAME })).toHaveClass(
      "border-primary"
    );
    expect(screen.getByRole("slider", { name: "quality" })).toHaveValue("90");
    expect(
      screen.getByRole("textbox", { name: "maxWidthOptional" })
    ).toHaveValue("1200");
    expect(screen.getByText("D:/Previous")).toBeInTheDocument();
  });

  it("falls back per field when saved values are invalid", () => {
    localStorage.setItem(
      FORMAT_CONVERT_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        format: "gif",
        quality: 101,
        maxWidth: "1600px",
        outputDir: "D:/Still-Valid",
      })
    );

    renderDialog();

    expect(screen.getByRole("button", { name: WEBP_NAME })).toHaveClass(
      "border-primary"
    );
    expect(screen.getByRole("slider", { name: "quality" })).toHaveValue(
      String(DEFAULT_FORMAT_CONVERT_PREFERENCES.quality)
    );
    expect(
      screen.getByRole("textbox", { name: "maxWidthOptional" })
    ).toHaveValue(DEFAULT_FORMAT_CONVERT_PREFERENCES.maxWidth);
    expect(screen.getByText("D:/Still-Valid")).toBeInTheDocument();
  });

  it("keeps the last successful values when conversion resolves with zero results", async () => {
    const lastSuccessful = {
      format: "png" as const,
      quality: 90,
      maxWidth: "1200",
      outputDir: "D:/Previous",
    };
    saveFormatConvertPreferences(lastSuccessful);
    mocks.onConvert.mockResolvedValueOnce({
      converted: 0,
      outputDir: "D:/Failed",
    });

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: AVIF_NAME }));
    fireEvent.click(screen.getByRole("button", { name: "convertActionCount" }));

    await waitFor(() =>
      expect(screen.getByText("convertSuccessCount")).toBeInTheDocument()
    );
    expect(
      JSON.parse(
        localStorage.getItem(FORMAT_CONVERT_PREFERENCES_STORAGE_KEY) ?? ""
      )
    ).toEqual(lastSuccessful);
  });

  it("shows the successful result when preference storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "convertActionCount" }));

    await waitFor(() =>
      expect(screen.getByText("convertSuccessCount")).toBeInTheDocument()
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
          <FormatConvertDialog
            onClose={onClose}
            onConvert={mocks.onConvert}
            open
            photoCount={2}
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
