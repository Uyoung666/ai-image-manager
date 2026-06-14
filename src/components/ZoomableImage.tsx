import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toLocalMediaUrl, toPreviewUrl } from "@/utils/local-media-url";

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

// ── ZoomableImage Props ──────────────────────────────────────────

export interface ZoomState {
  scale: number;
  translate: { x: number; y: number };
}

interface ZoomableImageProps {
  alt: string;
  filePath: string;
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

export const ZoomableImage = memo(function ZoomableImage({
  alt,
  filePath,
  thumbnailPath,
  fillContainer,
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
  // tx=0 为居中；显示尺寸 > 容器时允许 30% 越界，超出硬截断

  const getFitSize = useCallback(() => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!container || !img) return null;
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    if (nw <= 0 || nh <= 0) return null;

    // object-fit: contain — 等比缩放以适配容器，不放大
    const scale = Math.min(1, cw / nw, ch / nh);
    return { w: nw * scale, h: nh * scale };
  }, []);

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

      const clamp1D = (v: number, displaySize: number, containerSize: number) => {
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
        // 惯性结束 → 回弹到合法边界
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

      // 接近停止时开始软性回弹（过渡到 clamp 值）
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

  // ── 交互处理 ──────────────────────────────────────────────────

  const handleClick = useCallback(
    (_e: React.MouseEvent) => {
      if (didDrag.current) {
        didDrag.current = false;
        return;
      }
      // 仅在已缩放且需要同步时（PK 模式）回弹到 100%
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
        // 已缩放 → 回到 fit
        setScale(1);
        setTranslate({ x: 0, y: 0 });
        scaleRef.current = 1;
        translateRef.current = { x: 0, y: 0 };
        setIsDragging(false);
        setTimeout(() => fireSync(), 0);
        return;
      }

      // fit → 100% 像素（1:1 像素映射）
      const img = imgRef.current;
      const container = containerRef.current;
      if (!img || !container) return;

      const naturalW = img.naturalWidth;
      if (naturalW <= 0) return;

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
    [fireSync, cancelInertia, clampToBounds]
  );

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      cancelInertia();

      const rect = e.currentTarget.getBoundingClientRect();
      // 光标相对于容器中心的偏移
      const relX = e.clientX - rect.left - rect.width / 2;
      const relY = e.clientY - rect.top - rect.height / 2;

      let newScale: number;

      if (e.ctrlKey) {
        // ── 触控板捏合手势（Chromium ctrlKey + wheel）──────────
        newScale = scaleRef.current - e.deltaY / PINCH_FACTOR;
        newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
      } else {
        // ── 鼠标滚轮缩放 ────────────────────────────────────────
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
        // 归一化到 16ms 帧以消除帧率波动
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
        // 有足够初速度 → 惯性滑行（结束时自动回弹）
        startInertia();
      } else {
        // 无明显速度 → 直接回弹
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

  // ── URL 构造 ────────────────────────────────────────────────────
  const src = (() => {
    if (source === "preview") {
      return toPreviewUrl(filePath);
    }
    return toLocalMediaUrl(thumbnailPath ?? filePath);
  })();

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

  // ── 错误状态 UI ─────────────────────────────────────────────────
  if (hasError) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 text-muted-foreground">
        <span className="text-[11px]">{t("cullImageLoadError")}</span>
      </div>
    );
  }

  // ── 正常渲染 ────────────────────────────────────────────────────
  return (
    <div
      ref={containerRef}
      className="relative flex h-full w-full items-center justify-center overflow-hidden rounded-[6px]"
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onWheel={handleWheel}
    >
      {/* 纯 opacity 硬切。拖拽中用 inline style 禁用 transition 保证跟手，
          松手后恢复 CSS transition 以驱动回弹和缩放平滑过渡。 */}
      <img
        ref={imgRef}
        alt={alt}
        className={`max-h-full max-w-full select-none rounded-[6px] object-contain shadow-lg transition-all duration-150 ease-out ${
          loaded ? "opacity-100" : "opacity-0"
        } ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
        draggable={false}
        onError={handleImageError}
        onLoad={() => setLoaded(true)}
        onMouseDown={handleMouseDown}
        src={src}
        style={{
          transform: imgTransform,
          willChange: isZoomed ? "transform" : "auto",
          transition: isDragging ? "none" : undefined,
        }}
      />

      {/* 轻量加载指示器 */}
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
