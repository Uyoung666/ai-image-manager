import { ChevronRight, Folder } from "lucide-react";
import type React from "react";
import type { ReactNode } from "react";
import { getTagDisplayName } from "@/localization/tag-display";
import type { Folder as FolderType } from "@/types/photo";

export interface TagInfo {
  color: string | null;
  id: number;
  name: string;
  parentId: number | null;
  photoCount: number;
}

interface TagTreeNode {
  children: TagTreeNode[];
  tag: TagInfo;
}

interface FolderTreeNode {
  children: FolderTreeNode[];
  folder: FolderType;
}

function getTreeRowClassName({
  activeClassName,
  isActive,
  isDragOver,
}: {
  activeClassName: string;
  isActive: boolean;
  isDragOver: boolean;
}) {
  const base =
    "flex min-w-0 flex-1 items-center gap-2 rounded-[6px] text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50";
  if (isDragOver) {
    return `${base} bg-primary/20 text-primary ring-1 ring-primary/50`;
  }
  if (isActive) {
    return `${base} ${activeClassName}`;
  }
  return `${base} text-muted-foreground hover:bg-foreground/5 hover:text-foreground`;
}

export function buildFolderTree(folders: FolderType[]): FolderTreeNode[] {
  const nodeMap = new Map<number, FolderTreeNode>();
  const roots: FolderTreeNode[] = [];

  for (const f of folders) {
    nodeMap.set(f.id, { folder: f, children: [] });
  }
  for (const f of folders) {
    const node = nodeMap.get(f.id);
    if (!node) {
      continue;
    }
    if (f.parentId != null && nodeMap.has(f.parentId)) {
      nodeMap.get(f.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function renderFolderTree(
  nodes: FolderTreeNode[],
  depth: number,
  expandedIds: Set<number>,
  onToggle: (id: number) => void,
  activeId: number | null,
  onSelect: (id: number) => void,
  onContextMenu: (e: React.MouseEvent, id: number, name: string) => void,
  dragOverId: number | null,
  onDragOver: (e: React.DragEvent, id: number) => void,
  onDragLeave: () => void,
  onDrop: (e: React.DragEvent, id: number) => void
): ReactNode[] {
  return nodes.flatMap((node) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.folder.id);
    const isActive = activeId === node.folder.id;
    const isDragOver = dragOverId === node.folder.id;

    const row = (
      <div className="flex items-center" key={node.folder.id}>
        <button
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[4px] text-muted-foreground/70 hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.folder.id);
          }}
          style={{ marginLeft: depth * 14 }}
          type="button"
        >
          {hasChildren ? (
            <ChevronRight
              className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
            />
          ) : (
            <span className="w-3" />
          )}
        </button>
        <button
          className={`${getTreeRowClassName({
            activeClassName: "nav-item-active bg-primary/15 text-primary",
            isActive,
            isDragOver,
          })} px-3 py-1.5 text-[13px]`}
          onClick={() => onSelect(node.folder.id)}
          onContextMenu={(e) =>
            onContextMenu(e, node.folder.id, node.folder.displayName)
          }
          onDragEnter={() => {
            /* handled by parent */
          }}
          onDragLeave={onDragLeave}
          onDragOver={(e) => onDragOver(e, node.folder.id)}
          onDrop={(e) => onDrop(e, node.folder.id)}
          type="button"
        >
          <Folder className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {node.folder.displayName}
          </span>
          <span className="ml-1 flex-shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
            {node.folder.totalPhotoCount ?? node.folder.photoCount}
          </span>
        </button>
      </div>
    );

    return hasChildren && isExpanded
      ? [
          row,
          ...renderFolderTree(
            node.children,
            depth + 1,
            expandedIds,
            onToggle,
            activeId,
            onSelect,
            onContextMenu,
            dragOverId,
            onDragOver,
            onDragLeave,
            onDrop
          ),
        ]
      : [row];
  });
}

export function buildTagTree(tags: TagInfo[]): TagTreeNode[] {
  const nodeMap = new Map<number, TagTreeNode>();
  const roots: TagTreeNode[] = [];

  for (const t of tags) {
    nodeMap.set(t.id, { tag: t, children: [] });
  }
  for (const t of tags) {
    const node = nodeMap.get(t.id);
    if (!node) {
      continue;
    }
    if (t.parentId && nodeMap.has(t.parentId)) {
      nodeMap.get(t.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

export function renderTagTree(
  nodes: TagTreeNode[],
  depth: number,
  expandedIds: Set<number>,
  onToggle: (id: number) => void,
  activeIds: number[],
  onSelect: (id: number | null) => void,
  onContextMenu: (e: React.MouseEvent, id: number, name: string) => void,
  onDragOver: (e: React.DragEvent) => void,
  onDragEnter: (id: number) => void,
  onDragLeave: (e: React.DragEvent) => void,
  onDrop: (e: React.DragEvent, id: number) => void,
  dragOverId: number | null,
  language: string
): ReactNode[] {
  return nodes.flatMap((node) => {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.tag.id);
    const isActive = activeIds.includes(node.tag.id);
    const isDragOver = dragOverId === node.tag.id;

    const row = (
      <div
        aria-expanded={hasChildren ? isExpanded : undefined}
        aria-level={depth + 1}
        aria-selected={isActive}
        className="flex items-center"
        data-tag-id={node.tag.id}
        key={node.tag.id}
        role="treeitem"
        tabIndex={-1}
      >
        <button
          aria-hidden="true"
          className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-[4px] text-muted-foreground/70 hover:text-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onToggle(node.tag.id);
          }}
          style={{ marginLeft: depth * 14 }}
          tabIndex={-1}
          type="button"
        >
          {hasChildren ? (
            <ChevronRight
              className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
            />
          ) : (
            <span className="w-3" />
          )}
        </button>
        <button
          className={`group/tag ${getTreeRowClassName({
            activeClassName: "nav-item-active bg-primary/15 text-primary",
            isActive,
            isDragOver,
          })} px-3 py-1 text-[12px] ${isDragOver ? "animate-pulse" : ""}`}
          onClick={() => {
            onSelect(node.tag.id);
          }}
          onContextMenu={(e) => onContextMenu(e, node.tag.id, node.tag.name)}
          onDragEnter={() => onDragEnter(node.tag.id)}
          onDragLeave={onDragLeave}
          onDragOver={onDragOver}
          onDrop={(e) => onDrop(e, node.tag.id)}
          type="button"
        >
          <span
            className="h-2.5 w-2.5 flex-shrink-0 rounded-full"
            style={{ background: node.tag.color || "var(--primary)" }}
          />
          <span className="min-w-0 flex-1 truncate">
            {getTagDisplayName(node.tag.name, language)}
          </span>
          <span className="ml-1 flex-shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
            {node.tag.photoCount}
          </span>
        </button>
      </div>
    );

    return hasChildren && isExpanded
      ? [
          row,
          ...renderTagTree(
            node.children,
            depth + 1,
            expandedIds,
            onToggle,
            activeIds,
            onSelect,
            onContextMenu,
            onDragOver,
            onDragEnter,
            onDragLeave,
            onDrop,
            dragOverId,
            language
          ),
        ]
      : [row];
  });
}
