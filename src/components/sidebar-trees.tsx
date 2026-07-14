import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight } from "lucide-react";
import type React from "react";
import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { getTagDisplayName } from "@/localization/tag-display";
import type { Folder as FolderType } from "@/types/photo";
import { FolderBadge } from "./FolderBadge";

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

export interface FolderTreeNode {
  children: FolderTreeNode[];
  folder: FolderType;
}

export interface VisibleFolderNode {
  ancestorContinuations: Array<number | null>;
  depth: number;
  isLastSibling: boolean;
  node: FolderTreeNode;
}

const FOLDER_INDENT_PX = 12;
const MAX_VISIBLE_FOLDER_DEPTH = 6;
const VIRTUAL_FOLDER_THRESHOLD = 200;
const folderNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function markReachableFolderNodes(
  startingNodes: FolderTreeNode[],
  reachableIds: Set<number>
) {
  const stack = [...startingNodes];
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || reachableIds.has(node.folder.id)) {
      continue;
    }
    reachableIds.add(node.folder.id);
    stack.push(...node.children);
  }
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

  const reachableIds = new Set<number>();
  markReachableFolderNodes(roots, reachableIds);
  for (const node of nodeMap.values()) {
    if (!reachableIds.has(node.folder.id)) {
      roots.push(node);
      markReachableFolderNodes([node], reachableIds);
    }
  }

  const compareNodes = (a: FolderTreeNode, b: FolderTreeNode) =>
    folderNameCollator.compare(a.folder.displayName, b.folder.displayName) ||
    a.folder.path.localeCompare(b.folder.path);
  roots.sort(compareNodes);
  for (const node of nodeMap.values()) {
    node.children.sort(compareNodes);
  }
  return roots;
}

export function flattenVisibleFolderTree(
  nodes: FolderTreeNode[],
  expandedIds: Set<number>
): VisibleFolderNode[] {
  const visible: VisibleFolderNode[] = [];
  const visited = new Set<number>();
  const stack: VisibleFolderNode[] = [];
  for (let index = nodes.length - 1; index >= 0; index--) {
    stack.push({
      ancestorContinuations: [],
      depth: 0,
      isLastSibling: index === nodes.length - 1,
      node: nodes[index],
    });
  }

  while (stack.length > 0) {
    const item = stack.pop();
    if (!item || visited.has(item.node.folder.id)) {
      continue;
    }
    visited.add(item.node.folder.id);
    visible.push(item);

    if (expandedIds.has(item.node.folder.id)) {
      for (let index = item.node.children.length - 1; index >= 0; index--) {
        stack.push({
          ancestorContinuations:
            item.depth === 0
              ? []
              : [
                  ...item.ancestorContinuations,
                  item.isLastSibling ? null : item.node.folder.id,
                ],
          depth: item.depth + 1,
          isLastSibling: index === item.node.children.length - 1,
          node: item.node.children[index],
        });
      }
    }
  }

  return visible;
}

interface FolderTreeProps {
  activeId: number | null;
  dragOverId: number | null;
  expandedIds: Set<number>;
  label: string;
  nodes: FolderTreeNode[];
  onContextMenu: (e: React.MouseEvent, id: number, name: string) => void;
  onDragLeave: () => void;
  onDragOver: (e: React.DragEvent, id: number) => void;
  onDrop: (e: React.DragEvent, id: number) => void;
  onSelect: (id: number) => void;
  onToggle: (id: number) => void;
}

export function FolderTree({
  activeId,
  dragOverId,
  expandedIds,
  label,
  nodes,
  onContextMenu,
  onDragLeave,
  onDragOver,
  onDrop,
  onSelect,
  onToggle,
}: FolderTreeProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingFocusRef = useRef(false);
  const visibleNodes = useMemo(
    () => flattenVisibleFolderTree(nodes, expandedIds),
    [expandedIds, nodes]
  );
  const [focusedId, setFocusedId] = useState<number | null>(
    activeId ?? visibleNodes[0]?.node.folder.id ?? null
  );
  const shouldVirtualize = visibleNodes.length > VIRTUAL_FOLDER_THRESHOLD;
  const virtualizer = useVirtualizer({
    count: shouldVirtualize ? visibleNodes.length : 0,
    estimateSize: () => 32,
    getItemKey: (index) => visibleNodes[index].node.folder.id,
    getScrollElement: () => scrollRef.current,
    overscan: 8,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const virtualStartIndex = virtualItems[0]?.index ?? -1;
  const virtualEndIndex = virtualItems.at(-1)?.index ?? -1;

  useEffect(() => {
    if (visibleNodes.some((item) => item.node.folder.id === focusedId)) {
      return;
    }
    setFocusedId(activeId ?? visibleNodes[0]?.node.folder.id ?? null);
  }, [activeId, focusedId, visibleNodes]);

  useEffect(() => {
    if (!(pendingFocusRef.current && focusedId !== null)) {
      return;
    }
    const index = visibleNodes.findIndex(
      (item) => item.node.folder.id === focusedId
    );
    if (index < 0) {
      return;
    }
    const targetIsOutsideVirtualRange =
      shouldVirtualize &&
      (index < virtualStartIndex || index > virtualEndIndex);
    if (targetIsOutsideVirtualRange) {
      virtualizer.scrollToIndex(index, { align: "auto" });
      return;
    }
    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-folder-id="${focusedId}"]`
    );
    if (element) {
      element.focus();
      pendingFocusRef.current = false;
    }
  }, [
    focusedId,
    shouldVirtualize,
    virtualEndIndex,
    virtualizer,
    virtualStartIndex,
    visibleNodes,
  ]);

  function focusFolder(id: number) {
    pendingFocusRef.current = true;
    setFocusedId(id);
  }

  function handleHorizontalKey(key: string, node: FolderTreeNode): boolean {
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.folder.id);
    if (key === "ArrowRight") {
      if (hasChildren && !isExpanded) {
        onToggle(node.folder.id);
      } else if (hasChildren) {
        focusFolder(node.children[0].folder.id);
      }
      return true;
    }
    if (key !== "ArrowLeft") {
      return false;
    }
    if (hasChildren && isExpanded) {
      onToggle(node.folder.id);
    } else if (node.folder.parentId !== null) {
      focusFolder(node.folder.parentId);
    }
    return true;
  }

  function handleKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number
  ) {
    const item = visibleNodes[index];
    if (!item) {
      return;
    }
    const { node } = item;

    const focusIndexByKey: Record<string, number> = {
      ArrowDown: index + 1,
      ArrowUp: index - 1,
      End: visibleNodes.length - 1,
      Home: 0,
    };
    const nextIndex = focusIndexByKey[event.key];
    if (nextIndex !== undefined) {
      event.preventDefault();
      const target = visibleNodes[nextIndex];
      if (target) {
        focusFolder(target.node.folder.id);
      }
      return;
    }
    if (handleHorizontalKey(event.key, node)) {
      event.preventDefault();
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(node.folder.id);
    }
  }

  function renderRow(item: VisibleFolderNode, index: number) {
    const { ancestorContinuations, depth, isLastSibling, node } = item;
    const hasChildren = node.children.length > 0;
    const isExpanded = expandedIds.has(node.folder.id);
    const isActive = activeId === node.folder.id;
    const isDragOver = dragOverId === node.folder.id;
    const visibleDepth = Math.min(depth, MAX_VISIBLE_FOLDER_DEPTH);

    return (
      <div className="flex h-8 items-center" key={node.folder.id}>
        <div
          aria-hidden="true"
          className="relative h-8 flex-shrink-0"
          style={{ width: visibleDepth * FOLDER_INDENT_PX + 20 }}
        >
          {Array.from(
            { length: Math.max(0, visibleDepth - 1) },
            (_, guideIndex) => {
              const ancestorId = ancestorContinuations[guideIndex];
              return ancestorId !== null && ancestorId !== undefined ? (
                <span
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-foreground/20"
                  data-tree-guide="ancestor"
                  key={ancestorId}
                  style={{
                    left: guideIndex * FOLDER_INDENT_PX + 10,
                  }}
                />
              ) : null;
            }
          )}
          {visibleDepth > 0 && (
            <>
              <span
                className={`pointer-events-none absolute top-0 w-px ${isActive ? "bg-primary/70" : "bg-foreground/25"}`}
                data-tree-guide="branch"
                style={{
                  height: isLastSibling ? "50%" : "100%",
                  left: (visibleDepth - 1) * FOLDER_INDENT_PX + 10,
                }}
              />
              <span
                className={`pointer-events-none absolute top-1/2 h-px ${isActive ? "bg-primary/70" : "bg-foreground/25"}`}
                data-tree-guide="elbow"
                style={{
                  left: (visibleDepth - 1) * FOLDER_INDENT_PX + 10,
                  width: FOLDER_INDENT_PX,
                }}
              />
            </>
          )}
          {hasChildren && (
            <button
              aria-hidden="true"
              className="absolute top-1.5 flex h-5 w-5 items-center justify-center rounded-[4px] text-muted-foreground/70 hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                onToggle(node.folder.id);
              }}
              style={{ left: visibleDepth * FOLDER_INDENT_PX }}
              tabIndex={-1}
              type="button"
            >
              <ChevronRight
                className={`h-3 w-3 transition-transform ${isExpanded ? "rotate-90" : ""}`}
              />
            </button>
          )}
        </div>
        <button
          aria-expanded={hasChildren ? isExpanded : undefined}
          aria-level={depth + 1}
          aria-selected={isActive}
          className={`${getTreeRowClassName({
            activeClassName: "nav-item-active bg-primary/15 text-primary",
            isActive,
            isDragOver,
          })} px-2.5 py-1.5 text-[13px]`}
          data-folder-id={node.folder.id}
          onClick={() => onSelect(node.folder.id)}
          onContextMenu={(event) =>
            onContextMenu(event, node.folder.id, node.folder.displayName)
          }
          onDragLeave={onDragLeave}
          onDragOver={(event) => onDragOver(event, node.folder.id)}
          onDrop={(event) => onDrop(event, node.folder.id)}
          onFocus={() => setFocusedId(node.folder.id)}
          onKeyDown={(event) => handleKeyDown(event, index)}
          role="treeitem"
          tabIndex={focusedId === node.folder.id ? 0 : -1}
          title={node.folder.path}
          type="button"
        >
          {depth > MAX_VISIBLE_FOLDER_DEPTH && (
            <span aria-hidden="true" className="text-muted-foreground/50">
              …
            </span>
          )}
          <FolderBadge folder={node.folder} />
          <span className="min-w-0 flex-1 truncate">
            {node.folder.displayName}
          </span>
          <span className="ml-1 flex-shrink-0 text-[10px] text-muted-foreground/70 tabular-nums">
            {node.folder.totalPhotoCount ?? node.folder.photoCount}
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      aria-label={label}
      className="min-h-0 flex-1 overflow-y-auto"
      data-virtualized={shouldVirtualize}
      ref={scrollRef}
      role="tree"
    >
      {shouldVirtualize ? (
        <div
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
        >
          {virtualItems.map((virtualRow) => {
            const item = visibleNodes[virtualRow.index];
            return (
              <div
                key={item.node.folder.id}
                style={{
                  left: 0,
                  position: "absolute",
                  top: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  width: "100%",
                }}
              >
                {renderRow(item, virtualRow.index)}
              </div>
            );
          })}
        </div>
      ) : (
        visibleNodes.map(renderRow)
      )}
    </div>
  );
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
