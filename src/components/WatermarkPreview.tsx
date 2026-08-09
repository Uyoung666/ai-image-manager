// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

// Module-level cache — survives page navigation so preview shows photo on first frame
let cachedSampleImg: HTMLImageElement | null = null;
let cachedSampleImgPath = "";

function colorWithAlpha(color: string, alpha: number) {
  const hex = color.startsWith("#") ? color.slice(1) : color;
  if (hex.length !== 6) {
    return color;
  }
  const channels = [0, 2, 4].map((offset) =>
    Number.parseInt(hex.slice(offset, offset + 2), 16)
  );
  return `rgba(${channels.join(",")},${alpha})`;
}

export type WmAnchor =
  | "topLeft"
  | "topCenter"
  | "topRight"
  | "centerLeft"
  | "center"
  | "centerRight"
  | "bottomLeft"
  | "bottomCenter"
  | "bottomRight";

export type WatermarkMode = "text" | "image";

export type WatermarkImageStatus = "empty" | "loading" | "ready" | "error";

export interface WatermarkPreviewSettings {
  anchor: WmAnchor;
  enabled: boolean;
  fontSize: number;
  imagePath?: string;
  imageScale: number;
  margin: number;
  mode: WatermarkMode;
  opacity: number;
  text: string;
}

interface Props {
  onImageStatusChange?: (status: WatermarkImageStatus) => void;
  onSettingsChange: (patch: Partial<WatermarkPreviewSettings>) => void;
  samplePhotoDimensions?: { height?: number; width?: number };
  samplePhotoName?: string;
  samplePhotoPath?: string;
  wm: WatermarkPreviewSettings;
}

export const WATERMARK_ANCHORS: { anchor: WmAnchor; label?: string }[] = [
  { label: "↖", anchor: "topLeft" },
  { label: "↑", anchor: "topCenter" },
  { label: "↗", anchor: "topRight" },
  { label: "←", anchor: "centerLeft" },
  { label: "·", anchor: "center" },
  { label: "→", anchor: "centerRight" },
  { label: "↙", anchor: "bottomLeft" },
  { label: "↓", anchor: "bottomCenter" },
  { label: "↘", anchor: "bottomRight" },
];

type AnchorHorizontal = "left" | "center" | "right";
type AnchorVertical = "top" | "center" | "bottom";

function getAnchorAxes(anchor: WmAnchor): {
  horizontal: AnchorHorizontal;
  vertical: AnchorVertical;
} {
  let horizontal: AnchorHorizontal = "center";
  let vertical: AnchorVertical = "bottom";
  if (anchor.startsWith("top")) {
    vertical = "top";
  } else if (anchor.startsWith("center")) {
    vertical = "center";
  }
  if (anchor.endsWith("Left")) {
    horizontal = "left";
  } else if (anchor.endsWith("Right")) {
    horizontal = "right";
  }
  return { horizontal, vertical };
}

function getAnchorPoint(
  axis: AnchorHorizontal | AnchorVertical,
  margin: number,
  size: number
): number {
  if (axis === "left" || axis === "top") {
    return margin;
  }
  if (axis === "right" || axis === "bottom") {
    return size - margin;
  }
  return Math.round(size / 2);
}

function getWatermarkOrigin(
  axis: AnchorHorizontal | AnchorVertical,
  point: number,
  watermarkSize: number
): number {
  if (axis === "left" || axis === "top") {
    return point;
  }
  if (axis === "right" || axis === "bottom") {
    return point - watermarkSize;
  }
  return point - watermarkSize / 2;
}

export function WatermarkAnchorGlyph({
  active,
  anchor,
}: {
  active: boolean;
  anchor: WmAnchor;
}) {
  const index = WATERMARK_ANCHORS.findIndex((item) => item.anchor === anchor);
  return (
    <span className="grid grid-cols-3 gap-[2px]">
      {WATERMARK_ANCHORS.map((item, itemIndex) => {
        let dotClass = "bg-muted-foreground/20";
        if (itemIndex === index) {
          dotClass = active ? "bg-primary" : "bg-muted-foreground";
        }
        return (
          <span
            className={`h-1.5 w-1.5 rounded-full transition-colors ${dotClass}`}
            key={item.anchor}
          />
        );
      })}
    </span>
  );
}

// Calculate watermark pixel position from anchor + margin.
// Margin is % of short edge — consistent visual gap across aspect ratios.
export function calcWmPosition(
  anchor: WmAnchor,
  margin: number,
  imgW: number,
  imgH: number,
  wmW: number,
  wmH: number
): { x: number; y: number } {
  const mp = Math.round((margin / 100) * Math.min(imgW, imgH));

  const { horizontal, vertical } = getAnchorAxes(anchor);
  const x = getWatermarkOrigin(
    horizontal,
    getAnchorPoint(horizontal, mp, imgW),
    wmW
  );
  const y = getWatermarkOrigin(
    vertical,
    getAnchorPoint(vertical, mp, imgH),
    wmH
  );

  return { x, y };
}

export function WatermarkPreview({
  wm,
  samplePhotoPath,
  samplePhotoName,
  samplePhotoDimensions,
  onImageStatusChange,
  onSettingsChange,
}: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pointerIdRef = useRef<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sampleImg, setSampleImg] = useState<HTMLImageElement | null>(
    samplePhotoPath && samplePhotoPath === cachedSampleImgPath
      ? cachedSampleImg
      : null
  );
  const [wmImg, setWmImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    if (!samplePhotoPath) {
      setSampleImg(null);
      setLoadError(false);
      return;
    }
    setLoadError(false);
    const img = new Image();
    img.onload = () => {
      cachedSampleImg = img;
      cachedSampleImgPath = samplePhotoPath;
      setSampleImg(img);
    };
    img.onerror = () => setLoadError(true);
    img.src = `local-media://${samplePhotoPath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [samplePhotoPath]);

  useEffect(() => {
    if (!wm.imagePath) {
      setWmImg(null);
      onImageStatusChange?.("empty");
      return;
    }
    onImageStatusChange?.("loading");
    const img = new Image();
    img.onload = () => {
      setWmImg(img);
      onImageStatusChange?.("ready");
    };
    img.onerror = () => {
      setWmImg(null);
      onImageStatusChange?.("error");
    };
    img.src = `local-media://${wm.imagePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [onImageStatusChange, wm.imagePath]);

  // Draw preview
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }
    const primaryColor =
      getComputedStyle(canvas).getPropertyValue("--primary").trim() ||
      "#3a83f7";

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const cw = rect.width;
    const ch = rect.height;

    // Background
    if (sampleImg && !loadError) {
      const imgRatio = sampleImg.width / sampleImg.height;
      const canvasRatio = cw / ch;
      let sx = 0,
        sy = 0,
        sw = sampleImg.width,
        sh = sampleImg.height;
      if (imgRatio > canvasRatio) {
        sw = sampleImg.height * canvasRatio;
        sx = (sampleImg.width - sw) / 2;
      } else {
        sh = sampleImg.width / canvasRatio;
        sy = (sampleImg.height - sh) / 2;
      }
      ctx.drawImage(sampleImg, sx, sy, sw, sh, 0, 0, cw, ch);
    } else {
      const g = ctx.createLinearGradient(0, 0, cw, ch);
      g.addColorStop(0, "#1a1a2e");
      g.addColorStop(0.5, "#16213e");
      g.addColorStop(1, "#1a1a2e");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, cw, ch);
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      for (let x = 0; x < cw; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, ch);
        ctx.stroke();
      }
      for (let y = 0; y < ch; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(cw, y);
        ctx.stroke();
      }
    }

    // Resolve anchor to pixel point
    const mp = Math.round((wm.margin / 100) * Math.min(cw, ch));
    const a = wm.anchor;
    const { horizontal, vertical } = getAnchorAxes(a);
    const ax = getAnchorPoint(horizontal, mp, cw);
    const ay = getAnchorPoint(vertical, mp, ch);

    let wmW = 0,
      wmH = 0,
      wmX = 0,
      wmY = 0;

    const activeWmImg = wm.mode === "image" ? wmImg : null;

    if (activeWmImg) {
      const maxDim = Math.round(Math.min(cw, ch) * (wm.imageScale / 100));
      const ratio = activeWmImg.width / activeWmImg.height;
      if (ratio > 1) {
        wmW = maxDim;
        wmH = maxDim / ratio;
      } else {
        wmH = maxDim;
        wmW = maxDim * ratio;
      }
      // Position bounding box relative to anchor point
      wmX = getWatermarkOrigin(horizontal, ax, wmW);
      wmY = getWatermarkOrigin(vertical, ay, wmH);
    } else if (wm.mode === "text" && wm.text.trim()) {
      const fontSize = Math.max(10, Math.round((wm.fontSize / 72) * (cw / 4)));
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      const metrics = ctx.measureText(wm.text);
      wmW = metrics.width + 12;
      wmH = fontSize + 8;
      // Canvas text uses left/top coordinate from bounding box
      // anchor: ax,ay is the point text connects to
      wmX = getWatermarkOrigin(horizontal, ax, wmW);
      wmY = getWatermarkOrigin(vertical, ay, wmH);
    }

    // Reference lines while dragging
    if (dragging) {
      ctx.strokeStyle = colorWithAlpha(primaryColor, 0.3);
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(ax, 0);
      ctx.lineTo(ax, ch);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, ay);
      ctx.lineTo(cw, ay);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (activeWmImg) {
      ctx.globalAlpha = wm.opacity / 100;
      ctx.drawImage(activeWmImg, wmX, wmY, wmW, wmH);
      ctx.globalAlpha = 1;
      if (dragging) {
        ctx.strokeStyle = colorWithAlpha(primaryColor, 0.8);
        ctx.lineWidth = 1.5;
        ctx.strokeRect(wmX, wmY, wmW, wmH);
      }
    } else if (wm.text.trim()) {
      // Draw text at bounding box
      const fontSize = Math.max(10, Math.round((wm.fontSize / 72) * (cw / 4)));
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.globalAlpha = wm.opacity / 100;
      ctx.fillStyle = "white";
      ctx.fillText(wm.text, wmX + 6, wmY + 4);

      ctx.globalAlpha = dragging ? 0.6 : 0.12;
      ctx.strokeStyle = dragging
        ? colorWithAlpha(primaryColor, 0.8)
        : "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      ctx.strokeRect(wmX, wmY, wmW, wmH);
    }

    // Draw anchor point dot
    ctx.globalAlpha = 1;
    ctx.fillStyle = colorWithAlpha(primaryColor, 0.6);
    ctx.beginPath();
    ctx.arc(ax, ay, 3, 0, Math.PI * 2);
    ctx.fill();

    ctx.globalAlpha = 1;

    // Readout: anchor name + margin in pixels
    ctx.font = "10px Inter, system-ui, sans-serif";
    ctx.textAlign = "right";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.fillText(
      t("watermarkReadout", {
        anchor: t(`anchor_${wm.anchor}`),
        marginPx: mp,
        marginPct: wm.margin,
      }),
      cw - 8,
      ch - 8
    );
  }, [wm, sampleImg, wmImg, dragging, loadError, t]);

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const ro = new ResizeObserver(() => draw());
    if (containerRef.current) {
      ro.observe(containerRef.current);
    }
    return () => ro.disconnect();
  }, [draw]);

  function dragToAnchor(clientX: number, clientY: number) {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const cw = rect.width;
    const ch = rect.height;

    const approxW =
      wm.mode === "image" && wmImg
        ? Math.round(Math.min(cw, ch) * (wm.imageScale / 100))
        : cw * 0.12;
    const approxH = approxW;

    const candidates = WATERMARK_ANCHORS.map((a) => {
      const pos = calcWmPosition(a.anchor, 5, cw, ch, approxW, approxH);
      const cx = pos.x + approxW / 2,
        cy = pos.y + approxH / 2;
      return { anchor: a.anchor, dist: Math.hypot(cx - px, cy - py) };
    });
    candidates.sort((a, b) => a.dist - b.dist);

    const nearestAnchor = candidates[0].anchor;
    const pos = calcWmPosition(nearestAnchor, 0, cw, ch, approxW, approxH);
    const anchorCx = pos.x + approxW / 2;
    const anchorCy = pos.y + approxH / 2;
    const distPx = Math.hypot(anchorCx - px, anchorCy - py);
    const marginPct = Math.round(
      Math.max(2, Math.min(15, (distPx / Math.min(cw, ch)) * 100))
    );

    onSettingsChange({ anchor: nearestAnchor, margin: marginPct });
  }

  function handlePointerDown(e: ReactPointerEvent<HTMLCanvasElement>) {
    pointerIdRef.current = e.pointerId;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
    dragToAnchor(e.clientX, e.clientY);
  }
  function handlePointerMove(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (pointerIdRef.current !== e.pointerId || !dragging) {
      return;
    }
    dragToAnchor(e.clientX, e.clientY);
  }
  function handlePointerUp(e: ReactPointerEvent<HTMLCanvasElement>) {
    if (pointerIdRef.current === e.pointerId) {
      pointerIdRef.current = null;
    }
    setDragging(false);
  }

  function handleCanvasKeyDown(e: ReactKeyboardEvent<HTMLCanvasElement>) {
    const currentIndex = WATERMARK_ANCHORS.findIndex(
      (item) => item.anchor === wm.anchor
    );
    if (currentIndex < 0) {
      return;
    }

    const row = Math.floor(currentIndex / 3);
    const column = currentIndex % 3;
    let nextRow = row;
    let nextColumn = column;

    if (e.key === "ArrowUp") {
      nextRow -= 1;
    } else if (e.key === "ArrowDown") {
      nextRow += 1;
    } else if (e.key === "ArrowLeft") {
      nextColumn -= 1;
    } else if (e.key === "ArrowRight") {
      nextColumn += 1;
    } else {
      return;
    }

    if (nextRow < 0 || nextRow > 2 || nextColumn < 0 || nextColumn > 2) {
      return;
    }

    e.preventDefault();
    onSettingsChange({
      anchor: WATERMARK_ANCHORS[nextRow * 3 + nextColumn].anchor,
    });
  }

  const canvasCursorClass = dragging ? "cursor-grabbing" : "cursor-grab";

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-col items-start gap-1 rounded-t-[8px] border border-border border-b-0 bg-secondary px-3 py-2 min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between min-[900px]:gap-3">
        <span className="shrink-0 font-medium text-[12px] text-foreground">
          {t("watermarkLivePreview")}
        </span>
        <span className="min-w-0 max-w-full break-all text-[10px] text-muted-foreground/70 min-[900px]:text-right">
          {samplePhotoName || t("watermarkPreviewSample")}
          {samplePhotoDimensions?.width && samplePhotoDimensions.height
            ? ` · ${samplePhotoDimensions.width} × ${samplePhotoDimensions.height}`
            : ""}
        </span>
      </div>
      <div
        className="relative overflow-hidden rounded-b-[8px] border border-border bg-secondary"
        ref={containerRef}
        style={{ aspectRatio: "16 / 10" }}
      >
        <canvas
          aria-label={t("watermarkPreviewCanvasLabel")}
          className={`h-full w-full touch-none ${canvasCursorClass}`}
          onKeyDown={handleCanvasKeyDown}
          onPointerCancel={handlePointerUp}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          ref={canvasRef}
          style={{ display: "block" }}
          tabIndex={0}
        />
        {!samplePhotoPath && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="max-w-[calc(100%-1rem)] rounded-[6px] bg-background/70 px-3 py-1.5 text-center text-[11px] text-muted-foreground backdrop-blur-sm [overflow-wrap:anywhere]">
              {t("watermarkNoPreviewPhoto")}
            </span>
          </div>
        )}
        {wm.mode === "image" && wm.imagePath && !wmImg && !dragging && (
          <div className="pointer-events-none absolute right-3 bottom-3 left-3 rounded-[5px] bg-destructive/85 px-2 py-1 text-center text-[10px] text-white shadow-sm [overflow-wrap:anywhere]">
            {t("watermarkAssetError")}
          </div>
        )}
        {!wm.enabled && (
          <div className="pointer-events-none absolute top-2 left-2 max-w-[calc(100%-1rem)] rounded-[5px] bg-background/75 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur-sm [overflow-wrap:anywhere]">
            {t("watermarkPreviewDisabled")}
          </div>
        )}
        {!dragging && (
          <div className="pointer-events-none absolute top-2 right-2 max-w-[calc(100%-1rem)] rounded-[4px] bg-background/70 px-2 py-0.5 text-right text-[10px] text-foreground/70 backdrop-blur-sm [overflow-wrap:anywhere]">
            {t("orDragPreview")}
          </div>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="max-w-[calc(100%-1rem)] rounded-[4px] bg-primary/80 px-2 py-0.5 text-center text-[10px] text-white backdrop-blur-sm [overflow-wrap:anywhere]">
              {t("dragToPosition")}
            </span>
          </div>
        )}
      </div>
      <div
        aria-live="polite"
        className="flex min-w-0 flex-col items-start gap-1 text-[10px] text-muted-foreground/60 min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between min-[900px]:gap-3"
      >
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t("orDragPreview")}
        </span>
        <span className="min-w-0 [overflow-wrap:anywhere] min-[900px]:text-right">
          {t("watermarkReadout", {
            anchor: t(`anchor_${wm.anchor}`),
            marginPx: wm.margin,
            marginPct: wm.margin,
          })}
        </span>
      </div>
    </div>
  );
}
