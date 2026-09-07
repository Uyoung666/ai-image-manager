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

const DELETE_PHOTO_LABEL = /deletePhoto/;
const EXPORT_PHOTO_LABEL = /exportPhoto/;
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
      screen.getByRole("menuitem", { name: SEQUENCE_DELETE_LABEL })
    );

    expect(onDeleteSequenceGroup).toHaveBeenCalledWith([1, 2, 3]);
    expect(onDelete).not.toHaveBeenCalled();
    expect(translate).toHaveBeenCalledWith("sequenceDeleteWhole", {
      count: 3,
    });
  });

  it("focuses the first enabled item and navigates without leaking shortcuts", () => {
    const onAddToAlbum = vi.fn();
    const onClose = vi.fn();
    const onExport = vi.fn();
    const propagatedKey = vi.fn();
    const { rerender } = render(
      <>
        <button data-testid="menu-focus-trigger" type="button">
          trigger
        </button>
        <PhotoContextMenu
          menu={{
            isBatch: false,
            open: false,
            photoId: 1,
            photoPath: null,
            selectionCount: 1,
            x: 10,
            y: 10,
          }}
          onAddToAlbum={onAddToAlbum}
          onClose={onClose}
          onDelete={vi.fn()}
          onExport={onExport}
          onOpenExplorer={vi.fn()}
        />
      </>
    );

    const trigger = screen.getByTestId("menu-focus-trigger");
    trigger.focus();
    rerender(
      <>
        <button data-testid="menu-focus-trigger" type="button">
          trigger
        </button>
        <PhotoContextMenu
          menu={{
            isBatch: false,
            open: true,
            photoId: 1,
            photoPath: null,
            selectionCount: 1,
            x: 10,
            y: 10,
          }}
          onAddToAlbum={onAddToAlbum}
          onClose={onClose}
          onDelete={vi.fn()}
          onExport={onExport}
          onOpenExplorer={vi.fn()}
        />
      </>
    );

    const addToAlbum = screen.getByRole("menuitem", { name: "addToAlbum" });
    const exportPhoto = screen.getByRole("menuitem", {
      name: EXPORT_PHOTO_LABEL,
    });
    const deletePhoto = screen.getByRole("menuitem", {
      name: DELETE_PHOTO_LABEL,
    });
    expect(document.activeElement).toBe(addToAlbum);
    expect(
      screen.getByRole("menuitem", { name: "openInExplorer" })
    ).toBeDisabled();

    window.addEventListener("keydown", propagatedKey);
    fireEvent.keyDown(addToAlbum, { key: "ArrowDown" });
    expect(document.activeElement).toBe(exportPhoto);
    fireEvent.keyDown(exportPhoto, { key: "ArrowUp" });
    expect(document.activeElement).toBe(addToAlbum);
    fireEvent.keyDown(addToAlbum, { key: "End" });
    expect(document.activeElement).toBe(deletePhoto);
    fireEvent.keyDown(deletePhoto, { key: "Home" });
    expect(document.activeElement).toBe(addToAlbum);
    fireEvent.keyDown(addToAlbum, { key: "f" });
    expect(propagatedKey).not.toHaveBeenCalled();
    window.removeEventListener("keydown", propagatedKey);

    exportPhoto.focus();
    fireEvent.keyDown(exportPhoto, { key: "Enter" });
    expect(onExport).toHaveBeenCalledWith(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });

  it("restores the trigger focus when Escape closes the menu", () => {
    const onClose = vi.fn();
    const { rerender } = render(
      <>
        <button data-testid="escape-focus-trigger" type="button">
          trigger
        </button>
        <PhotoContextMenu
          menu={{
            isBatch: false,
            open: false,
            photoId: 1,
            photoPath: "C:/photos/1.jpg",
            selectionCount: 1,
            x: 10,
            y: 10,
          }}
          onAddToAlbum={vi.fn()}
          onClose={onClose}
          onDelete={vi.fn()}
          onExport={vi.fn()}
          onOpenExplorer={vi.fn()}
        />
      </>
    );

    const trigger = screen.getByTestId("escape-focus-trigger");
    trigger.focus();
    rerender(
      <>
        <button data-testid="escape-focus-trigger" type="button">
          trigger
        </button>
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
          onClose={onClose}
          onDelete={vi.fn()}
          onExport={vi.fn()}
          onOpenExplorer={vi.fn()}
        />
      </>
    );

    const firstItem = screen.getByRole("menuitem", {
      name: "openInExplorer",
    });
    expect(document.activeElement).toBe(firstItem);
    fireEvent.keyDown(firstItem, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });
  it("closes on Tab and moves focus relative to the trigger", () => {
    const onClose = vi.fn();
    const menuState = {
      isBatch: false,
      photoId: 1,
      photoPath: "C:/photos/1.jpg",
      selectionCount: 1,
      x: 10,
      y: 10,
    };
    const menuCallbacks = {
      onAddToAlbum: vi.fn(),
      onClose,
      onDelete: vi.fn(),
      onExport: vi.fn(),
      onOpenExplorer: vi.fn(),
    };
    const { rerender } = render(
      <>
        <button data-testid="tab-trigger" type="button">
          trigger
        </button>
        <button data-testid="tab-next" type="button">
          next
        </button>
        <PhotoContextMenu
          {...menuCallbacks}
          menu={{ ...menuState, open: false }}
        />
      </>
    );

    const trigger = screen.getByTestId("tab-trigger");
    const next = screen.getByTestId("tab-next");
    trigger.focus();
    rerender(
      <>
        <button data-testid="tab-trigger" type="button">
          trigger
        </button>
        <button data-testid="tab-next" type="button">
          next
        </button>
        <PhotoContextMenu
          {...menuCallbacks}
          menu={{ ...menuState, open: true }}
        />
      </>
    );

    const firstItem = screen.getByRole("menuitem", {
      name: "openInExplorer",
    });
    fireEvent.keyDown(firstItem, { key: "Tab" });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(next);

    rerender(
      <>
        <button data-testid="tab-trigger" type="button">
          trigger
        </button>
        <button data-testid="tab-next" type="button">
          next
        </button>
        <PhotoContextMenu
          {...menuCallbacks}
          menu={{ ...menuState, open: false }}
        />
      </>
    );
    next.focus();
    rerender(
      <>
        <button data-testid="tab-trigger" type="button">
          trigger
        </button>
        <button data-testid="tab-next" type="button">
          next
        </button>
        <PhotoContextMenu
          {...menuCallbacks}
          menu={{ ...menuState, open: true }}
        />
      </>
    );

    fireEvent.keyDown(
      screen.getByRole("menuitem", { name: "openInExplorer" }),
      { key: "Tab", shiftKey: true }
    );
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(trigger);

    rerender(
      <>
        <button data-testid="tab-trigger" type="button">
          trigger
        </button>
        <button data-testid="tab-next" type="button">
          next
        </button>
        <PhotoContextMenu
          {...menuCallbacks}
          menu={{ ...menuState, open: false }}
        />
      </>
    );
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
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

    fireEvent.click(screen.getByRole("menuitem", { name: "copyPath" }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("pathCopied")
    );

    writeText.mockRejectedValueOnce(new Error("clipboard unavailable"));
    fireEvent.click(screen.getByRole("menuitem", { name: "copyPath" }));
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

    fireEvent.click(screen.getByRole("menuitem", { name: "copyImage" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("copyFailed"));
  });
});
