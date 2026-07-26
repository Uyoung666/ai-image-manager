import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FaceScanScopeDialog } from "@/components/face-scan-scope-dialog";
import type { Folder } from "@/types/photo";

const FAMILY_NAME = /Family/;
const YEAR_NAME = /2026/;
const LANDSCAPES_NAME = /Landscapes/;

const folders: Folder[] = [
  {
    displayName: "Family",
    id: 1,
    parentId: null,
    path: "D:/Photos/Family",
    photoCount: 2,
    totalPhotoCount: 5,
  },
  {
    displayName: "2026",
    id: 2,
    parentId: 1,
    path: "D:/Photos/Family/2026",
    photoCount: 3,
    totalPhotoCount: 3,
  },
  {
    displayName: "Landscapes",
    id: 3,
    parentId: null,
    path: "D:/Photos/Landscapes",
    photoCount: 8,
    totalPhotoCount: 8,
  },
];

describe("FaceScanScopeDialog", () => {
  it("shows descendants as included and prevents redundant selection", () => {
    render(
      <FaceScanScopeDialog
        folders={folders}
        initialFolderIds={[1]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        open
      />
    );

    expect(screen.getByRole("checkbox", { name: FAMILY_NAME })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: YEAR_NAME })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: YEAR_NAME })).toBeDisabled();
  });

  it("saves independent selected roots", async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <FaceScanScopeDialog
        folders={folders}
        initialFolderIds={[]}
        onClose={vi.fn()}
        onSave={onSave}
        open
      />
    );

    fireEvent.click(screen.getByRole("checkbox", { name: YEAR_NAME }));
    fireEvent.click(screen.getByRole("checkbox", { name: LANDSCAPES_NAME }));
    fireEvent.click(screen.getByText("保存"));

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith([2, 3]);
    });
  });

  it("does not allow saving an empty scope", () => {
    render(
      <FaceScanScopeDialog
        folders={folders}
        initialFolderIds={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        open
      />
    );

    expect(screen.getByText("保存")).toBeDisabled();
  });

  it("uses the customized folder appearance", () => {
    render(
      <FaceScanScopeDialog
        folders={[
          {
            ...folders[0],
            appearanceColor: "#DC2626",
            appearanceIcon: "camera",
          },
        ]}
        initialFolderIds={[]}
        onClose={vi.fn()}
        onSave={vi.fn()}
        open
      />
    );

    const badge = document.querySelector('[data-folder-badge="true"]');
    expect(badge).toHaveAttribute("data-folder-color", "#DC2626");
    expect(badge).toHaveAttribute("data-folder-icon", "camera");
  });
});
