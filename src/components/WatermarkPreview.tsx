import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// Module-level cache — survives page navigation so preview shows photo on first frame
let cachedSampleImg: HTMLImageElement | null = null;
let cachedSampleImgPath = "";

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

export interface WatermarkPreviewSettings {
  anchor: WmAnchor;
  enabled: boolean;
  fontSize: number;
  imagePath?: string;
  imageScale: number;
  margin: number;
  opacity: number;
  text: string;
}

interface Props {
  onSettingsChange: (patch: Partial<WatermarkPreviewSettings>) => void;
  samplePhotoPath?: string;
  wm: WatermarkPreviewSettings;
}

const ANCHORS: { label?: string; anchor: WmAnchor }[] = [
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

function AnchorGlyph({
  active,
  anchor,
}: {
  active: boolean;
  anchor: WmAnchor;
}) {
  const index = ANCHORS.findIndex((item) => item.anchor === anchor);
  return (
    <span className="grid grid-cols-3 gap-[2px]">
      {ANCHORS.map((item, itemIndex) => {
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

  // Parse anchor into horizontal + vertical components
  let h: "left" | "center" | "right";
  let v: "top" | "center" | "bottom";
  if (anchor === "topLeft") {
    h = "left";
    v = "top";
  } else if (anchor === "topCenter") {
    h = "center";
    v = "top";
  } else if (anchor === "topRight") {
    h = "right";
    v = "top";
  } else if (anchor === "centerLeft") {
    h = "left";
    v = "center";
  } else if (anchor === "center") {
    h = "center";
    v = "center";
  } else if (anchor === "centerRight") {
    h = "right";
    v = "center";
  } else if (anchor === "bottomLeft") {
    h = "left";
    v = "bottom";
  } else if (anchor === "bottomCenter") {
    h = "center";
    v = "bottom";
  } else {
    h = "right";
    v = "bottom";
  }

  let x: number;
  if (h === "left") {
    x = mp;
  } else if (h === "right") {
    x = imgW - wmW - mp;
  } else {
    x = Math.round((imgW - wmW) / 2);
  }

  let y: number;
  if (v === "top") {
    y = mp;
  } else if (v === "bottom") {
    y = imgH - wmH - mp;
  } else {
    y = Math.round((imgH - wmH) / 2);
  }

  return { x, y };
}

export function WatermarkPreview({
  wm,
  samplePhotoPath,
  onSettingsChange,
}: Props) {
  const { t } = useTranslation();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
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
      return;
    }
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
      return;
    }
    const img = new Image();
    img.onload = () => setWmImg(img);
    img.onerror = () => setWmImg(null);
    img.src = `local-media://${wm.imagePath.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")}`;
    return () => {
      img.onload = null;
      img.onerror = null;
    };
  }, [wm.imagePath]);

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
    let h: "left" | "center" | "right";
    let v: "top" | "center" | "bottom";
    const a = wm.anchor;
    if (a === "topLeft") {
      h = "left";
      v = "top";
    } else if (a === "topCenter") {
      h = "center";
      v = "top";
    } else if (a === "topRight") {
      h = "right";
      v = "top";
    } else if (a === "centerLeft") {
      h = "left";
      v = "center";
    } else if (a === "center") {
      h = "center";
      v = "center";
    } else if (a === "centerRight") {
      h = "right";
      v = "center";
    } else if (a === "bottomLeft") {
      h = "left";
      v = "bottom";
    } else if (a === "bottomCenter") {
      h = "center";
      v = "bottom";
    } else {
      h = "right";
      v = "bottom";
    }

    const ax = h === "left" ? mp : h === "right" ? cw - mp : Math.round(cw / 2);
    const ay = v === "top" ? mp : v === "bottom" ? ch - mp : Math.round(ch / 2);

    let wmW = 0,
      wmH = 0,
      wmX = 0,
      wmY = 0;

    if (wmImg) {
      const maxDim = Math.round(Math.min(cw, ch) * (wm.imageScale / 100));
      const ratio = wmImg.width / wmImg.height;
      if (ratio > 1) {
        wmW = maxDim;
        wmH = maxDim / ratio;
      } else {
        wmH = maxDim;
        wmW = maxDim * ratio;
      }
      // Position bounding box relative to anchor point
      wmX = h === "left" ? ax : h === "right" ? ax - wmW : ax - wmW / 2;
      wmY = v === "top" ? ay : v === "bottom" ? ay - wmH : ay - wmH / 2;
    } else if (wm.text.trim()) {
      const fontSize = Math.max(10, Math.round((wm.fontSize / 72) * (cw / 4)));
      ctx.font = `${fontSize}px Inter, system-ui, sans-serif`;
      const metrics = ctx.measureText(wm.text);
      wmW = metrics.width + 12;
      wmH = fontSize + 8;
      // Canvas text uses left/top coordinate from bounding box
      // anchor: ax,ay is the point text connects to
      wmX = h === "left" ? ax : h === "right" ? ax - wmW : ax - wmW / 2;
      wmY = v === "top" ? ay : v === "bottom" ? ay - wmH : ay - wmH / 2;
    }

    // Reference lines while dragging
    if (dragging) {
      ctx.strokeStyle = "rgba(94,106,210,0.3)";
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

    if (wmImg) {
      ctx.globalAlpha = wm.opacity / 100;
      ctx.drawImage(wmImg, wmX, wmY, wmW, wmH);
      ctx.globalAlpha = 1;
      if (dragging) {
        ctx.strokeStyle = "rgba(94,106,210,0.8)";
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
        ? "rgba(94,106,210,0.8)"
        : "rgba(255,255,255,0.3)";
      ctx.lineWidth = 1;
      ctx.strokeRect(wmX, wmY, wmW, wmH);
    }

    // Draw anchor point dot
    ctx.globalAlpha = 1;
    ctx.fillStyle = "rgba(94,106,210,0.6)";
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
        anchor: wm.anchor,
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

    const approxW = wmImg
      ? Math.round(Math.min(cw, ch) * (wm.imageScale / 100))
      : cw * 0.12;
    const approxH = approxW;

    const candidates = ANCHORS.map((a) => {
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

  function handleMouseDown(e: React.MouseEvent) {
    if (!wm.enabled) {
      return;
    }
    setDragging(true);
    dragToAnchor(e.clientX, e.clientY);
  }
  function handleMouseMove(e: React.MouseEvent) {
    if (!(wm.enabled && dragging)) {
      return;
    }
    dragToAnchor(e.clientX, e.clientY);
  }
  function handleMouseUp() {
    setDragging(false);
  }

  let canvasCursorClass = "cursor-not-allowed";
  if (wm.enabled) {
    canvasCursorClass = dragging ? "cursor-grabbing" : "cursor-grab";
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        className="relative overflow-hidden rounded-[8px] border border-border bg-secondary"
        ref={containerRef}
        style={{ aspectRatio: "16 / 10" }}
      >
        <canvas
          className={`h-full w-full ${canvasCursorClass}`}
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseUp}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          ref={canvasRef}
          style={{ display: "block" }}
        />
        {!dragging && (
          <div className="pointer-events-none absolute top-2 right-2 rounded-[4px] bg-background/70 px-2 py-0.5 text-[10px] text-foreground/70 backdrop-blur-sm">
            {t("orDragPreview")}
          </div>
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <span className="rounded-[4px] bg-primary/80 px-2 py-0.5 text-[10px] text-white backdrop-blur-sm">
              {t("dragToPosition")}
            </span>
          </div>
        )}
      </div>

      {/* Anchor grid + margin */}
      <div className="flex items-center gap-3">
        <span className="flex-shrink-0 text-[11px] text-muted-foreground/70">
          {t("watermarkPosition")}
        </span>
        <div className="grid grid-cols-3 gap-0.5">
          {ANCHORS.map((a) => (
            <Tooltip key={a.anchor}>
              <TooltipTrigger asChild>
                <button
                  className={`flex h-6 w-6 items-center justify-center rounded-[4px] text-[12px] transition-all ${
                    wm.anchor === a.anchor
                      ? "scale-105 bg-primary/20 text-primary ring-1 ring-primary/30"
                      : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  } disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent disabled:hover:text-muted-foreground`}
                  disabled={!wm.enabled}
                  onClick={() => onSettingsChange({ anchor: a.anchor })}
                  type="button"
                >
                  <AnchorGlyph
                    active={wm.anchor === a.anchor}
                    anchor={a.anchor}
                  />
                </button>
              </TooltipTrigger>
              <TooltipContent>{t(`anchor_${a.anchor}`)}</TooltipContent>
            </Tooltip>
          ))}
        </div>
        <span className="text-[10px] text-muted-foreground/50">
          {t("orDragPreview")}
        </span>
      </div>
    </div>
  );
}
