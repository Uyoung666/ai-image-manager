import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";

const { translate } = vi.hoisted(() => ({
  translate: vi.fn((key: string, options?: Record<string, unknown>) =>
    key === "sequenceDeleteWhole" ? `${key}:${String(options?.count)}` : key
  ),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
}));

const SEQUENCE_DELETE_LABEL = /sequenceDeleteWhole:3/;

describe("PhotoContextMenu", () => {
  it("routes deletion of a folded sequence to the whole scoped group", () => {
    translate.mockClear();
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
});
