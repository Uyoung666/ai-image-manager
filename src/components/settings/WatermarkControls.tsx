import {
  AlertCircle,
  CheckCircle2,
  Image as ImageIcon,
  RotateCcw,
  Type,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  WATERMARK_ANCHORS,
  WatermarkAnchorGlyph,
  type WatermarkImageStatus,
  type WatermarkMode,
  type WatermarkPreviewSettings,
} from "@/components/WatermarkPreview";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import { cn } from "@/utils/tailwind";

const PATH_SEPARATOR_RE = /[\\/]/;

export type WatermarkSaveState = "idle" | "saving" | "saved" | "error";

interface WatermarkControlsProps {
  className?: string;
  focusTextSignal: number;
  imageStatus: WatermarkImageStatus;
  onChooseImage: () => Promise<void>;
  onRetrySave: () => void;
  onSettingsChange: (patch: Partial<WatermarkPreviewSettings>) => void;
  saveState: WatermarkSaveState;
  wm: WatermarkPreviewSettings;
}

const CONTROL_CLASS_NAME =
  "h-9 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-primary/20";

function ModeButton({
  active,
  icon,
  label,
  mode,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  mode: WatermarkMode;
  onClick: (mode: WatermarkMode) => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-[6px] px-3 py-2 text-[12px] transition-all duration-150 ${
        active
          ? "bg-card font-medium text-foreground shadow-[0_2px_8px_rgba(0,0,0,0.1)] ring-1 ring-primary/20"
          : "text-muted-foreground hover:bg-card/50 hover:text-foreground"
      }`}
      onClick={() => onClick(mode)}
      type="button"
    >
      {icon}
      {label}
    </button>
  );
}

function StatusMessage({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "error" | "info" | "success";
}) {
  let className = "border-primary/20 bg-primary/8 text-muted-foreground";
  if (tone === "error") {
    className = "border-destructive/25 bg-destructive/8 text-destructive";
  } else if (tone === "success") {
    className = "border-success/25 bg-success/8 text-success";
  }
  return (
    <div
      className={`rounded-[6px] border px-2.5 py-2 text-[11px] leading-relaxed ${className}`}
    >
      {children}
    </div>
  );
}

export function WatermarkControls({
  className,
  focusTextSignal,
  imageStatus,
  onChooseImage,
  onRetrySave,
  onSettingsChange,
  saveState,
  wm,
}: WatermarkControlsProps) {
  const { t } = useTranslation();
  const textInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (focusTextSignal > 0 && wm.mode === "text" && !wm.text.trim()) {
      textInputRef.current?.focus();
    }
  }, [focusTextSignal, wm.mode, wm.text]);

  const update = (patch: Partial<WatermarkPreviewSettings>) => {
    onSettingsChange(patch);
  };

  return (
    <div
      className={cn(
        "min-h-0 space-y-4 overflow-y-auto rounded-[8px] border border-border bg-secondary p-4",
        className
      )}
    >
      <section
        aria-labelledby="watermark-content-heading"
        className="space-y-3"
      >
        <div>
          <h3
            className="font-medium text-[13px] text-foreground"
            id="watermark-content-heading"
          >
            {t("watermarkContent")}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {t("watermarkContentHint")}
          </p>
        </div>

        <fieldset className="flex gap-1 rounded-[8px] bg-muted p-1">
          <legend className="sr-only">{t("watermarkType")}</legend>
          <ModeButton
            active={wm.mode === "text"}
            icon={<Type aria-hidden="true" className="h-3.5 w-3.5" />}
            label={t("watermarkTextMode")}
            mode="text"
            onClick={(mode) => update({ mode })}
          />
          <ModeButton
            active={wm.mode === "image"}
            icon={<ImageIcon aria-hidden="true" className="h-3.5 w-3.5" />}
            label={t("watermarkImageMode")}
            mode="image"
            onClick={(mode) => update({ mode })}
          />
        </fieldset>

        {wm.mode === "text" ? (
          <div className="space-y-1.5">
            <label
              className="block text-[11px] text-muted-foreground"
              htmlFor="watermark-text"
            >
              {t("watermarkText")}
            </label>
            <input
              className={CONTROL_CLASS_NAME}
              id="watermark-text"
              onChange={(event) => update({ text: event.target.value })}
              placeholder={t("watermarkTextPlaceholder")}
              ref={textInputRef}
              value={wm.text}
            />
            {!wm.text.trim() && (
              <p className="text-[11px] text-muted-foreground/70">
                {t("watermarkTextEmptyHint")}
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{t("watermarkImageFile")}</span>
              {imageStatus === "ready" && (
                <span className="flex items-center gap-1 text-success">
                  <CheckCircle2 aria-hidden="true" className="h-3.5 w-3.5" />
                  {t("watermarkAssetReady")}
                </span>
              )}
            </div>
            <button
              className="flex min-h-16 w-full items-center gap-3 rounded-[8px] border border-border border-dashed bg-card/60 px-3 py-2.5 text-left transition-colors hover:border-primary/40 hover:bg-card"
              onClick={onChooseImage}
              type="button"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[6px] bg-primary/10 text-primary">
                {wm.imagePath ? (
                  <img
                    alt=""
                    className="h-full w-full rounded-[5px] object-contain"
                    height={36}
                    src={toLocalMediaUrl(wm.imagePath)}
                    width={36}
                  />
                ) : (
                  <ImageIcon aria-hidden="true" className="h-4 w-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12px] text-foreground">
                  {wm.imagePath
                    ? wm.imagePath.split(PATH_SEPARATOR_RE).pop()
                    : t("watermarkChooseImage")}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground/70">
                  {wm.imagePath
                    ? t("watermarkChangeImageHint")
                    : t("watermarkImageFormats")}
                </span>
              </span>
            </button>
            {!wm.imagePath && (
              <StatusMessage tone="info">
                {t("watermarkImageClearedHint")}
              </StatusMessage>
            )}
            {wm.imagePath && (
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[10px] text-muted-foreground/60">
                  {wm.imagePath}
                </span>
                <button
                  className="shrink-0 text-[10px] text-destructive hover:underline"
                  onClick={() => update({ imagePath: "" })}
                  type="button"
                >
                  {t("clear")}
                </button>
              </div>
            )}
            {imageStatus === "loading" && (
              <StatusMessage tone="info">
                {t("watermarkAssetLoading")}
              </StatusMessage>
            )}
            {imageStatus === "error" && (
              <StatusMessage tone="error">
                <span className="flex items-start gap-1.5">
                  <AlertCircle
                    aria-hidden="true"
                    className="mt-0.5 h-3.5 w-3.5 shrink-0"
                  />
                  <span>{t("watermarkAssetError")}</span>
                </span>
              </StatusMessage>
            )}
          </div>
        )}
      </section>

      <section
        aria-labelledby="watermark-style-heading"
        className="space-y-3 border-border border-t pt-4"
      >
        <div>
          <h3
            className="font-medium text-[13px] text-foreground"
            id="watermark-style-heading"
          >
            {t("watermarkStyle")}
          </h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground/70">
            {t("watermarkStyleHint")}
          </p>
        </div>

        <div className="space-y-1.5">
          <label
            className="flex items-center justify-between text-[11px] text-muted-foreground"
            htmlFor="watermark-size"
          >
            <span>
              {wm.mode === "image"
                ? t("watermarkImageScale", { value: wm.imageScale })
                : t("watermarkFontSize", { value: wm.fontSize })}
            </span>
            <span className="text-[10px] text-muted-foreground/60">
              {wm.mode === "image" ? "5%–50%" : "12–72px"}
            </span>
          </label>
          <input
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            id="watermark-size"
            max={wm.mode === "image" ? 50 : 72}
            min={wm.mode === "image" ? 5 : 12}
            onChange={(event) =>
              update(
                wm.mode === "image"
                  ? { imageScale: Number(event.target.value) }
                  : { fontSize: Number(event.target.value) }
              )
            }
            step={wm.mode === "image" ? 1 : 2}
            type="range"
            value={wm.mode === "image" ? wm.imageScale : wm.fontSize}
          />
        </div>

        <div className="space-y-1.5">
          <label
            className="flex items-center justify-between text-[11px] text-muted-foreground"
            htmlFor="watermark-opacity"
          >
            <span>{t("watermarkOpacity", { value: wm.opacity })}</span>
            <span className="text-[10px] text-muted-foreground/60">
              10%–100%
            </span>
          </label>
          <input
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            id="watermark-opacity"
            max={100}
            min={10}
            onChange={(event) =>
              update({ opacity: Number(event.target.value) })
            }
            step={5}
            type="range"
            value={wm.opacity}
          />
        </div>
      </section>

      <section
        aria-labelledby="watermark-position-heading"
        className="space-y-3 border-border border-t pt-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3
              className="font-medium text-[13px] text-foreground"
              id="watermark-position-heading"
            >
              {t("watermarkPosition")}
            </h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
              {t("watermarkPositionHint")}
            </p>
          </div>
          <button
            aria-label={t("watermarkResetPosition")}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[5px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => update({ anchor: "bottomRight", margin: 5 })}
            type="button"
          >
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          </button>
        </div>

        <fieldset className="mx-auto grid w-fit grid-cols-3 gap-1">
          <legend className="sr-only">{t("watermarkPosition")}</legend>
          {WATERMARK_ANCHORS.map((item) => {
            const active = wm.anchor === item.anchor;
            return (
              <Tooltip key={item.anchor}>
                <TooltipTrigger asChild>
                  <button
                    aria-label={t(`anchor_${item.anchor}`)}
                    aria-pressed={active}
                    className={`flex h-8 w-8 items-center justify-center rounded-[5px] transition-all ${
                      active
                        ? "bg-primary/20 text-primary ring-1 ring-primary/30"
                        : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    }`}
                    onClick={() => update({ anchor: item.anchor })}
                    type="button"
                  >
                    <WatermarkAnchorGlyph
                      active={active}
                      anchor={item.anchor}
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t(`anchor_${item.anchor}`)}</TooltipContent>
              </Tooltip>
            );
          })}
        </fieldset>

        <div className="space-y-1.5">
          <label
            className="flex items-center justify-between text-[11px] text-muted-foreground"
            htmlFor="watermark-margin"
          >
            <span>{t("watermarkMargin", { value: wm.margin })}</span>
            <span className="text-[10px] text-muted-foreground/60">2%–15%</span>
          </label>
          <input
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            id="watermark-margin"
            max={15}
            min={2}
            onChange={(event) => update({ margin: Number(event.target.value) })}
            step={1}
            type="range"
            value={wm.margin}
          />
        </div>
      </section>

      {saveState === "error" && (
        <StatusMessage tone="error">
          <div className="flex items-center justify-between gap-2">
            <span>{t("watermarkSaveError")}</span>
            <button
              className="font-medium underline"
              onClick={onRetrySave}
              type="button"
            >
              {t("retry")}
            </button>
          </div>
        </StatusMessage>
      )}
    </div>
  );
}
