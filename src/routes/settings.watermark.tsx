import { createFileRoute } from "@tanstack/react-router";
import { Check, CircleAlert, LoaderCircle, ShieldCheck } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import {
  WatermarkControls,
  type WatermarkSaveState,
} from "@/components/settings/WatermarkControls";
import { Switch } from "@/components/ui/switch";
import {
  type WatermarkImageStatus,
  WatermarkPreview,
  type WatermarkPreviewSettings,
} from "@/components/WatermarkPreview";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

interface WatermarkSettings extends WatermarkPreviewSettings {
  position?: string;
  wmX?: number;
  wmY?: number;
}

interface PhotoListItem {
  filename?: string;
  height?: number;
  path?: string;
  width?: number;
}

interface PhotoListResult {
  items?: PhotoListItem[];
  pages?: Array<{ items?: PhotoListItem[] }>;
}

interface SamplePhoto extends PhotoListItem {
  path: string;
}

const DEFAULT_WM: WatermarkSettings = {
  anchor: "bottomRight",
  enabled: false,
  fontSize: 24,
  imagePath: "",
  imageScale: 15,
  margin: 5,
  mode: "text",
  opacity: 50,
  text: "",
};

let cachedSamplePhoto: SamplePhoto | null = null;

function normalizeWatermarkSettings(result: unknown): WatermarkSettings {
  const raw = (
    result && typeof result === "object" ? result : {}
  ) as Partial<WatermarkSettings>;
  let mode: WatermarkSettings["mode"] = "text";
  if (raw.mode === "image" || raw.mode === "text") {
    mode = raw.mode;
  } else if (raw.imagePath) {
    mode = "image";
  }
  const next: WatermarkSettings = {
    ...DEFAULT_WM,
    ...raw,
    mode,
  };

  if (!raw.anchor) {
    if (
      raw.position === "topLeft" ||
      raw.position === "topRight" ||
      raw.position === "bottomLeft" ||
      raw.position === "bottomRight" ||
      raw.position === "center" ||
      raw.position === "topCenter" ||
      raw.position === "centerLeft" ||
      raw.position === "centerRight" ||
      raw.position === "bottomCenter"
    ) {
      next.anchor = raw.position;
    }
    next.margin = 5;
  }

  return next;
}

function getSamplePhoto(items: PhotoListItem[]): SamplePhoto | null {
  const horizontal = items.find(
    (item) =>
      item.path && item.width && item.height && item.width >= item.height
  );
  const fallback = items.find((item) => item.path);
  const item = horizontal ?? fallback;
  return item?.path ? { ...item, path: item.path } : null;
}

function SaveState({ state }: { state: WatermarkSaveState }) {
  const { t } = useTranslation();
  if (state === "saving") {
    return (
      <span
        aria-live="polite"
        className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground [overflow-wrap:anywhere]"
      >
        <LoaderCircle aria-hidden="true" className="h-3 w-3 animate-spin" />
        {t("watermarkSaving")}
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span
        aria-live="polite"
        className="flex min-w-0 items-center gap-1 text-[10px] text-success [overflow-wrap:anywhere]"
      >
        <Check aria-hidden="true" className="h-3 w-3" />
        {t("watermarkSaved")}
      </span>
    );
  }
  if (state === "error") {
    return (
      <span
        aria-live="polite"
        className="flex min-w-0 items-center gap-1 text-[10px] text-destructive [overflow-wrap:anywhere]"
      >
        <CircleAlert aria-hidden="true" className="h-3 w-3" />
        {t("watermarkSaveError")}
      </span>
    );
  }
  return null;
}

function WatermarkSettingsPage() {
  const { t } = useTranslation();
  const [wm, setWm] = useState<WatermarkSettings>(DEFAULT_WM);
  const [wmLoaded, setWmLoaded] = useState(false);
  const [samplePhoto, setSamplePhoto] = useState<SamplePhoto | null>(
    cachedSamplePhoto
  );
  const [imageStatus, setImageStatus] = useState<WatermarkImageStatus>("empty");
  const [saveState, setSaveState] = useState<WatermarkSaveState>("idle");
  const [settingsLoadError, setSettingsLoadError] = useState(false);
  const [focusTextSignal, setFocusTextSignal] = useState(0);
  const [previewHeight, setPreviewHeight] = useState<number | null>(null);
  const wmOriginalRef = useRef<WatermarkSettings | null>(null);
  const wmSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wmLatestRef = useRef<WatermarkSettings>(DEFAULT_WM);
  const scrollRef = useRef<HTMLDivElement>(null);
  const previewPaneRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    const previewPane = previewPaneRef.current;
    if (!previewPane) {
      return;
    }

    const updatePreviewHeight = () => {
      setPreviewHeight(previewPane.getBoundingClientRect().height);
    };
    updatePreviewHeight();

    const resizeObserver = new ResizeObserver(updatePreviewHeight);
    resizeObserver.observe(previewPane);
    return () => resizeObserver.disconnect();
  }, []);

  const loadWatermarkSettings = useCallback(async () => {
    setWmLoaded(false);
    try {
      const result = await ipc.client.photos.getWatermarkSettings({});
      const next = normalizeWatermarkSettings(result);
      setWm(next);
      wmLatestRef.current = next;
      wmOriginalRef.current = { ...next };
      setSettingsLoadError(false);
    } catch {
      wmOriginalRef.current = { ...DEFAULT_WM };
      setSettingsLoadError(true);
    } finally {
      setWmLoaded(true);
    }
  }, []);

  useEffect(() => {
    loadWatermarkSettings().catch(() => undefined);

    if (cachedSamplePhoto) {
      setSamplePhoto(cachedSamplePhoto);
      return;
    }

    ipc.client.photos
      .listPhotos({ sort: "date", order: "desc", limit: 30 })
      .then((result) => {
        const response = result as PhotoListResult;
        const items = response.pages?.[0]?.items || response.items || [];
        const next = getSamplePhoto(items);
        if (next) {
          cachedSamplePhoto = next;
          setSamplePhoto(next);
        }
      })
      .catch(() => undefined);
  }, [loadWatermarkSettings]);

  wmLatestRef.current = wm;

  const saveWatermark = useCallback(async () => {
    setSaveState("saving");
    try {
      await ipc.client.photos.setWatermarkSettings(wmLatestRef.current);
      wmOriginalRef.current = { ...wmLatestRef.current };
      setSaveState("saved");
    } catch {
      setSaveState("error");
    }
  }, []);

  useEffect(() => {
    return () => {
      if (wmSaveTimerRef.current) {
        clearTimeout(wmSaveTimerRef.current);
        ipc.client.photos
          .setWatermarkSettings(wmLatestRef.current)
          .catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (!wmLoaded) {
      return;
    }
    const original = wmOriginalRef.current;
    if (original && JSON.stringify(wm) === JSON.stringify(original)) {
      return;
    }

    if (wmSaveTimerRef.current) {
      clearTimeout(wmSaveTimerRef.current);
    }
    setSaveState("saving");
    wmSaveTimerRef.current = setTimeout(() => {
      wmSaveTimerRef.current = null;
      saveWatermark().catch(() => undefined);
    }, 300);

    return () => {
      if (wmSaveTimerRef.current) {
        clearTimeout(wmSaveTimerRef.current);
      }
    };
  }, [saveWatermark, wm, wmLoaded]);

  const handleSettingsChange = useCallback(
    (patch: Partial<WatermarkPreviewSettings>) => {
      setWm((previous) => ({ ...previous, ...patch }));
    },
    []
  );

  const handleEnableChange = (enabled: boolean) => {
    setWm((previous) => ({ ...previous, enabled }));
    if (enabled && wm.mode === "text" && !wm.text.trim()) {
      setFocusTextSignal((value) => value + 1);
    }
  };

  const handleChooseImage = async () => {
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
        setWm((previous) => ({
          ...previous,
          imagePath: result.path,
          mode: "image",
        }));
      }
    } catch {
      setImageStatus("error");
    }
  };

  return (
    <SettingsPageShell
      description={t("watermarkSettingsDescription")}
      maxWidth="wide"
      scrollRef={scrollRef}
      title={t("watermarkSettings")}
    >
      <section className="space-y-4">
        <div className="flex min-w-0 flex-col items-stretch gap-3 rounded-[8px] border border-border bg-secondary p-3 min-[900px]:flex-row min-[900px]:items-center min-[900px]:justify-between min-[900px]:gap-4 min-[480px]:p-4">
          <div className="flex min-w-0 items-start gap-3 min-[900px]:items-center">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[8px] bg-primary/10 text-primary">
              <ShieldCheck aria-hidden="true" className="h-4 w-4" />
            </span>
            <div className="min-w-0">
              <div className="font-medium text-[13px] text-foreground">
                {t("enableWatermark")}
              </div>
              <div className="mt-0.5 text-[11px] text-muted-foreground/70">
                {t("watermarkEnableHint")}
              </div>
              <div
                className={`mt-1 text-[11px] ${
                  wm.enabled ? "text-success" : "text-muted-foreground"
                }`}
              >
                {wm.enabled ? t("watermarkEnabled") : t("watermarkDisabled")}
              </div>
            </div>
          </div>
          <div className="flex min-w-0 flex-wrap items-center justify-end gap-3 min-[900px]:shrink-0">
            <SaveState state={saveState} />
            <Switch
              ariaLabel={t("enableWatermark")}
              checked={wm.enabled}
              onCheckedChange={handleEnableChange}
            />
          </div>
        </div>

        {settingsLoadError && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 rounded-[6px] border border-destructive/25 bg-destructive/8 px-3 py-2 text-[11px] text-destructive">
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              {t("watermarkLoadError")}
            </span>
            <button
              className="font-medium underline"
              onClick={() => loadWatermarkSettings().catch(() => undefined)}
              type="button"
            >
              {t("retry")}
            </button>
          </div>
        )}

        <div className="grid min-h-0 min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,360px)] xl:items-stretch">
          <div
            className="min-w-0 xl:sticky xl:top-6 xl:self-start"
            ref={previewPaneRef}
          >
            <WatermarkPreview
              onImageStatusChange={setImageStatus}
              onSettingsChange={handleSettingsChange}
              samplePhotoPath={samplePhoto?.path}
              wm={wm}
            />
          </div>

          <div
            className="min-h-0 min-w-0 overflow-hidden xl:h-[var(--watermark-workspace-height)]"
            style={
              previewHeight === null
                ? undefined
                : ({
                    "--watermark-workspace-height": `${previewHeight}px`,
                  } as CSSProperties)
            }
          >
            <WatermarkControls
              className="xl:h-full"
              focusTextSignal={focusTextSignal}
              imageStatus={imageStatus}
              onChooseImage={handleChooseImage}
              onRetrySave={() => saveWatermark().catch(() => undefined)}
              onSettingsChange={handleSettingsChange}
              saveState={saveState}
              wm={wm}
            />
          </div>
        </div>
      </section>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/watermark")({
  component: WatermarkSettingsPage,
});
