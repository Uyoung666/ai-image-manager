import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  toDuelPreviewUrl,
  toLocalMediaUrl,
  toPreviewUrl,
} from "@/utils/local-media-url";

// RAW 文件扩展名集合（与 raw-preview.ts 保持同步）
const RAW_EXTENSIONS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".srf",
  ".sr2",
  ".dng",
  ".orf",
  ".rw2",
  ".raf",
  ".pef",
  ".rwl",
  ".3fr",
  ".raw",
]);

function isRawExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return RAW_EXTENSIONS.has(ext);
}

// ── 缩放常量 ──────────────────────────────────────────────────────
const MIN_SCALE = 0.25;
const MAX_SCALE = 8;
const WHEEL_FACTOR = 1.15;
const PINCH_FACTOR = 120; // 触控板捏合灵敏度
const INERTIA_FRICTION = 0.94;
const INERTIA_THRESHOLD = 0.3;
const OVERSCROLL_MARGIN = 0.3; // 允许拖出边界的比例

// ── 渐进式加载常量 ────────────────────────────────────────────────
const ZOOM_UPGRADE_RATIO = 0.9; // 显示像素 > 预览像素 × ratio → 加载原图
const ZOOM_DOWNGRADE_RATIO = 0.7; // 显示像素 < 预览像素 × ratio → 释放原图
const ORIGINAL_RELEASE_DELAY = 5000; // 缩小后 5s 释放原图内存

// ── ZoomableImage Props ──────────────────────────────────────────

export interface ZoomState {
  scale: number;
  translate: { x: number; y: number };
}

interface ZoomableImageProps {
  alt: string;
  filePath: string;
  /** 对比预览路径（2560px JPEG），PK 选片专用 */
  duelPreviewPath?: string | null;
  /** 启用三级渐进式加载（默认 false，完全向后兼容） */
  enableProgressiveLoading?: boolean;
  /** 缩放时自动加载原图（仅在 progressive 模式下生效） */
  enableOriginalOnZoom?: boolean;
  fillContainer?: boolean;
  onError?: () => void;
  onSync?: (state: ZoomState) => void;
  syncState?: ZoomState | null;
  thumbnailPath?: string | null;
}

// ── 图片加载来源状态机 ──────────────────────────────────────────
// RAW 文件降级链：preview（内嵌 JPEG）→ image（sharp 转换）→ error
// 非 RAW 文件：image（直出或转换）→ error

type ImageSource = "preview" | "image" | "error";

// ── 渐进式加载层级状态 ───────────────────────────────────────────
type ProgressiveTier = "thumbnail" | "preview" | "original";

export const ZoomableImage = memo(function ZoomableImage({
  alt,
  filePath,
  duelPreviewPath,
  enableProgressiveLoading = false,
  enableOriginalOnZoom = false,
  thumbnailPath,
  fillContainer: _fillContainer,
  syncState,
  onSync,
  onError,
}: ZoomableImageProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);

  const [source, setSource] = useState<ImageSource>(() =>
    isRawExtension(filePath) ? "preview" : "image"
  );

  // ── Ref 防护：确保 handleImageError 始终读取最新 source 值 ────
  const sourceRef = useRef<ImageSource>(source);
  sourceRef.current = source;

  const [scale, setScale] = useState(1);
  const [translate, setTranslate] = useState({ x: 0, y: 0 });

  const scaleRef = useRef(1);
  const translateRef = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);
  const didDrag = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });
  const applyingSync = useRef(false);
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;

  // ── DOM ref 用于尺寸测量与边界计算 ─────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  // ── 惯性滚动状态 ───────────────────────────────────────────────
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastMoveTimeRef = useRef(0);
  const inertiaRafRef = useRef<number | null>(null);

  // 拖拽中禁用 CSS transition 以保证跟手，松手后恢复以驱动回弹
  const [isDragging, setIsDragging] = useState(false);

  // ── 渐进式加载状态 ─────────────────────────────────────────────
  const [activeTier, setActiveTier] = useState<ProgressiveTier>("thumbnail");
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalError, setOriginalError] = useState(false);

  const previewImgRef = useRef<HTMLImageElement>(null);
  const originalImgRef = useRef<HTMLImageElement>(null);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originalAbortRef = useRef<AbortController | null>(null);
  // 记录原图是否需要重新加载（释放后再次缩放触发时）
  const shouldReloadOriginalRef = useRef(false);

  scaleRef.current = scale;
  translateRef.current = translate;

  const fireSync = useCallback(() => {
    if (!applyingSync.current && onSyncRef.current) {
      onSyncRef.current({
        scale: scaleRef.current,
        translate: { ...translateRef.current },
      });
    }
  }, []);

  useEffect(() => {
    if (!syncState) {
      return;
    }
    applyingSync.current = true;
    setScale(syncState.scale);
    setTranslate(syncState.translate);
    scaleRef.current = syncState.scale;
    translateRef.current = syncState.translate;
    requestAnimationFrame(() => {
      applyingSync.current = false;
    });
  }, [syncState]);

  // ── 边界约束 ──────────────────────────────────────────────────

  // 渐进模式下使用当前激活层的 img ref
  const getActiveImgRef = useCallback(() => {
    if (!enableProgressiveLoading) {
      return imgRef.current;
    }
    if (activeTier === "original") {
      return originalImgRef.current;
    }
    return previewImgRef.current || imgRef.current;
  }, [enableProgressiveLoading, activeTier]);

  const getFitSize = useCallback(() => {
    const container = containerRef.current;
    const img = getActiveImgRef();
    if (!(container && img)) {
      return null;
    }
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw <= 0 || nh <= 0) {
      return null;
    }

    // object-fit: contain — 等比缩放以适配容器，不放大
    const s = Math.min(1, cw / nw, ch / nh);
    return { w: nw * s, h: nh * s };
  }, [getActiveImgRef]);

  const clampToBounds = useCallback(
    (tx: number, ty: number, s: number) => {
      const fit = getFitSize();
      if (!fit || s < 1.001) {
        return { x: 0, y: 0 };
      }

      const cw = containerRef.current!.clientWidth;
      const ch = containerRef.current!.clientHeight;
      const displayW = fit.w * s;
      const displayH = fit.h * s;

      const clamp1D = (
        v: number,
        displaySize: number,
        containerSize: number
      ) => {
        if (displaySize <= containerSize) {
          return 0; // 居中
        }
        const halfC = containerSize / 2;
        const halfD = displaySize / 2;
        const margin = containerSize * OVERSCROLL_MARGIN;
        const min = halfC - margin - halfD;
        const max = halfD - halfC + margin;
        return Math.min(max, Math.max(min, v));
      };

      return {
        x: clamp1D(tx, displayW, cw),
        y: clamp1D(ty, displayH, ch),
      };
    },
    [getFitSize]
  );

  // ── 惯性动画 ──────────────────────────────────────────────────

  const cancelInertia = useCallback(() => {
    if (inertiaRafRef.current !== null) {
      cancelAnimationFrame(inertiaRafRef.current);
      inertiaRafRef.current = null;
    }
  }, []);

  const startInertia = useCallback(() => {
    cancelInertia();

    function step() {
      const v = velocityRef.current;
      v.x *= INERTIA_FRICTION;
      v.y *= INERTIA_FRICTION;

      const speed = Math.sqrt(v.x * v.x + v.y * v.y);

      if (speed < INERTIA_THRESHOLD) {
        setIsDragging(false);
        const clamped = clampToBounds(
          translateRef.current.x,
          translateRef.current.y,
          scaleRef.current
        );
        setTranslate(clamped);
        translateRef.current = clamped;
        inertiaRafRef.current = null;
        setTimeout(() => fireSync(), 0);
        return;
      }

      const rawX = translateRef.current.x + v.x;
      const rawY = translateRef.current.y + v.y;

      if (speed < INERTIA_THRESHOLD * 8) {
        const clamped = clampToBounds(rawX, rawY, scaleRef.current);
        const t = 1 - speed / (INERTIA_THRESHOLD * 8);
        const easedX = rawX + (clamped.x - rawX) * t;
        const easedY = rawY + (clamped.y - rawY) * t;
        setTranslate({ x: easedX, y: easedY });
        translateRef.current = { x: easedX, y: easedY };
      } else {
        setTranslate({ x: rawX, y: rawY });
        translateRef.current = { x: rawX, y: rawY };
      }

      inertiaRafRef.current = requestAnimationFrame(step);
    }

    inertiaRafRef.current = requestAnimationFrame(step);
  }, [cancelInertia, clampToBounds, fireSync]);

  // ── 渐进式加载：缩放触发原图加载 ──────────────────────────────

  const startOriginalLoad = useCallback(() => {
    if (!enableOriginalOnZoom) return;
    if (originalLoaded || originalLoading) return;
    if (originalError) return;

    setOriginalLoading(true);

    // 取消之前的释放计时器
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
    }

    // 取消之前的加载
    if (originalAbortRef.current) {
      originalAbortRef.current.abort();
    }

    shouldReloadOriginalRef.current = false;
    const controller = new AbortController();
    originalAbortRef.current = controller;

    const img = new Image();
    img.onload = () => {
      if (controller.signal.aborted) return;
      setOriginalLoaded(true);
      setOriginalLoading(false);
      setActiveTier("original");
    };
    img.onerror = () => {
      if (controller.signal.aborted) return;
      setOriginalError(true);
      setOriginalLoading(false);
    };
    // 原图走 /image 路由
    img.src = toLocalMediaUrl(filePath);
  }, [
    enableOriginalOnZoom,
    filePath,
    originalLoaded,
    originalLoading,
    originalError,
  ]);

  const scheduleOriginalRelease = useCallback(() => {
    if (releaseTimerRef.current) {
      clearTimeout(releaseTimerRef.current);
    }
    releaseTimerRef.current = setTimeout(() => {
      // 取消加载中的请求
      if (originalAbortRef.current) {
        originalAbortRef.current.abort();
        originalAbortRef.current = null;
      }
      setOriginalLoading(false);
      setOriginalLoaded(false);
      setOriginalError(false);
      shouldReloadOriginalRef.current = true;
      setActiveTier("preview");
    }, ORIGINAL_RELEASE_DELAY);
  }, []);

  // 监听缩放，触发原图加载/释放
  useEffect(() => {
    if (!(enableProgressiveLoading && enableOriginalOnZoom)) return;
    if (!previewLoaded) return;

    const fit = getFitSize();
    if (!fit) return;

    const displayPixels = Math.max(fit.w, fit.h) * scale;
    // 对比预览短边约 2560px / aspectRatio，这里用长边估算
    const previewNativePixels = 2560; // 对比预览长边

    if (displayPixels > previewNativePixels * ZOOM_UPGRADE_RATIO) {
      startOriginalLoad();
    } else if (
      (originalLoaded || originalLoading) &&
      displayPixels < previewNativePixels * ZOOM_DOWNGRADE_RATIO
    ) {
      scheduleOriginalRelease();
    }
  }, [
    scale,
    enableProgressiveLoading,
    enableOriginalOnZoom,
    previewLoaded,
    originalLoaded,
    originalLoading,
    getFitSize,
    startOriginalLoad,
    scheduleOriginalRelease,
  ]);

  // 清理释放计时器
  useEffect(() => {
    return () => {
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
      }
      if (originalAbortRef.current) {
        originalAbortRef.current.abort();
      }
    };
  }, []);

  // ── 交互处理 ──────────────────────────────────────────────────

  const handleClick = useCallback(
    (_e: React.MouseEvent) => {
      if (didDrag.current) {
        didDrag.current = false;
        return;
      }
      if (onSync && scaleRef.current > 1) {
        cancelInertia();
        setScale(1);
        setTranslate({ x: 0, y: 0 });
        scaleRef.current = 1;
        translateRef.current = { x: 0, y: 0 };
        setIsDragging(false);
        setTimeout(() => fireSync(), 0);
      }
    },
    [onSync, fireSync, cancelInertia]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      cancelInertia();

      const s = scaleRef.current;

      if (s > 1.05) {
        setScale(1);
        setTranslate({ x: 0, y: 0 });
        scaleRef.current = 1;
        translateRef.current = { x: 0, y: 0 };
        setIsDragging(false);
        setTimeout(() => fireSync(), 0);
        return;
      }

      // fit → 100% 像素
      const img = getActiveImgRef();
      const container = containerRef.current;
      if (!(img && container)) {
        return;
      }

      const naturalW = img.naturalWidth;
      if (naturalW <= 0) {
        return;
      }

      const containerW = container.clientWidth;
      const containerH = container.clientHeight;
      const containerRatio = containerW / containerH;
      const imageRatio = naturalW / (img.naturalHeight || 1);
      let fitW: number;
      if (imageRatio > containerRatio) {
        fitW = containerW;
      } else {
        fitW = containerH * imageRatio;
      }

      const targetScale = Math.min(MAX_SCALE, Math.max(1.1, naturalW / fitW));

      const clamped = clampToBounds(0, 0, targetScale);

      setScale(targetScale);
      setTranslate(clamped);
      scaleRef.current = targetScale;
      translateRef.current = clamped;
      setIsDragging(false);
      setTimeout(() => fireSync(), 0);
    },
    [fireSync, cancelInertia, clampToBounds, getActiveImgRef]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      cancelInertia();

      const rect = e.currentTarget.getBoundingClientRect();
      const relX = e.clientX - rect.left - rect.width / 2;
      const relY = e.clientY - rect.top - rect.height / 2;

      let newScale: number;

      if (e.ctrlKey) {
        newScale = scaleRef.current - e.deltaY / PINCH_FACTOR;
        newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
      } else {
        const direction = e.deltaY < 0 ? 1 : -1;
        newScale =
          direction > 0
            ? scaleRef.current * WHEEL_FACTOR
            : scaleRef.current / WHEEL_FACTOR;
        newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
      }

      const ratio = newScale / scaleRef.current;
      const rawTx = relX - ratio * (relX - translateRef.current.x);
      const rawTy = relY - ratio * (relY - translateRef.current.y);

      setScale(newScale);
      scaleRef.current = newScale;

      if (newScale <= 1.001) {
        setTranslate({ x: 0, y: 0 });
        translateRef.current = { x: 0, y: 0 };
        setIsDragging(false);
      } else {
        const clamped = clampToBounds(rawTx, rawTy, newScale);
        setTranslate(clamped);
        translateRef.current = clamped;
        setIsDragging(false);
      }
      setTimeout(() => fireSync(), 0);
    },
    [fireSync, cancelInertia, clampToBounds]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (scaleRef.current <= 1) {
        return;
      }
      e.preventDefault();
      cancelInertia();
      dragging.current = true;
      setIsDragging(true);
      didDrag.current = false;
      lastPos.current = { x: e.clientX, y: e.clientY };
      lastMoveTimeRef.current = performance.now();
      velocityRef.current = { x: 0, y: 0 };
    },
    [cancelInertia]
  );

  useEffect(() => {
    function onMove(e: MouseEvent) {
      if (!dragging.current) {
        return;
      }
      const dx = e.clientX - lastPos.current.x;
      const dy = e.clientY - lastPos.current.y;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        didDrag.current = true;
      }

      const now = performance.now();
      const dt = now - lastMoveTimeRef.current;
      if (dt > 0) {
        velocityRef.current = {
          x: (dx / dt) * 16,
          y: (dy / dt) * 16,
        };
      }
      lastMoveTimeRef.current = now;
      lastPos.current = { x: e.clientX, y: e.clientY };

      setTranslate((prev) => {
        const next = { x: prev.x + dx, y: prev.y + dy };
        translateRef.current = next;
        return next;
      });
    }

    function onUp() {
      if (!dragging.current) {
        return;
      }
      dragging.current = false;

      const speed = Math.sqrt(
        velocityRef.current.x ** 2 + velocityRef.current.y ** 2
      );

      if (speed > 2) {
        startInertia();
      } else {
        setIsDragging(false);
        const clamped = clampToBounds(
          translateRef.current.x,
          translateRef.current.y,
          scaleRef.current
        );
        setTranslate(clamped);
        translateRef.current = clamped;
        setTimeout(() => fireSync(), 0);
      }
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fireSync, startInertia, clampToBounds]);

  const isZoomed = scale > 1;
  const imgTransform = `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`;

  // ── URL 构造（legacy 模式）────────────────────────────────────
  const src = (() => {
    if (source === "preview") {
      return toPreviewUrl(filePath);
    }
    return toLocalMediaUrl(thumbnailPath ?? filePath);
  })();

  // ── 渐进式模式 URL 构造 ────────────────────────────────────────
  const tier1Src = toLocalMediaUrl(thumbnailPath ?? filePath);
  // Tier 2：有对比预览用 duel-preview 路由，否则回退到原图
  const tier2Src = duelPreviewPath
    ? toDuelPreviewUrl(duelPreviewPath)
    : toLocalMediaUrl(filePath);
  const tier3Src = toLocalMediaUrl(filePath);

  // ── 降级链：ref 驱动，杜绝闭包过期竞态 ─────────────────────────
  const handleImageError = useCallback(() => {
    const cur = sourceRef.current;

    if (cur === "preview") {
      sourceRef.current = "image";
      setSource("image");
      setLoaded(false);
      return;
    }

    if (cur === "image") {
      sourceRef.current = "error";
      setSource("error");
      setHasError(true);
      onError?.();
      return;
    }
  }, [onError]);

  // ── 渐进式模式：Tier 加载回调 ──────────────────────────────────
  const handlePreviewLoad = useCallback(() => {
    setPreviewLoaded(true);
    setActiveTier("preview");
  }, []);

  // ── 错误状态 UI ─────────────────────────────────────────────────
  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-[11px]">{t("cullImageLoadError")}</span>
      </div>
    );
  }

  // ── 渐进式渲染（PK 选片用）────────────────────────────────────
  if (enableProgressiveLoading) {
    // 确定当前应显示的图片源
    const currentSrc = (() => {
      if (originalLoaded && activeTier === "original") return tier3Src;
      if (previewLoaded) return tier2Src;
      return tier1Src;
    })();

    // 是否仍在等待更优画质
    const isUpgrading =
      (!previewLoaded && !previewError) || originalLoading;

    return (
      <div
        className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[6px]"
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        ref={containerRef}
      >
        {/* 使用与 legacy 完全一致的渲染方式的单一 img 标签 */}
        <img
          alt={alt}
          className={`max-h-full max-w-full select-none rounded-[6px] object-contain shadow-lg transition-all duration-150 ease-out ${
            previewLoaded || originalLoaded ? "opacity-100" : "opacity-100"
          } ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
          draggable={false}
          onError={() => {
            // 加载失败时尝试降级
            if (activeTier === "original") {
              setOriginalError(true);
              setOriginalLoading(false);
              setActiveTier("preview");
            } else if (!previewLoaded) {
              setPreviewError(true);
            } else {
              onError?.();
            }
          }}
          onLoad={() => {
            if (!previewLoaded && !previewError) {
              setPreviewLoaded(true);
              setActiveTier("preview");
            }
            if (originalLoading) {
              setOriginalLoaded(true);
              setOriginalLoading(false);
              setActiveTier("original");
            }
          }}
          onMouseDown={handleMouseDown}
          ref={imgRef}
          src={currentSrc}
          style={{
            transform: imgTransform,
            willChange: isZoomed ? "transform" : "auto",
            transition: isDragging ? "none" : undefined,
          }}
        />

        {/* 加载指示器 */}
        {isUpgrading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden rounded-[6px]">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
          </div>
        )}

        {/* 缩放百分比标签 */}
        {isZoomed && (
          <div className="pointer-events-none absolute top-2 right-2 z-10 rounded-[4px] bg-black/60 px-1.5 py-0.5 text-[10px] text-white/70">
            {Math.round(scale * 100)}%
          </div>
        )}
      </div>
    );
  }

  // ── 传统渲染（网格/灯箱/快速预览用，行为完全不变）─────────────
  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[6px]"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
      ref={containerRef}
    >
      <img
        alt={alt}
        className={`max-h-full max-w-full select-none rounded-[6px] object-contain shadow-lg transition-all duration-150 ease-out ${
          loaded ? "opacity-100" : "opacity-0"
        } ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
        draggable={false}
        onError={handleImageError}
        onLoad={() => setLoaded(true)}
        onMouseDown={handleMouseDown}
        ref={imgRef}
        src={src}
        style={{
          transform: imgTransform,
          willChange: isZoomed ? "transform" : "auto",
          transition: isDragging ? "none" : undefined,
        }}
      />

      {!(loaded || hasError) && (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-[6px]">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary/30 border-t-primary" />
        </div>
      )}

      {isZoomed && (
        <div className="pointer-events-none absolute top-2 right-2 rounded-[4px] bg-black/60 px-1.5 py-0.5 text-[10px] text-white/70">
          {Math.round(scale * 100)}%
        </div>
      )}
    </div>
  );
});
