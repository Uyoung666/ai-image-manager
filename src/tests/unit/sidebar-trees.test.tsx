import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  buildFolderTree,
  FolderTree,
  flattenVisibleFolderTree,
} from "@/components/sidebar-trees";
import type { Folder } from "@/types/photo";

function createFolder(
  id: number,
  displayName: string,
  parentId: number | null = null
): Folder {
  return {
    displayName,
    id,
    parentId,
    path: `C:/${displayName}-${id}`,
    photoCount: id,
  };
}

function renderFolderTree(folders: Folder[], expandedIds = new Set<number>()) {
  return render(
    <FolderTree
      activeId={null}
      dragOverId={null}
      expandedIds={expandedIds}
      label="Folders"
      nodes={buildFolderTree(folders)}
      onContextMenu={vi.fn()}
      onDragLeave={vi.fn()}
      onDragOver={vi.fn()}
      onDrop={vi.fn()}
      onSelect={vi.fn()}
      onToggle={vi.fn()}
    />
  );
}

describe("folder tree helpers", () => {
  it("sorts every level by natural folder name", () => {
    const tree = buildFolderTree([
      createFolder(1, "Folder 10"),
      createFolder(2, "folder 2"),
      createFolder(3, "Alpha"),
      createFolder(4, "Child 10", 3),
      createFolder(5, "Child 2", 3),
    ]);

    expect(tree.map((node) => node.folder.displayName)).toEqual([
      "Alpha",
      "folder 2",
      "Folder 10",
    ]);
    expect(tree[0].children.map((node) => node.folder.displayName)).toEqual([
      "Child 2",
      "Child 10",
    ]);
  });

  it("flattens only visible nodes and tolerates cyclic parent data", () => {
    const tree = buildFolderTree([
      createFolder(1, "Root"),
      createFolder(2, "Child", 1),
      createFolder(3, "Cycle A", 4),
      createFolder(4, "Cycle B", 3),
    ]);
    const visible = flattenVisibleFolderTree(tree, new Set([1, 3, 4]));

    expect(new Set(visible.map((item) => item.node.folder.id))).toEqual(
      new Set([1, 2, 3, 4])
    );
  });

  it("caps deep indentation while preserving the full path tooltip", () => {
    const folders = Array.from({ length: 8 }, (_, index) =>
      createFolder(index + 1, `Level ${index + 1}`, index === 0 ? null : index)
    );
    renderFolderTree(folders, new Set(folders.map((folder) => folder.id)));

    const deepestItem = screen.getByText("Level 8").closest("button");
    expect(deepestItem).toHaveTextContent("...");
    expect(deepestItem).toHaveAttribute("aria-label", "C:/Level 8-8");
  });

  it("draws branch elbows and stops the guide at the last sibling", () => {
    const folders = [
      createFolder(1, "Root"),
      createFolder(2, "Child A", 1),
      createFolder(3, "Child B", 1),
    ];
    renderFolderTree(folders, new Set([1]));

    const firstIndent = screen
      .getByText("Child A")
      .closest("button")?.previousElementSibling;
    const lastIndent = screen
      .getByText("Child B")
      .closest("button")?.previousElementSibling;
    expect(
      firstIndent?.querySelector('[data-tree-guide="branch"]')
    ).toHaveStyle({ height: "100%" });
    expect(lastIndent?.querySelector('[data-tree-guide="branch"]')).toHaveStyle(
      { height: "50%" }
    );
    expect(
      lastIndent?.querySelector('[data-tree-guide="elbow"]')
    ).toBeInTheDocument();
  });

  it("enables virtualization for large visible trees", () => {
    const folders = Array.from({ length: 201 }, (_, index) =>
      createFolder(index + 1, `Folder ${index + 1}`)
    );
    renderFolderTree(folders);

    expect(screen.getByRole("tree")).toHaveAttribute(
      "data-resource-tree-scroll",
      "true"
    );
    expect(screen.getByRole("tree")).toHaveAttribute(
      "data-virtualized",
      "true"
    );
  });
});
