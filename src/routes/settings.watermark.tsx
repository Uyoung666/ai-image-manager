import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  WatermarkPreview,
  type WatermarkPreviewSettings,
} from "@/components/WatermarkPreview";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

interface WatermarkSettings extends WatermarkPreviewSettings {
  position?: string; // legacy, auto-migrated
  wmX?: number; // legacy
  wmY?: number; // legacy
}

const DEFAULT_WM: WatermarkSettings = {
  enabled: false,
  text: "",
  imagePath: "",
  anchor: "bottomRight",
  margin: 5,
  opacity: 50,
  fontSize: 24,
  imageScale: 15,
};

// Module-level cache — survives page navigation so re-entry shows preview immediately
let cachedSamplePhoto = "";

function WatermarkSettingsPage() {
  const { t } = useTranslation();
  const [wm, setWm] = useState<WatermarkSettings>(DEFAULT_WM);
  const [wmLoaded, setWmLoaded] = useState(false);
  const [samplePhoto, setSamplePhoto] = useState(cachedSamplePhoto);
  const wmOriginalRef = useRef<WatermarkSettings | null>(null);
  const wmSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wmLatestRef = useRef<WatermarkSettings>(DEFAULT_WM);
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  // Load watermark settings + preload sample photo
  useEffect(() => {
    ipc.client.photos
      .getWatermarkSettings({})
      .then((result: any) => {
        if (result) {
          const w = { ...DEFAULT_WM, ...result };
          // Migrate old wmX/wmY → anchor
          if (!w.anchor && typeof w.wmX === "number") {
            w.anchor = "bottomRight";
            w.margin = 5;
          }
          if (!w.anchor && w.position) {
            w.anchor =
              w.position === "topLeft" ||
              w.position === "topRight" ||
              w.position === "bottomLeft" ||
              w.position === "bottomRight" ||
              w.position === "center" ||
              w.position === "topCenter" ||
              w.position === "centerLeft" ||
              w.position === "centerRight" ||
              w.position === "bottomCenter"
                ? (w.position as WatermarkSettings["anchor"])
                : "bottomRight";
            w.margin = 5;
          }
          setWm(w);
          wmLatestRef.current = w;
          // Snapshot original values so we can skip the initial no-op save
          wmOriginalRef.current = { ...w };
        } else {
          // No saved settings yet — snapshot defaults to skip initial save
          wmOriginalRef.current = { ...DEFAULT_WM };
        }
        setWmLoaded(true);
      })
      .catch(() => {
        if (!wmOriginalRef.current) {
          wmOriginalRef.current = { ...DEFAULT_WM };
        }
        setWmLoaded(true);
      });

    // Preload sample photo (cached at module level, fetched once per session)
    if (cachedSamplePhoto) {
      setSamplePhoto(cachedSamplePhoto);
    } else {
      ipc.client.photos
        .listPhotos({ sort: "date", order: "desc", limit: 30 })
        .then((r: any) => {
          const photos = r?.pages?.[0]?.items || r?.items || [];
          const horizontal = photos.find(
            (p: any) => p.width && p.height && p.width >= p.height
          );
          if (horizontal?.path) {
            cachedSamplePhoto = horizontal.path;
            setSamplePhoto(horizontal.path);
          }
        })
        .catch(() => {});
    }
  }, []);

  // Keep ref in sync for the unmount flush
  wmLatestRef.current = wm;

  // Persist watermark settings (debounced 300ms, skips unchanged values)
  useEffect(() => {
    if (!wmLoaded) {
      return;
    }
    // Skip if unchanged from originally loaded values
    const original = wmOriginalRef.current;
    if (original && JSON.stringify(wm) === JSON.stringify(original)) {
      return;
    }
    // Debounce slider drags into a single write
    if (wmSaveTimerRef.current) {
      clearTimeout(wmSaveTimerRef.current);
    }
    wmSaveTimerRef.current = setTimeout(() => {
      ipc.client.photos.setWatermarkSettings(wmLatestRef.current).catch(() => {
        /* ignore */
      });
    }, 300);
    return () => {
      if (wmSaveTimerRef.current) {
        clearTimeout(wmSaveTimerRef.current);
      }
    };
  }, [wm, wmLoaded]);

  // Flush pending debounced save on unmount so quick navigation doesn't lose changes
  useEffect(() => {
    return () => {
      if (wmSaveTimerRef.current) {
        clearTimeout(wmSaveTimerRef.current);
        ipc.client.photos
          .setWatermarkSettings(wmLatestRef.current)
          .catch(() => {});
      }
    };
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6" ref={scrollRef}>
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold text-[14px] text-foreground">
            {t("watermarkSettings")}
          </h2>
          <button
            className={`h-5 w-9 rounded-full transition-colors ${
              wm.enabled ? "bg-primary" : "bg-muted"
            }`}
            onClick={() =>
              setWm((prev) => ({ ...prev, enabled: !prev.enabled }))
            }
          >
            <div
              className={`h-4 w-4 rounded-full bg-white transition-transform ${
                wm.enabled ? "translate-x-[18px]" : "translate-x-[2px]"
              }`}
            />
          </button>
        </div>

        {/* Preview (always visible, dimmed when disabled) */}
        <div className={wm.enabled ? "" : "pointer-events-none opacity-30"}>
          <WatermarkPreview
            onSettingsChange={(patch) =>
              setWm((prev) => ({ ...prev, ...patch }))
            }
            samplePhotoPath={samplePhoto}
            wm={wm}
          />
        </div>

        {wm.enabled && (
          <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
            {/* Margin slider */}
            <div>
              <label className="mb-1 block text-[11px] text-muted-foreground/70">
                {t("watermarkMargin", { value: wm.margin })}
              </label>
              <input
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                max={15}
                min={2}
                onChange={(e) =>
                  setWm((prev) => ({
                    ...prev,
                    margin: Number(e.target.value),
                  }))
                }
                step={1}
                type="range"
                value={wm.margin}
              />
            </div>

            {/* Text watermark */}
            <div className="border-border border-t pt-3">
              <label className="mb-1 block text-[11px] text-muted-foreground/70">
                {t("watermarkText")}
              </label>
              <input
                className="h-8 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                onChange={(e) =>
                  setWm((prev) => ({ ...prev, text: e.target.value }))
                }
                placeholder={t("watermarkTextPlaceholder")}
                value={wm.text}
              />
            </div>

            {/* Image watermark */}
            <div className="border-border border-t pt-3">
              <label className="mb-1 block text-[11px] text-muted-foreground/70">
                {t("watermarkImage")}
              </label>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-[6px] border border-input px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                  onClick={async () => {
                    try {
                      const result = (await ipc.client.shell.openFileDialog({
                        filters: [
                          {
                            name: "Images",
                            extensions: ["png", "jpg", "jpeg", "webp", "svg"],
                          },
                        ],
                      })) as { path?: string };
                      if (result?.path) {
                        setWm((prev) => ({
                          ...prev,
                          imagePath: result.path!,
                        }));
                      }
                    } catch {
                      /* ignore */
                    }
                  }}
                  type="button"
                >
                  {wm.imagePath ? t("changeFile") : t("chooseFile")}
                </button>
                {wm.imagePath && (
                  <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
                    {wm.imagePath.split(/[\\/]/).pop()}
                  </span>
                )}
                {wm.imagePath && (
                  <button
                    className="text-[10px] text-destructive hover:underline"
                    onClick={() =>
                      setWm((prev) => ({ ...prev, imagePath: "" }))
                    }
                    type="button"
                  >
                    {t("clear")}
                  </button>
                )}
              </div>
            </div>

            {/* Size slider */}
            <div className="border-border border-t pt-3">
              <label className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground/70">
                <span>
                  {wm.imagePath
                    ? t("watermarkImageScale", { value: wm.imageScale })
                    : t("watermarkFontSize", { value: wm.fontSize })}
                </span>
                <span className="text-[10px] text-muted-foreground/50">
                  {wm.imagePath ? "5% — 50%" : "12 — 72"}
                </span>
              </label>
              {wm.imagePath ? (
                <input
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                  max={50}
                  min={5}
                  onChange={(e) =>
                    setWm((prev) => ({
                      ...prev,
                      imageScale: Number(e.target.value),
                    }))
                  }
                  step={1}
                  type="range"
                  value={wm.imageScale}
                />
              ) : (
                <input
                  className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                  max={72}
                  min={12}
                  onChange={(e) =>
                    setWm((prev) => ({
                      ...prev,
                      fontSize: Number(e.target.value),
                    }))
                  }
                  step={2}
                  type="range"
                  value={wm.fontSize}
                />
              )}
            </div>

            {/* Opacity */}
            <div className="border-border border-t pt-3">
              <label className="mb-1 block text-[11px] text-muted-foreground/70">
                {t("watermarkOpacity", { value: wm.opacity })}
              </label>
              <input
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                max={100}
                min={10}
                onChange={(e) =>
                  setWm((prev) => ({
                    ...prev,
                    opacity: Number(e.target.value),
                  }))
                }
                step={5}
                type="range"
                value={wm.opacity}
              />
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

export const Route = createFileRoute("/settings/watermark")({
  component: WatermarkSettingsPage,
});
