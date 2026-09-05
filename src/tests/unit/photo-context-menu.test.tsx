import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";

const { toast, translate } = vi.hoisted(() => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
  translate: vi.fn((key: string, options?: Record<string, unknown>) =>
    key === "sequenceDeleteWhole" ? `${key}:${String(options?.count)}` : key
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));
vi.mock("sonner", () => ({ toast }));

const SEQUENCE_DELETE_LABEL = /sequenceDeleteWhole:3/;

describe("PhotoContextMenu", () => {
  afterEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: undefined,
    });
  });

  it("routes deletion of a folded sequence to the whole scoped group", () => {
    const onDelete = vi.fn();
    const onDeleteSequenceGroup = vi.fn();
    render(
      <PhotoContextMenu
        menu={{
          isBatch: false,
          open: true,
          photoId: 1,
          photoPath: "C:/photos/1.jpg",
          selectionCount: 1,
          sequenceMemberIds: [1, 2, 3],
          x: 10,
          y: 10,
        }}
        onAddToAlbum={vi.fn()}
        onClose={vi.fn()}
        onDelete={onDelete}
        onDeleteSequenceGroup={onDeleteSequenceGroup}
        onExport={vi.fn()}
        onOpenExplorer={vi.fn()}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: SEQUENCE_DELETE_LABEL })
    );

    expect(onDeleteSequenceGroup).toHaveBeenCalledWith([1, 2, 3]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(translate).toHaveBeenCalledWith("sequenceDeleteWhole", {
      count: 3,
    });
  });

  it("reports path copy success and failure", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <PhotoContextMenu
        menu={{
          isBatch: false,
          open: true,
          photoId: 1,
          photoPath: "C:/photos/1.jpg",
          selectionCount: 1,
          x: 10,
          y: 10,
        }}
        onAddToAlbum={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onOpenExplorer={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "copyPath" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("pathCopied")
    );

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "copyPath" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"));
  });

  it.each([
    ["false", () => Promise.resolve(false)],
    ["undefined", () => Promise.resolve(undefined)],
    ["throws", () => Promise.reject(new Error("clipboard unavailable"))],
  ])("reports image copy failure when the API returns or throws (%s)", async (_label, copy) => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { copyImageToClipboard: vi.fn(copy) },
    });
    render(
      <PhotoContextMenu
        menu={{
          isBatch: false,
          open: true,
          photoId: 1,
          photoPath: "C:/photos/1.jpg",
          selectionCount: 1,
          x: 10,
          y: 10,
        }}
        onAddToAlbum={vi.fn()}
        onClose={vi.fn()}
        onDelete={vi.fn()}
        onExport={vi.fn()}
        onOpenExplorer={vi.fn()}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "copyImage" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"));
  });
});
