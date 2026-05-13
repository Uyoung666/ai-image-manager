import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GroupHeader } from "./MasonryGrid";
import { MasonryGrid } from "./MasonryGrid";
import { PhotoCard } from "./PhotoCard";
import { SortDropdown } from "./SortDropdown";
import { Skeleton } from "./ui/skeleton";

interface Photo {
  fileDate?: number | null;
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isFavorite?: boolean;
  isIndexed: boolean;
  path: string;
  similarity?: number;
  thumbnailPath: string | null;
  width: number;
}
export type SortField = "date" | "name" | "size";
export type SortOrder = "asc" | "desc";

interface PhotoGridProps {
  loading: boolean;
  onContextMenu: (e: React.MouseEvent) => void;
  onConvertSelected?: () => void;
  onDeleteSelected?: () => void;
  onDoubleClick: (id: number) => void;
  onEndReached?: () => void;
  onExportSelected?: () => void;
  onRenameSelected?: () => void;
  onSelect: (id: number, event: React.MouseEvent) => void;
  onSortChange?: (sort: SortField, order: SortOrder) => void;
  onToggleFavorite?: (id: number) => void;
  photos: Photo[];
  searchQuery?: string;
  selectedIds: Set<number>;
  sort?: SortField;
  sortOrder?: SortOrder;
}

const DENSITY_CONFIGS = [
  { label: "小", targetColWidth: 160 },
  { label: "中", targetColWidth: 220 },
  { label: "大", targetColWidth: 280 },
];

const MIN_COLUMNS = 2;
const GAP = 8;

export function PhotoGrid({
  photos,
  loading,
  selectedIds,
  searchQuery,
  sort = "date",
  sortOrder = "desc",
  onSelect,
  onDoubleClick,
  onContextMenu,
  onConvertSelected,
  onDeleteSelected,
  onEndReached,
  onExportSelected,
  onRenameSelected,
  onSortChange,
  onToggleFavorite,
}: PhotoGridProps) {
  const { t } = useTranslation();
  const [densityIdx, setDensityIdx] = useState(1);
  const [columnCount, setColumnCount] = useState(4);
  const [compact, setCompact] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const targetColWidth = DENSITY_CONFIGS[densityIdx].targetColWidth;
  const targetColWidthRef = useRef(targetColWidth);
  targetColWidthRef.current = targetColWidth;

  const containerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    containerRef.current = node;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setContainerWidth(width);
      const cols = Math.max(MIN_COLUMNS, Math.floor(width / targetColWidthRef.current));
      setColumnCount(cols);
      setCompact(width < 500);
    });
    observer.observe(node);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const cols = Math.max(MIN_COLUMNS, Math.floor(containerWidth / targetColWidth));
    setColumnCount(cols);
  }, [targetColWidth, containerWidth]);

  const skeletonAspects = useCallback(
    () => [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3],
    [],
  );

  const renderItem = useCallback(
    (photo: Photo) => (
      <PhotoCard
        filename={photo.filename}
        height={photo.height}
        id={photo.id}
        isFavorite={photo.isFavorite}
        isSelected={selectedIds.has(photo.id)}
        onClick={onSelect}
        onDoubleClick={onDoubleClick}
        onToggleFavorite={onToggleFavorite}
        path={photo.path}
        searchQuery={searchQuery}
        similarity={photo.similarity}
        thumbnailPath={photo.thumbnailPath}
        width={photo.width}
      />
    ),
    [selectedIds, onSelect, onDoubleClick, onToggleFavorite, searchQuery],
  );

  const masonryItems = useMemo(
    () =>
      photos.map((p) => ({
        ...p,
        width: p.width,
        height: p.height,
        id: p.id,
      })),
    [photos],
  );

  const groupHeaders = useMemo((): GroupHeader[] => {
    if (sort !== "date" || photos.length === 0) return [];
    const headers: GroupHeader[] = [];
    let lastKey = "";
    for (let i = 0; i < photos.length; i++) {
      const ts = photos[i].fileDate;
      if (!ts) continue;
      const d = new Date(ts);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      if (key !== lastKey) {
        lastKey = key;
        headers.push({
          beforeIndex: i,
          label: `${d.getFullYear()}年${d.getMonth() + 1}月`,
        });
      }
    }
    return headers;
  }, [photos, sort]);

  if (loading && photos.length === 0) {
    const skelCols = Array.from({ length: columnCount }, (_, ci) =>
      Array.from({ length: 3 }, (_, ri) => ci * 3 + ri),
    );
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <Skeleton className="h-4 w-24 bg-card" />
          <div className="flex items-center gap-1">
            {DENSITY_CONFIGS.map((cfg) => (
              <Skeleton
                className="h-5 w-6 rounded-[4px] bg-card"
                key={cfg.label}
              />
            ))}
          </div>
        </div>
        <div className="flex-1 overflow-y-auto px-2 pt-2">
          <div className="flex gap-2">
            {skelCols.map((items, ci) => (
              <div className="flex flex-1 flex-col gap-2" key={ci}>
                {items.map((i) => (
                  <Skeleton
                    className="w-full rounded-[8px] bg-muted"
                    key={i}
                    style={{
                      aspectRatio:
                        skeletonAspects()[i % skeletonAspects().length],
                    }}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!loading && photos.length === 0) {
    return (
      <div className="flex flex-1 flex-col">
        <div className="flex items-center justify-between border-border border-b px-4 py-2">
          <span className="truncate text-[12px] text-muted-foreground">
            {t("photosCount", { count: 0 })}
          </span>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <span className="text-[#6b6b75] text-[13px]">{t("noPhotos")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex items-center justify-between border-border border-b px-4 py-2">
        <span className="truncate text-[12px] text-muted-foreground">
          {t("photosCount", { count: photos.length.toLocaleString() })}
          {selectedIds.size > 0 &&
            t("photosSelected", { count: selectedIds.size })}
        </span>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && onRenameSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/5"
              onClick={onRenameSelected}
            >
              {compact ? "重命名" : `重命名 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onConvertSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/5"
              onClick={onConvertSelected}
            >
              {compact ? "转换" : `格式转换 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onExportSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[11px] text-foreground transition-colors hover:bg-foreground/5"
              onClick={onExportSelected}
            >
              {compact ? "导出" : `导出选中 (${selectedIds.size})`}
            </button>
          )}
          {selectedIds.size > 0 && onDeleteSelected && (
            <button
              className="rounded-[4px] px-2 py-1 text-[#e5484d] text-[11px] transition-colors hover:bg-[#e5484d]/10"
              onClick={onDeleteSelected}
            >
              {compact
                ? `-${selectedIds.size}`
                : `删除选中 (${selectedIds.size})`}
            </button>
          )}
          {!compact && onSortChange && (
            <SortDropdown
              onChange={onSortChange}
              order={sortOrder}
              sort={sort}
            />
          )}
          {!compact && (
            <div className="flex items-center gap-1">
              {DENSITY_CONFIGS.map((cfg, i) => (
                <button
                  className={`rounded-[4px] px-2 py-1 text-[11px] transition-colors ${
                    i === densityIdx
                      ? "bg-primary/20 text-primary"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  }`}
                  key={cfg.label}
                  onClick={() => setDensityIdx(i)}
                >
                  {cfg.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Masonry grid */}
      <div className="min-h-0 flex-1" onContextMenu={onContextMenu} ref={containerCallbackRef}>
        <MasonryGrid
          className="scrollbar-thin px-2 pt-2"
          columnCount={columnCount}
          containerWidth={containerWidth - 16}
          gap={GAP}
          groupHeaders={groupHeaders}
          items={masonryItems}
          onEndReached={onEndReached}
          renderItem={renderItem}
        />
      </div>

      {/* Loading overlay */}
      {loading && photos.length > 0 && (
        <div className="pointer-events-none absolute top-[41px] right-0 bottom-0 left-0 flex items-start justify-center bg-background/30 pt-4">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}
    </div>
  );
}
