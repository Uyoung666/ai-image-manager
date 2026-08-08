import { ChevronDown, Copy, FolderOpen, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ipc } from "@/ipc/manager";
import { getTagDisplayName } from "@/localization/tag-display";
import { getDateLocale } from "@/utils/date-locale";

export interface LightboxInfoPhoto {
  fileDate?: number | null;
  filename: string;
  fileSize: number;
  format?: string;
  height: number;
  id: number;
  path: string;
  width: number;
}

interface ExifData {
  advanced?: {
    autofocus: Record<string, unknown>;
    capture: Record<string, unknown>;
    processing: Record<string, unknown>;
    provenance: Record<string, unknown>;
    standard: Record<string, unknown>;
    vendor: string | null;
    vendorRaw: Record<string, unknown>;
    workflow: Record<string, unknown>;
  } | null;
  aperture: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  dateTaken: number | null;
  focalLength: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  iso: number | null;
  lensMake: string | null;
  lensModel: string | null;
  shutterSpeed: string | null;
  software: string | null;
}

interface TagInfo {
  color: string | null;
  confidence: number | null;
  id: number;
  isConfirmed: boolean | null;
  name: string;
}

interface LightboxInfoPanelProps {
  onClose: () => void;
  onOpenExplorer: (path: string) => void;
  photo: LightboxInfoPhoto;
}

const WIDTH_KEY = "lightbox_info_panel_width";
const MIN_WIDTH = 300;
const MAX_WIDTH = 460;
const DEFAULT_WIDTH = 340;

function loadWidth() {
  try {
    const value = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(value)
      ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, value))
      : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function displayValue(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "Yes" : "No";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

function hasCaptureInfo(exif: ExifData | null) {
  return Boolean(
    exif?.cameraMake ||
      exif?.cameraModel ||
      exif?.lensMake ||
      exif?.lensModel ||
      exif?.focalLength ||
      exif?.aperture ||
      exif?.shutterSpeed ||
      exif?.iso
  );
}

export function LightboxInfoPanel({
  photo,
  onClose,
  onOpenExplorer,
}: LightboxInfoPanelProps) {
  const { t, i18n } = useTranslation();
  const [exif, setExif] = useState<ExifData | null>(null);
  const [tags, setTags] = useState<TagInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [width, setWidth] = useState(loadWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStart = useRef({ x: 0, width });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setExif(null);
    setTags([]);
    Promise.all([
      ipc.client.photos.getPhotoExif({ id: photo.id }),
      ipc.client.photos.getPhotoTags({ id: photo.id }),
    ])
      .then(([nextExif, nextTags]) => {
        if (!active) {
          return;
        }
        setExif(nextExif as ExifData | null);
        setTags((nextTags as TagInfo[]) ?? []);
      })
      .catch(() => {
        if (!active) {
          return;
        }
        setExif(null);
        setTags([]);
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [photo.id]);

  useEffect(() => {
    if (!resizing) {
      return;
    }
    const move = (event: MouseEvent) => {
      const next =
        resizeStart.current.width + resizeStart.current.x - event.clientX;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next)));
    };
    const stop = () => {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(WIDTH_KEY, String(width));
      } catch {
        // Preference persistence is non-critical.
      }
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", stop);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", stop);
    };
  }, [resizing, width]);

  const date = exif?.dateTaken ?? photo.fileDate;
  const dateLabel = date
    ? new Date(date).toLocaleDateString(getDateLocale(i18n.language), {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;
  const camera = [exif?.cameraMake, exif?.cameraModel]
    .filter(Boolean)
    .join(" ");
  const lens = [exif?.lensMake, exif?.lensModel].filter(Boolean).join(" ");
  const hasCapture = hasCaptureInfo(exif);
  const advancedGroups = exif?.advanced
    ? [
        [
          t("metadataCapture"),
          { ...exif.advanced.standard, ...exif.advanced.capture },
        ],
        [t("metadataAutofocus"), exif.advanced.autofocus],
        [t("metadataProcessing"), exif.advanced.processing],
        [t("metadataWorkflow"), exif.advanced.workflow],
        [t("metadataProvenance"), exif.advanced.provenance],
      ].filter(
        ([, values]) =>
          Object.keys(values as Record<string, unknown>).length > 0
      )
    : [];

  return (
    <aside
      aria-label={t("photoDetail")}
      className="relative z-20 flex h-full shrink-0 flex-col border-white/10 border-l bg-[#111114] text-white"
      style={{ width }}
    >
      <div
        aria-hidden="true"
        className={`absolute top-0 -left-1 h-full w-2 cursor-col-resize ${resizing ? "bg-primary/50" : "hover:bg-white/10"}`}
        onMouseDown={(event) => {
          event.preventDefault();
          resizeStart.current = { x: event.clientX, width };
          setResizing(true);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      />
      <header className="flex h-14 shrink-0 items-center justify-between border-white/10 border-b px-4">
        <div className="min-w-0">
          <h2 className="font-semibold text-[14px]">{t("photoDetail")}</h2>
          <p className="truncate text-[11px] text-white/45">{photo.filename}</p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              aria-label={t("close")}
              className="lightbox-control-button"
              onClick={onClose}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent>{t("close")}</TooltipContent>
        </Tooltip>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
        <InfoSection title={t("photoInfo")}>
          <InfoRow label={t("fileName")} value={photo.filename} />
          {photo.format && <InfoRow label={t("format")} value={photo.format} />}
          <InfoRow
            label={t("dimensions")}
            value={`${photo.width} × ${photo.height}`}
          />
          <InfoRow
            label={t("fileSize")}
            value={formatFileSize(photo.fileSize)}
          />
          {dateLabel && <InfoRow label={t("dateTaken")} value={dateLabel} />}
        </InfoSection>

        {loading ? (
          <div className="space-y-2" role="status">
            <span className="sr-only">{t("loading")}</span>
            <div className="h-3 w-24 animate-pulse rounded bg-white/10" />
            <div className="h-7 animate-pulse rounded bg-white/[0.06]" />
            <div className="h-7 animate-pulse rounded bg-white/[0.06]" />
          </div>
        ) : (
          <>
            {hasCapture && (
              <InfoSection title={t("lightboxCaptureInfo")}>
                {camera && <InfoRow label={t("camera")} value={camera} />}
                {lens && <InfoRow label={t("lens")} value={lens} />}
                {exif?.focalLength && (
                  <InfoRow
                    label={t("focalLength")}
                    value={`${exif.focalLength}mm`}
                  />
                )}
                {exif?.aperture && (
                  <InfoRow label={t("aperture")} value={`f/${exif.aperture}`} />
                )}
                {exif?.shutterSpeed && (
                  <InfoRow
                    label={t("shutter")}
                    value={`${exif.shutterSpeed}s`}
                  />
                )}
                {exif?.iso && (
                  <InfoRow label={t("iso")} value={String(exif.iso)} />
                )}
              </InfoSection>
            )}

            {tags.length > 0 && (
              <InfoSection title={t("sidebarTags")}>
                <div className="flex flex-wrap gap-1.5">
                  {tags.map((tag) => (
                    <span
                      className={`rounded px-2 py-0.5 text-[11px] ${tag.isConfirmed === false ? "border border-foreground/20 border-dashed bg-foreground/5 text-foreground/65" : "text-white"}`}
                      key={tag.id}
                      style={
                        tag.isConfirmed === false
                          ? undefined
                          : { backgroundColor: tag.color ?? "var(--primary)" }
                      }
                    >
                      {getTagDisplayName(tag.name, i18n.language)}
                    </span>
                  ))}
                </div>
              </InfoSection>
            )}

            {(exif?.gpsLatitude != null || exif?.software) && (
              <InfoSection title={t("lightboxLocationAndFile")}>
                {exif.gpsLatitude != null && exif.gpsLongitude != null && (
                  <InfoRow
                    label="GPS"
                    value={`${exif.gpsLatitude.toFixed(4)}, ${exif.gpsLongitude.toFixed(4)}`}
                  />
                )}
                {exif.software && (
                  <InfoRow label="Software" value={exif.software} />
                )}
              </InfoSection>
            )}

            {advancedGroups.length > 0 && (
              <details className="group rounded-lg border border-white/10 bg-white/[0.025] p-3">
                <summary className="flex cursor-pointer list-none items-center justify-between font-medium text-[11px] text-white/60 uppercase tracking-wider">
                  {t("advancedMetadata")}
                  <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                </summary>
                <div className="mt-3 space-y-4">
                  {advancedGroups.map(([title, values]) => (
                    <div key={String(title)}>
                      <h4 className="mb-1.5 font-medium text-[11px] text-white/65">
                        {String(title)}
                      </h4>
                      <div className="space-y-1.5">
                        {Object.entries(values as Record<string, unknown>)
                          .filter(([, value]) => value != null && value !== "")
                          .slice(0, 24)
                          .map(([key, value]) => (
                            <InfoRow
                              key={key}
                              label={key}
                              value={displayValue(value)}
                            />
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </>
        )}

        <InfoSection title={t("filePath")}>
          <p className="break-all text-[11px] text-white/55 leading-relaxed">
            {photo.path}
          </p>
          <div className="mt-2 flex gap-2">
            <button
              className="lightbox-secondary-button"
              onClick={() => {
                navigator.clipboard.writeText(photo.path).then(
                  () => toast.success(t("pathCopied")),
                  () => toast.error(t("copyFailed"))
                );
              }}
              type="button"
            >
              <Copy className="h-3.5 w-3.5" />
              {t("copyPath")}
            </button>
            <button
              className="lightbox-secondary-button"
              onClick={() => onOpenExplorer(photo.path)}
              type="button"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              {t("openInExplorer")}
            </button>
          </div>
        </InfoSection>
      </div>
    </aside>
  );
}

function InfoSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="mb-2 font-medium text-[11px] text-white/40 uppercase tracking-wider">
        {title}
      </h3>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-4 text-[11px]">
      <span className="shrink-0 text-white/40">{label}</span>
      <span className="min-w-0 break-words text-right text-white/75">
        {value}
      </span>
    </div>
  );
}
