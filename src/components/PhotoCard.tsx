import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import type { SearchMatch } from "@/types/photo";

interface PhotoCardProps {
  deleting?: boolean;
  dominantColors?: string | null;
  filename: string;
  getDragIds?: (id: number) => number[];
  height: number;
  id: number;
  isFavorite?: boolean;
  isSelected: boolean;
  loading?: "eager" | "lazy";
  onClick: (id: number, event: React.MouseEvent) => void;
  onDoubleClick: (id: number) => void;
  onToggleFavorite?: (id: number) => void;
  path: string;
  renderImage?: boolean;
  searchQuery?: string;
  match?: SearchMatch;
  thumbnailSmallPath?: string | null;
  thumbnailPath: string | null;
  width: number;
}

interface PhotoCardImageProps {
  filename: string;
  hasThumbnail: boolean;
  height: number;
  loading: "eager" | "lazy";
  onError: () => void;
  renderImage: boolean;
  srcSet?: string;
  url: string;
  width: number;
}

const SINGLE_CLICK_DELAY_MS = 250;

/**
 * 向后兼容的无操作函数。
 *
 * 旧版 PhotoCard 使用自定义 imageLoadState 缓存来控制图片加载状态；
 * 重构后完全依赖浏览器原生 HTTP 缓存和 <img> 生命周期。
 * 保留此导出以避免现有 import 语句编译报错。
 * 缓存刷新由 HTTP Cache-Control 头和 TanStack Query 的数据失效机制接管。
 */
export function clearImageLoadCache(): void {
  // no-op：缓存由浏览器原生层和 QueryClient 管理
}

function HighlightText({ text, query }: { text: string; query?: string }) {
  if (!query) {
    return <>{text}</>;
  }
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-[4px] bg-primary/40 text-foreground">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

function PhotoCardImage({
  filename,
  hasThumbnail,
  height,
  loading,
  onError,
  renderImage,
  srcSet,
  url,
  width,
}: PhotoCardImageProps) {
  const [loaded, setLoaded] = useState(false);

  if (!(hasThumbnail && renderImage)) {
    return (
      <div className="absolute inset-0 bg-muted/70">
        <div className="absolute inset-0 bg-gradient-to-br from-foreground/[0.03] to-transparent" />
      </div>
    );
  }

  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: image load state controls the thumbnail reveal transition
    <img
      alt={filename}
      className={`h-full w-full object-cover transition-opacity duration-150 motion-reduce:transition-none ${
        loaded ? "opacity-100" : "opacity-0"
      }`}
      data-load-state={loaded ? "loaded" : "loading"}
      decoding="async"
      fetchPriority={loading === "eager" ? "high" : "auto"}
      height={height || undefined}
      loading={loading}
      onError={onError}
      onLoad={() => setLoaded(true)}
      sizes="(max-width: 900px) 160px, 220px"
      src={url}
      srcSet={srcSet}
      width={width || undefined}
    />
  );
}

export const PhotoCard = memo(function PhotoCard({
  id,
  path,
  thumbnailPath,
  thumbnailSmallPath,
  loading = "lazy",
  dominantColors,
  filename,
  width,
  height,
  isSelected,
  getDragIds,
  isFavorite,
  deleting,
  searchQuery,
  match,
  renderImage = true,
  onClick,
  onDoubleClick,
  onToggleFavorite,
}: PhotoCardProps) {
  const { t } = useTranslation();
  const hasThumbnail = Boolean(thumbnailPath);

  // ── URL 计算 ──────────────────────────────────────────────────────
  // toLocalMediaUrl 现在是同步函数（端口由 preload 在窗口创建时注入），
  // URL 在组件生命周期内稳定不变。
  const [retryCount, setRetryCount] = useState(0);
  const url = useMemo(() => {
    const base = thumbnailPath ? toLocalMediaUrl(thumbnailPath) : "";
    return retryCount > 0 ? `${base}?retry=${retryCount}` : base;
  }, [thumbnailPath, retryCount]);
  const srcSet = useMemo(() => {
    if (!(thumbnailSmallPath && thumbnailPath)) {
      return undefined;
    }
    const smallUrl = toLocalMediaUrl(thumbnailSmallPath);
    const mediumUrl = toLocalMediaUrl(thumbnailPath);
    return `${smallUrl} 256w, ${mediumUrl} 512w`;
  }, [thumbnailSmallPath, thumbnailPath]);

  const [imgError, setImgError] = useState(false);

  // ── 主色提取 ──────────────────────────────────────────────────────
  const bgColor = useMemo(() => {
    if (!dominantColors) {
      return undefined;
    }
    try {
      const colors: { hex: string; weight: number }[] =
        JSON.parse(dominantColors);
      if (colors.length > 0) {
        return colors[0].hex;
      }
    } catch {
      /* corrupt JSON — fall back */
    }
    return undefined;
  }, [dominantColors]);

  const searchMatchLabel = useMemo(() => {
    if (!match) {
      return null;
    }
    if (match.kind === "color") {
      return t("searchMatchColor", { value: Math.round(match.score * 100) });
    }
    if (match.kind === "semantic") {
      return t("searchMatchSemantic");
    }
    if (match.kind === "hybrid") {
      if (
        match.evidence.includes("semantic") &&
        match.evidence.includes("tag")
      ) {
        return t("searchMatchHybrid");
      }
      if (match.evidence.includes("tag")) {
        return t("searchMatchExactTag");
      }
      return t("searchMatchSemantic");
    }
    if (match.kind === "tagFilter") {
      return match.origin === "auto"
        ? t("searchMatchAutoTag")
        : t("searchMatchExactTag");
    }
    if (match.kind === "image") {
      return t("searchMatchSimilarity", {
        value: Math.round(match.score * 100),
      });
    }
    if (match.source === "person") {
      return t("searchMatchExactPerson");
    }
    if (match.source === "tag") {
      return t("searchMatchExactTag");
    }
    return t("searchMatchExactFilename");
  }, [match, t]);

  // ── 事件处理 ──────────────────────────────────────────────────────
  const starRef = useRef<HTMLButtonElement>(null);
  const clickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPendingClick = useCallback(() => {
    if (clickTimerRef.current !== null) {
      clearTimeout(clickTimerRef.current);
      clickTimerRef.current = null;
    }
  }, []);

  useEffect(() => cancelPendingClick, [cancelPendingClick]);

  const handleDragStart = useCallback(
    (e: React.DragEvent) => {
      // Ctrl+drag → native file drag to desktop
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        (window as any).electronAPI?.startDrag?.(path);
        return;
      }
      const ids = getDragIds?.(id) ?? [id];
      e.dataTransfer.setData("application/x-photo-ids", JSON.stringify(ids));
      e.dataTransfer.effectAllowed = "move";

      // Custom drag ghost with count badge
      if (ids.length > 1) {
        const ghost = document.createElement("div");
        ghost.style.cssText =
          "position:fixed;top:-200px;left:-200px;display:flex;align-items:center;gap:6px;padding:6px 10px;background:rgba(30,30,34,0.92);border-radius:8px;border:1px solid rgba(255,255,255,0.1);backdrop-filter:blur(4px);color:#f7f8f8;font-size:12px;font-weight:510;white-space:nowrap;";
        ghost.textContent = t("photoCountLabel", { count: ids.length });
        document.body.appendChild(ghost);
        e.dataTransfer.setDragImage(ghost, 0, 0);
        requestAnimationFrame(() => document.body.removeChild(ghost));
      }
    },
    [id, path, getDragIds, t]
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      cancelPendingClick();
      clickTimerRef.current = setTimeout(() => {
        clickTimerRef.current = null;
        onClick(id, e);
      }, SINGLE_CLICK_DELAY_MS);
    },
    [cancelPendingClick, id, onClick]
  );

  const handleDoubleClick = useCallback(() => {
    cancelPendingClick();
    onDoubleClick(id);
  }, [cancelPendingClick, id, onDoubleClick]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        onDoubleClick(id);
      } else if (e.key === " ") {
        e.preventDefault();
        onClick(id, e as unknown as React.MouseEvent);
      }
    },
    [id, onClick, onDoubleClick]
  );

  const handleImageError = useCallback(() => {
    recordGalleryMediaStat("photoCardImageError");
    setImgError(true);
  }, []);

  // Clamp extreme aspect ratios for visual consistency
  const rawAspect = width && height ? width / height : 4 / 3;
  const aspectRatio = Math.max(0.6, Math.min(rawAspect, 3.0));

  if (!renderImage) {
    return (
      <div
        aria-hidden="true"
        className="relative w-full overflow-hidden rounded-[8px] bg-muted"
        data-photo-id={id}
        data-photo-path={path}
        style={{
          aspectRatio,
          ...(bgColor ? { backgroundColor: bgColor } : {}),
        }}
      />
    );
  }

  // ── 错误状态 ──────────────────────────────────────────────────────
  if (imgError) {
    return (
      <div
        className="relative flex w-full flex-col items-center justify-center gap-2 overflow-hidden rounded-[8px] bg-muted"
        style={{ aspectRatio }}
      >
        <svg
          fill="none"
          height="32"
          stroke="#6b6b75"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.5"
          viewBox="0 0 24 24"
          width="32"
        >
          <rect height="18" rx="2" ry="2" width="18" x="3" y="3" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <polyline points="21 15 16 10 5 21" />
        </svg>
        <span className="max-w-full truncate px-2 text-[10px] text-muted-foreground/70">
          {filename}
        </span>
        <button
          className="rounded-[4px] bg-primary/10 px-2 py-0.5 text-[10px] text-primary hover:bg-primary/20"
          onClick={(e) => {
            e.stopPropagation();
            setImgError(false);
            setRetryCount((c) => c + 1);
          }}
          type="button"
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  // ── 正常渲染 ──────────────────────────────────────────────────────
  return (
    <div
      aria-selected={isSelected}
      className={`group relative w-full cursor-pointer overflow-hidden rounded-[8px] bg-muted transition-[transform,opacity,box-shadow] duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 ${
        deleting
          ? "scale-95 opacity-0 duration-180"
          : isSelected
            ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
            : "hover:-translate-y-0.5 hover:shadow-lg hover:ring-1 hover:ring-foreground/10 hover:brightness-110"
      }
      `}
      data-photo-id={id}
      data-photo-path={path}
      draggable
      onClick={handleClick}
      onContextMenu={undefined}
      onDoubleClick={handleDoubleClick}
      onDragStart={handleDragStart}
      onKeyDown={handleKeyDown}
      role="option"
      style={{
        aspectRatio,
        ...(bgColor ? { backgroundColor: bgColor } : {}),
      }}
      tabIndex={-1}
    >
      <PhotoCardImage
        filename={filename}
        hasThumbnail={hasThumbnail}
        height={height}
        key={url}
        loading={loading}
        onError={handleImageError}
        renderImage={renderImage}
        srcSet={srcSet}
        url={url}
        width={width}
      />

      {/* Hover overlay */}
      <div className="absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
        <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/70 via-black/30 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 px-2.5 pb-2">
          <p className="truncate font-medium text-[#f7f8f8] text-[11px] leading-tight">
            <HighlightText query={searchQuery} text={filename} />
          </p>
          {width > 0 && height > 0 && (
            <p className="mt-0.5 text-[10px] text-muted-foreground">
              {width} × {height}
            </p>
          )}
        </div>
      </div>

      {/* Favorite star */}
      {onToggleFavorite && (
        <button
          aria-label={isFavorite ? t("unfavorite") : t("favorite")}
          aria-pressed={isFavorite}
          className={`absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded-full transition-opacity ${
            isFavorite
              ? "opacity-100"
              : "hover:!opacity-100 opacity-0 group-hover:opacity-70"
          }`}
          onClick={(e) => {
            e.stopPropagation();
            if (starRef.current) {
              starRef.current.classList.remove("animate-star-bounce");
              void starRef.current.offsetWidth;
              starRef.current.classList.add("animate-star-bounce");
            }
            onToggleFavorite(id);
          }}
        >
          <svg
            className={`h-4 w-4 drop-shadow-sm ${isFavorite ? "fill-yellow-400 text-yellow-400" : "fill-transparent text-white"}`}
            fill="currentFill"
            stroke="currentColor"
            strokeWidth="2"
            viewBox="0 0 24 24"
          >
            <path
              d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      )}

      {searchMatchLabel && (
        <div className="absolute top-2 left-2 rounded-[4px] bg-primary/80 px-1.5 py-0.5 font-medium text-[10px] text-white backdrop-blur-sm">
          {searchMatchLabel}
        </div>
      )}

      {/* Selection indicator */}
      {isSelected && (
        <div className="absolute top-2 right-2 flex h-5 w-5 items-center justify-center rounded-full bg-primary ring-1 ring-primary-foreground/20">
          <svg fill="none" height="12" viewBox="0 0 12 12" width="12">
            <path
              d="M2.5 6L5 8.5L9.5 3.5"
              stroke="white"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2"
            />
          </svg>
        </div>
      )}
    </div>
  );
});
