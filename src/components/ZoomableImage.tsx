import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
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

function supportsOriginalZoom(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return [".jpg", ".jpeg", ".png", ".webp", ".avif"].includes(ext);
}

// ── 缩放常量 ──────────────────────────────────────────────────────
const MIN_SCALE = 0.25;
const FIT_SCALE = 1; // 滚轮缩放下限（匹配 Windows Photos：滚轮到 fit 即停）
const MAX_SCALE = 8;
const WHEEL_FACTOR = 1.15;
const PINCH_FACTOR = 120; // 触控板捏合灵敏度
const INERTIA_FRICTION = 0.94;
const INERTIA_THRESHOLD = 0.3;
const OVERSCROLL_MARGIN = 0.3; // 允许拖出边界的比例

// ── 渐进式加载常量 ────────────────────────────────────────────────
const ORIGINAL_UPGRADE_PIXELS = 4096;
const ORIGINAL_DOWNGRADE_PIXELS = 3072;
const ORIGINAL_RELEASE_DELAY = 5000; // 缩小后 5s 释放原图内存

// ── ZoomableImage Props ──────────────────────────────────────────

export interface ZoomState {
  scale: number;
  translate: { x: number; y: number };
}

export interface ZoomableImageHandle {
  applySync: (state: ZoomState) => void;
}

interface ZoomableImageProps {
  alt: string;
  /** 对比预览路径（2560px JPEG），PK 选片专用 */
  duelPreviewPath?: string | null;
  /** 缩放时自动加载原图（仅在 progressive 模式下生效） */
  enableOriginalOnZoom?: boolean;
  /** 启用三级渐进式加载（默认 false，完全向后兼容） */
  enableProgressiveLoading?: boolean;
  filePath: string;
  fillContainer?: boolean;
  onError?: () => void;
  onSync?: (state: ZoomState) => void;
  thumbnailPath?: string | null;
  /** 预览策略已确认可直接使用原图（小尺寸浏览器原生格式） */
  useOriginalAsPreview?: boolean;
}

// ── 图片加载来源状态机 ──────────────────────────────────────────
// RAW 文件降级链：preview（内嵌 JPEG）→ image（sharp 转换）→ error
// 非 RAW 文件：image（直出或转换）→ error

type ImageSource = "preview" | "image" | "error";

// ── 渐进式加载层级状态 ───────────────────────────────────────────
type ProgressiveTier = "thumbnail" | "preview" | "original";

interface ZoomGeometry {
  containerHeight: number;
  containerWidth: number;
  fitHeight: number;
  fitWidth: number;
  naturalHeight: number;
  naturalWidth: number;
}

const ZoomableImageComponent = forwardRef<
  ZoomableImageHandle,
  ZoomableImageProps
>(function ZoomableImage(
  {
    alt,
    filePath,
    duelPreviewPath,
    enableProgressiveLoading = false,
    enableOriginalOnZoom = false,
    thumbnailPath,
    useOriginalAsPreview = false,
    fillContainer: _fillContainer,
    onSync,
    onError,
  },
  ref
) {
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
  const geometryRef = useRef<ZoomGeometry | null>(null);

  // ── 惯性滚动状态 ───────────────────────────────────────────────
  const velocityRef = useRef({ x: 0, y: 0 });
  const lastMoveTimeRef = useRef(0);
  const inertiaRafRef = useRef<number | null>(null);
  const transformRafRef = useRef<number | null>(null);
  const transformNeedsSyncRef = useRef(false);
  const wheelEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncEndTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 拖拽中禁用 CSS transition 以保证跟手，松手后恢复以驱动回弹
  const [isDragging, setIsDragging] = useState(false);

  // ── 渐进式加载状态 ─────────────────────────────────────────────
  const [activeTier, setActiveTier] = useState<ProgressiveTier>("thumbnail");
  const [previewLoaded, setPreviewLoaded] = useState(false);
  const [originalLoaded, setOriginalLoaded] = useState(false);
  const [previewError, setPreviewError] = useState(false);
  const [originalLoading, setOriginalLoading] = useState(false);
  const [originalError, setOriginalError] = useState(false);

  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originalAbortRef = useRef<AbortController | null>(null);
  const originalPreloadRef = useRef<HTMLImageElement | null>(null);
  const shouldReloadOriginalRef = useRef(false);

  const fireSync = useCallback(() => {
    if (!applyingSync.current && onSyncRef.current) {
      onSyncRef.current({
        scale: scaleRef.current,
        translate: { ...translateRef.current },
      });
    }
  }, []);

  const queueTransform = useCallback(
    (
      nextScale: number,
      nextTranslate: { x: number; y: number },
      syncOnFrame = false
    ) => {
      scaleRef.current = nextScale;
      translateRef.current = nextTranslate;
      transformNeedsSyncRef.current ||= syncOnFrame;

      if (transformRafRef.current !== null) {
        return;
      }

      transformRafRef.current = requestAnimationFrame(() => {
        transformRafRef.current = null;
        const image = imgRef.current;
        if (image) {
          const currentScale = scaleRef.current;
          const currentTranslate = translateRef.current;
          image.style.transform = `scale(${currentScale}) translate(${currentTranslate.x / currentScale}px, ${currentTranslate.y / currentScale}px)`;
          image.style.willChange =
            enableProgressiveLoading || currentScale > 1 ? "transform" : "auto";
          image.style.boxShadow = currentScale > 1 ? "none" : "";
        }
        if (transformNeedsSyncRef.current) {
          transformNeedsSyncRef.current = false;
          fireSync();
        }
      });
    },
    [enableProgressiveLoading, fireSync]
  );

  useImperativeHandle(
    ref,
    () => ({
      applySync(state) {
        applyingSync.current = true;
        const image = imgRef.current;
        if (image) {
          image.style.transition = "none";
        }
        queueTransform(state.scale, state.translate);
        if (syncEndTimerRef.current) {
          clearTimeout(syncEndTimerRef.current);
        }
        syncEndTimerRef.current = setTimeout(() => {
          setScale(scaleRef.current);
          setTranslate(translateRef.current);
          applyingSync.current = false;
        }, 120);
      },
    }),
    [queueTransform]
  );

  // ── 边界约束 ──────────────────────────────────────────────────

  const measureGeometry = useCallback(() => {
    const container = containerRef.current;
    const img = imgRef.current;
    if (!(container && img)) {
      geometryRef.current = null;
      return;
    }
    const containerWidth = container.clientWidth;
    const containerHeight = container.clientHeight;
    const naturalWidth = img.naturalWidth;
    const naturalHeight = img.naturalHeight;
    if (naturalWidth <= 0 || naturalHeight <= 0) {
      geometryRef.current = null;
      return;
    }

    const fitScale = Math.min(
      1,
      containerWidth / naturalWidth,
      containerHeight / naturalHeight
    );
    geometryRef.current = {
      containerHeight,
      containerWidth,
      fitHeight: naturalHeight * fitScale,
      fitWidth: naturalWidth * fitScale,
      naturalHeight,
      naturalWidth,
    };
  }, []);

  const getFitSize = useCallback(() => {
    const geometry = geometryRef.current;
    return geometry ? { w: geometry.fitWidth, h: geometry.fitHeight } : null;
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measureGeometry);
    observer.observe(container);
    return () => observer.disconnect();
  }, [measureGeometry]);

  const clampToBounds = useCallback((tx: number, ty: number, s: number) => {
    const geometry = geometryRef.current;
    if (!geometry || s < 1.001) {
      return { x: 0, y: 0 };
    }

    const displayW = geometry.fitWidth * s;
    const displayH = geometry.fitHeight * s;

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
      x: clamp1D(tx, displayW, geometry.containerWidth),
      y: clamp1D(ty, displayH, geometry.containerHeight),
    };
  }, []);

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
        queueTransform(scaleRef.current, { x: easedX, y: easedY });
      } else {
        queueTransform(scaleRef.current, { x: rawX, y: rawY });
      }

      inertiaRafRef.current = requestAnimationFrame(step);
    }

    inertiaRafRef.current = requestAnimationFrame(step);
  }, [cancelInertia, clampToBounds, fireSync, queueTransform]);

  // ── 渐进式加载：缩放触发原图加载 ──────────────────────────────

  const startOriginalLoad = useCallback(() => {
    if (
      !enableOriginalOnZoom ||
      useOriginalAsPreview ||
      !supportsOriginalZoom(filePath)
    ) {
      return;
    }
    if (originalLoaded || originalLoading) {
      return;
    }
    if (originalError) {
      return;
    }

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
    originalPreloadRef.current = img;
    img.decoding = "async";
    img.onload = async () => {
      try {
        await img.decode();
      } catch {
        // onload 已确认资源可用；部分 Chromium 版本可能拒绝重复 decode。
      }
      if (controller.signal.aborted) {
        return;
      }
      const activateOriginal = () => {
        if (controller.signal.aborted) {
          return;
        }
        setOriginalLoaded(true);
        setOriginalLoading(false);
        setActiveTier("original");
      };
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(activateOriginal, { timeout: 800 });
      } else {
        setTimeout(activateOriginal, 0);
      }
    };
    img.onerror = () => {
      if (controller.signal.aborted) {
        return;
      }
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
    useOriginalAsPreview,
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
      if (originalPreloadRef.current) {
        originalPreloadRef.current.src = "";
        originalPreloadRef.current = null;
      }
      setOriginalLoading(false);
      setOriginalLoaded(false);
      setOriginalError(false);
      shouldReloadOriginalRef.current = true;
      setActiveTier("preview");
    }, ORIGINAL_RELEASE_DELAY);
  }, []);

  // 监听缩放，触发原图加载/释放（防抖，避免缩放/拖拽时频繁执行 DOM 读取）
  const zoomCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!(enableProgressiveLoading && enableOriginalOnZoom)) {
      return;
    }
    if (!previewLoaded) {
      return;
    }

    // 防抖 300ms：只在缩放/拖拽停止后才检查是否需要加载原图
    if (zoomCheckTimerRef.current) {
      clearTimeout(zoomCheckTimerRef.current);
    }
    zoomCheckTimerRef.current = setTimeout(() => {
      const fit = getFitSize();
      if (!fit) {
        return;
      }

      const displayPixels = Math.max(fit.w, fit.h) * scale;
      if (displayPixels > ORIGINAL_UPGRADE_PIXELS) {
        startOriginalLoad();
      } else if (
        (originalLoaded || originalLoading) &&
        displayPixels < ORIGINAL_DOWNGRADE_PIXELS
      ) {
        scheduleOriginalRelease();
      }
    }, 300);

    return () => {
      if (zoomCheckTimerRef.current) {
        clearTimeout(zoomCheckTimerRef.current);
      }
    };
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
      if (transformRafRef.current !== null) {
        cancelAnimationFrame(transformRafRef.current);
      }
      if (wheelEndTimerRef.current) {
        clearTimeout(wheelEndTimerRef.current);
      }
      if (syncEndTimerRef.current) {
        clearTimeout(syncEndTimerRef.current);
      }
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
      }
      if (originalAbortRef.current) {
        originalAbortRef.current.abort();
      }
      if (originalPreloadRef.current) {
        originalPreloadRef.current.src = "";
        originalPreloadRef.current = null;
      }
    };
  }, []);

  // ── 交互处理 ──────────────────────────────────────────────────

  const handleClick = useCallback((_e: React.MouseEvent) => {
    // 拖拽后不触发 click
    didDrag.current = false;
    // 与 Windows Photos 一致：单击不改变缩放状态
    // 缩放态单击留给拖拽平移使用，fit 态单击无操作
  }, []);

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
      const geometry = geometryRef.current;
      if (!geometry) {
        return;
      }

      const containerRatio = geometry.containerWidth / geometry.containerHeight;
      const imageRatio = geometry.naturalWidth / geometry.naturalHeight;
      let fitW: number;
      if (imageRatio > containerRatio) {
        fitW = geometry.containerWidth;
      } else {
        fitW = geometry.containerHeight * imageRatio;
      }

      const targetScale = Math.min(
        MAX_SCALE,
        Math.max(1.1, geometry.naturalWidth / fitW)
      );

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
      setIsDragging(true);

      if (wheelEndTimerRef.current) {
        clearTimeout(wheelEndTimerRef.current);
      }

      let newScale: number;

      if (e.ctrlKey) {
        // 触控板捏合 — 允许缩小到 MIN_SCALE（捏合精度高，不会误触）
        newScale = scaleRef.current - e.deltaY / PINCH_FACTOR;
        newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
      } else {
        // 鼠标滚轮 — 缩小到 FIT_SCALE 即停（匹配 Windows Photos）
        const direction = e.deltaY < 0 ? 1 : -1;
        newScale =
          direction > 0
            ? scaleRef.current * WHEEL_FACTOR
            : scaleRef.current / WHEEL_FACTOR;
        newScale = Math.min(MAX_SCALE, Math.max(FIT_SCALE, newScale));
      }

      // 视口中心缩放（匹配 Windows Photos / yet-another-react-lightbox）
      const ratio = newScale / scaleRef.current;
      const rawTx = translateRef.current.x * ratio;
      const rawTy = translateRef.current.y * ratio;

      if (newScale <= 1.001) {
        queueTransform(newScale, { x: 0, y: 0 }, true);
      } else {
        const clamped = clampToBounds(rawTx, rawTy, newScale);
        queueTransform(newScale, clamped, true);
      }
      wheelEndTimerRef.current = setTimeout(() => {
        setScale(scaleRef.current);
        setTranslate(translateRef.current);
        setIsDragging(false);
      }, 120);
    },
    [fireSync, cancelInertia, clampToBounds, queueTransform]
  );

  // ── 键盘缩放快捷键（+/-/0）────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // 输入框中不拦截
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }

      // 按 0 回到 fit
      if (e.key === "0" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        cancelInertia();
        setScale(1);
        setTranslate({ x: 0, y: 0 });
        scaleRef.current = 1;
        translateRef.current = { x: 0, y: 0 };
        setIsDragging(false);
        setTimeout(() => fireSync(), 0);
        return;
      }

      // + 或 = 放大
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        cancelInertia();
        const newScale = Math.min(MAX_SCALE, scaleRef.current * WHEEL_FACTOR);
        const ratio = newScale / scaleRef.current;
        setScale(newScale);
        scaleRef.current = newScale;
        const rawTx = translateRef.current.x * ratio;
        const rawTy = translateRef.current.y * ratio;
        const clamped = clampToBounds(rawTx, rawTy, newScale);
        setTranslate(clamped);
        translateRef.current = clamped;
        setIsDragging(false);
        setTimeout(() => fireSync(), 0);
        return;
      }

      // - 缩小（不低于 FIT_SCALE）
      if (e.key === "-") {
        e.preventDefault();
        cancelInertia();
        const newScale = Math.max(FIT_SCALE, scaleRef.current / WHEEL_FACTOR);
        const ratio = newScale / scaleRef.current;
        setScale(newScale);
        scaleRef.current = newScale;
        if (newScale <= 1.001) {
          setTranslate({ x: 0, y: 0 });
          translateRef.current = { x: 0, y: 0 };
        } else {
          const rawTx = translateRef.current.x * ratio;
          const rawTy = translateRef.current.y * ratio;
          const clamped = clampToBounds(rawTx, rawTy, newScale);
          setTranslate(clamped);
          translateRef.current = clamped;
        }
        setIsDragging(false);
        setTimeout(() => fireSync(), 0);
        return;
      }
    }

    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [cancelInertia, clampToBounds, fireSync]);

  // ── 鼠标拖拽 ──────────────────────────────────────────────────
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

      queueTransform(scaleRef.current, {
        x: translateRef.current.x + dx,
        y: translateRef.current.y + dy,
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
  }, [fireSync, startInertia, clampToBounds, queueTransform]);

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
  let tier2Src = tier1Src;
  if (duelPreviewPath) {
    tier2Src = toDuelPreviewUrl(duelPreviewPath);
  } else if (useOriginalAsPreview) {
    tier2Src = toLocalMediaUrl(filePath);
  }
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
      if (originalLoaded && activeTier === "original") {
        return tier3Src;
      }
      if (previewLoaded) {
        return tier2Src;
      }
      return tier1Src;
    })();

    // 是否仍在等待更优画质
    const isUpgrading = !(previewLoaded || previewError) || originalLoading;

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
          className={`max-h-full max-w-full select-none rounded-[6px] object-contain shadow-lg ${
            previewLoaded || originalLoaded ? "opacity-100" : "opacity-100"
          } ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
          draggable={false}
          onError={() => {
            // 加载失败时尝试降级
            if (activeTier === "original") {
              setOriginalError(true);
              setOriginalLoading(false);
              setActiveTier("preview");
            } else if (previewLoaded) {
              onError?.();
            } else {
              setPreviewError(true);
            }
          }}
          onLoad={() => {
            measureGeometry();
            if (!(previewLoaded || previewError)) {
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
            backfaceVisibility: "hidden",
            boxShadow: isZoomed ? "none" : undefined,
            transform: imgTransform,
            transformOrigin: "center center",
            willChange: "transform",
            transition: isDragging
              ? "none"
              : "transform 150ms cubic-bezier(0.16, 1, 0.3, 1)",
          }}
        />

        {/* 加载指示器 */}
        {isUpgrading && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden rounded-[6px]">
            <LoadingSpinner size="lg" variant="soft" />
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
        className={`max-h-full max-w-full select-none rounded-[6px] object-contain shadow-lg ${
          loaded ? "opacity-100" : "opacity-0"
        } ${isZoomed ? "cursor-grab active:cursor-grabbing" : ""}`}
        draggable={false}
        onError={handleImageError}
        onLoad={() => {
          measureGeometry();
          setLoaded(true);
        }}
        onMouseDown={handleMouseDown}
        ref={imgRef}
        src={src}
        style={{
          backfaceVisibility: "hidden",
          boxShadow: isZoomed ? "none" : undefined,
          transform: imgTransform,
          transformOrigin: "center center",
          willChange: isZoomed ? "transform" : "auto",
          transition: isDragging
            ? "none"
            : "transform 150ms cubic-bezier(0.16, 1, 0.3, 1)",
        }}
      />

      {!(loaded || hasError) && (
        <div className="absolute inset-0 flex items-center justify-center overflow-hidden rounded-[6px]">
          <LoadingSpinner size="lg" variant="soft" />
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

export const ZoomableImage = memo(ZoomableImageComponent);
