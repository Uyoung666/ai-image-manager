import { FolderOpen, Plus, Sparkles, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

interface PhotoDetail {
  filename: string;
  fileSize: number;
  format?: string;
  height: number;
  id: number;
  path: string;
  width: number;
}

interface ExifData {
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
  orientation: number | null;
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

interface PhotoDetailPanelProps {
  onClose: () => void;
  onOpenExplorer: (path: string) => void;
  photo: PhotoDetail | null;
}

const PANEL_WIDTH_KEY = "detail_panel_width";
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 480;
const DEFAULT_PANEL_WIDTH = 300;

function loadPanelWidth(): number {
  try {
    const saved = localStorage.getItem(PANEL_WIDTH_KEY);
    if (saved) {
      return Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, Number(saved))
      );
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_PANEL_WIDTH;
}

function formatFileSize(bytes: number): string {
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

function toLocalMediaUrl(filePath: string): string {
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

export function PhotoDetailPanel({
  photo,
  onClose,
  onOpenExplorer,
}: PhotoDetailPanelProps) {
  const { t } = useTranslation();
  const [exif, setExif] = useState<ExifData | null>(null);
  const [loading, setLoading] = useState(false);
  const [photoTags, setPhotoTags] = useState<TagInfo[]>([]);
  const [allTags, setAllTags] = useState<TagInfo[]>([]);
  const [showTagInput, setShowTagInput] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [aiSuggestions, setAiSuggestions] = useState<
    Array<{ tag: string; confidence: number }> | null
  >(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [panelWidth, setPanelWidth] = useState(loadPanelWidth);
  const [resizing, setResizing] = useState(false);
  const resizeStartX = useRef(0);
  const resizeStartWidth = useRef(0);
  const currentWidth = useRef(panelWidth);
  const panelRef = useRef<HTMLDivElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const [visible, setVisible] = useState(false);
  const lastPhotoRef = useRef<PhotoDetail | null>(null);

  if (photo) {
    lastPhotoRef.current = photo;
  }

  const displayPhoto = photo ?? lastPhotoRef.current;

  useEffect(() => {
    if (photo) {
      requestAnimationFrame(() => setVisible(true));
    } else {
      setVisible(false);
    }
  }, [photo]);

  // Reset AI suggestions when photo changes
  useEffect(() => {
    setAiSuggestions(null);
    setAiLoading(false);
    setNewTagName("");
    setShowTagInput(false);
  }, [photo?.id]);

  // Keep ref in sync for resize callback closure
  useEffect(() => {
    currentWidth.current = panelWidth;
  }, [panelWidth]);

  // Resize handling
  useEffect(() => {
    if (!resizing) {
      return;
    }

    function handleMouseMove(e: MouseEvent) {
      const delta = resizeStartX.current - e.clientX;
      const newWidth = Math.max(
        MIN_PANEL_WIDTH,
        Math.min(MAX_PANEL_WIDTH, resizeStartWidth.current + delta)
      );
      currentWidth.current = newWidth;
      setPanelWidth(newWidth);
    }

    function handleMouseUp() {
      setResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      try {
        localStorage.setItem(PANEL_WIDTH_KEY, String(currentWidth.current));
      } catch {
        /* ignore */
      }
    }

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [resizing]);

  function handleResizeStart(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setResizing(true);
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = currentWidth.current;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  const loadTags = useCallback(async () => {
    if (!photo) {
      return;
    }
    try {
      const [pTags, aTags] = await Promise.all([
        ipc.client.photos.getPhotoTags({ id: photo.id }),
        ipc.client.photos.getTags({}),
      ]);
      setPhotoTags((pTags as TagInfo[]) || []);
      setAllTags((aTags as unknown as TagInfo[]) || []);
    } catch {
      /* ignore */
    }
  }, [photo]);

  useEffect(() => {
    if (!photo) {
      return;
    }
    setLoading(true);
    setExif(null);
    setPhotoTags([]);
    ipc.client.photos
      .getPhotoExif({ id: photo.id })
      .then((result) => setExif(result as ExifData | null))
      .catch(() => setExif(null))
      .finally(() => setLoading(false));
    loadTags();
  }, [photo?.id, loadTags]);

  useEffect(() => {
    if (showTagInput && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [showTagInput]);

  async function handleAddTag(tagId: number) {
    if (!photo) {
      return;
    }
    try {
      await ipc.client.photos.setPhotoTag({ photoId: photo.id, tagId });
      loadTags();
    } catch {
      /* ignore */
    }
  }

  async function handleRemoveTag(tagId: number) {
    if (!photo) {
      return;
    }
    try {
      await ipc.client.photos.removePhotoTag({ photoId: photo.id, tagId });
      loadTags();
    } catch {
      /* ignore */
    }
  }

  async function handleConfirmTag(tagId: number) {
    if (!photo) {
      return;
    }
    try {
      await ipc.client.photos.confirmPhotoTag({ photoId: photo.id, tagId });
      loadTags();
    } catch {
      /* ignore */
    }
  }

  async function handleCreateTag() {
    const name = newTagName.trim();
    if (!(name && photo)) {
      return;
    }
    try {
      const created = await ipc.client.photos.addTag({
        name,
        color: getTagColor(name),
      });
      const tag = created as TagInfo;
      await ipc.client.photos.setPhotoTag({
        photoId: photo.id,
        tagId: tag.id,
      });
      setNewTagName("");
      setShowTagInput(false);
      loadTags();
    } catch {
      /* ignore */
    }
  }

  async function handleAiSuggest() {
    if (!photo) {
      return;
    }
    setAiLoading(true);
    setAiSuggestions(null);
    try {
      const result = await ipc.client.photos.suggestTags({ id: photo.id });
      setAiSuggestions((result as { suggestions?: Array<{ tag: string; confidence: number }> })?.suggestions || []);
    } catch {
      setAiSuggestions([]);
    } finally {
      setAiLoading(false);
    }
  }

  async function handleApplySuggestion(tagName: string) {
    if (!photo) {
      return;
    }
    try {
      // Find or create the tag
      const existing = allTags.find((t) => t.name === tagName);
      if (existing) {
        if (!photoTagIds.has(existing.id)) {
          await ipc.client.photos.setPhotoTag({
            photoId: photo.id,
            tagId: existing.id,
          });
        }
      } else {
        const created = await ipc.client.photos.addTag({
          name: tagName,
          color: getTagColor(tagName),
        });
        const tag = created as TagInfo;
        await ipc.client.photos.setPhotoTag({
          photoId: photo.id,
          tagId: tag.id,
        });
      }
      loadTags();
      // Remove applied suggestion from the list
      setAiSuggestions((prev) =>
        prev ? prev.filter((s) => s.tag !== tagName) : null
      );
    } catch {
      /* ignore */
    }
  }

  function handleTagInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleCreateTag();
    } else if (e.key === "Escape") {
      setShowTagInput(false);
      setNewTagName("");
    }
  }

  const unassignedTags = allTags.filter(
    (t) => !photoTags.some((pt) => pt.id === t.id)
  );
  const photoTagIds = new Set(photoTags.map((t) => t.id));

  if (!displayPhoto) {
    return null;
  }

  const dateStr = exif?.dateTaken
    ? new Date(exif.dateTaken).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  const dirPath = displayPhoto.path.replace(/[/\\][^/\\]+$/, "");

  return (
    <div
      className="shrink-0 overflow-hidden"
      style={{ width: visible ? panelWidth : 0 }}
    >
      <div
        className={`relative flex h-full flex-col border-border border-l bg-secondary transition-[opacity,transform] duration-200 ease-out ${
          visible ? "translate-x-0 opacity-100" : "translate-x-4 opacity-0"
        }`}
        ref={panelRef}
        style={{ width: panelWidth }}
      >
      {/* Resize handle — drag left edge to resize */}
      <div
        className={`absolute top-0 -left-0.5 z-10 h-full w-1 cursor-col-resize transition-colors ${
          resizing ? "bg-primary" : "hover:bg-primary/50"
        }`}
        onMouseDown={handleResizeStart}
      />
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-4 py-3">
        <h3 className="font-[590] text-[14px] text-foreground">
          {t("photoDetail")}
        </h3>
        <button
          className="flex h-6 w-6 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          onClick={onClose}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Preview image */}
      <div className="border-border border-b bg-background p-4">
        <div className="flex items-center justify-center overflow-hidden rounded-[6px] bg-muted">
          <img
            alt={displayPhoto.filename}
            className="max-h-[200px] object-contain"
            src={toLocalMediaUrl(displayPhoto.path)}
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {/* Basic Info */}
        <section>
          <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
            {t("photoInfo")}
          </h4>
          <div className="space-y-1.5">
            <InfoRow label={t("filePath")} value={displayPhoto.filename} />
            <InfoRow
              label={t("dimensions")}
              value={`${displayPhoto.width} × ${displayPhoto.height}`}
            />
            <InfoRow
              label={t("fileSize")}
              value={formatFileSize(displayPhoto.fileSize)}
            />
            {dateStr && <InfoRow label={t("dateTaken")} value={dateStr} />}
          </div>
        </section>

        {/* Tags */}
        <section>
          <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
            标签
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {photoTags.map((tag) => {
              const unconfirmed = tag.isConfirmed === false;
              return (
                <span className="group relative flex items-center gap-0.5" key={tag.id}>
                  <button
                    className={`flex items-center gap-0.5 rounded-[4px] px-1.5 py-0.5 text-[11px] text-white/90 ${
                      unconfirmed
                        ? "border border-dashed border-white/30 bg-white/5"
                        : "hover:opacity-80"
                    }`}
                    onClick={() => unconfirmed ? handleConfirmTag(tag.id) : handleRemoveTag(tag.id)}
                    style={
                      unconfirmed
                        ? undefined
                        : { background: tag.color || "var(--primary)" }
                    }
                    title={
                      unconfirmed
                        ? `AI 建议 (${tag.confidence ? Math.round(tag.confidence * 100) + "%" : ""}) — 点击确认`
                        : "点击移除"
                    }
                  >
                    {tag.name}
                    {unconfirmed ? (
                      <span className="ml-0.5 text-[10px] opacity-60">?</span>
                    ) : (
                      <X className="h-2.5 w-2.5 opacity-60" />
                    )}
                  </button>
                  {unconfirmed && (
                    <button
                      className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-muted text-[#6b6b75] opacity-0 transition-opacity hover:bg-[#e5484d] hover:text-white group-hover:opacity-100"
                      onClick={() => handleRemoveTag(tag.id)}
                      title="移除"
                    >
                      <X className="h-2 w-2" />
                    </button>
                  )}
                </span>
              );
            })}
            <button
              className="rounded-[4px] border border-input border-dashed px-1.5 py-0.5 text-[#6b6b75] text-[11px] hover:border-muted-foreground hover:text-muted-foreground"
              onClick={() => setShowTagInput(true)}
            >
              + 添加
            </button>
          </div>

          {/* Tag suggestions / create new */}
          {showTagInput && (
            <div className="mt-2">
              {unassignedTags.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-1">
                  {unassignedTags.map((tag) => (
                    <button
                      className="rounded-[4px] px-1.5 py-0.5 text-[10px] text-white/70 hover:opacity-90"
                      key={tag.id}
                      onClick={() => {
                        handleAddTag(tag.id);
                        setShowTagInput(false);
                      }}
                      style={{
                        background: tag.color
                          ? `${tag.color}66`
                          : "rgba(94,106,210,0.4)",
                      }}
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1">
                <input
                  className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={handleTagInputKeyDown}
                  placeholder="输入新标签名称..."
                  ref={tagInputRef}
                  value={newTagName}
                />
                <button
                  className="flex h-7 w-7 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-30"
                  disabled={!newTagName.trim()}
                  onClick={handleCreateTag}
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* AI Tag Suggestions */}
        <section>
          <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
            AI 建议标签
          </h4>
          {aiSuggestions === null && !aiLoading ? (
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
              onClick={handleAiSuggest}
            >
              <Sparkles className="h-3.5 w-3.5" />
              分析建议标签
            </button>
          ) : aiLoading ? (
            <div className="flex items-center gap-2 py-2">
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <span className="text-[#6b6b75] text-[11px]">AI 分析中...</span>
            </div>
          ) : aiSuggestions!.length === 0 ? (
            <div className="flex items-center gap-2">
              <p className="text-[#6b6b75] text-[11px]">未识别到合适的标签</p>
              <button
                className="text-primary text-[11px] hover:underline"
                onClick={() => {
                  setAiSuggestions(null);
                }}
              >
                重试
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {aiSuggestions!.map((s) => {
                const alreadyApplied = photoTagIds.has(
                  allTags.find((t) => t.name === s.tag)?.id ?? -1
                );
                return (
                  <button
                    className={`rounded-[4px] px-1.5 py-0.5 text-[11px] transition-opacity hover:opacity-80 ${alreadyApplied ? "cursor-default opacity-30" : ""}`}
                    disabled={alreadyApplied}
                    key={s.tag}
                    onClick={() => handleApplySuggestion(s.tag)}
                    title={`置信度: ${Math.round(s.confidence * 100)}%`}
                  >
                    <span
                      className="rounded-[4px] px-1 py-0.5"
                      style={{
                        background: alreadyApplied
                          ? "rgba(255,255,255,0.08)"
                          : `rgba(94,106,210,${0.3 + s.confidence * 0.6})`,
                      }}
                    >
                      {s.tag}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        {/* EXIF Info */}
        {loading ? (
          <section>
            <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
              {t("exifInfo")}
            </h4>
            <div className="flex items-center justify-center py-6">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            </div>
          </section>
        ) : exif ? (
          <section>
            <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
              {t("exifInfo")}
            </h4>
            <div className="space-y-1.5">
              {exif.cameraModel && (
                <InfoRow
                  label={t("camera")}
                  value={
                    exif.cameraMake
                      ? `${exif.cameraMake} ${exif.cameraModel}`
                      : exif.cameraModel
                  }
                />
              )}
              {(exif.lensModel || exif.lensMake) && (
                <InfoRow
                  label={t("lens")}
                  value={
                    [exif.lensMake, exif.lensModel].filter(Boolean).join(" ") ||
                    "—"
                  }
                />
              )}
              {exif.focalLength && (
                <InfoRow
                  label={t("focalLength")}
                  value={`${exif.focalLength}mm`}
                />
              )}
              {exif.aperture && (
                <InfoRow label={t("aperture")} value={`f/${exif.aperture}`} />
              )}
              {exif.shutterSpeed && (
                <InfoRow label={t("shutter")} value={`${exif.shutterSpeed}s`} />
              )}
              {exif.iso && (
                <InfoRow label={t("iso")} value={exif.iso.toString()} />
              )}
              {exif.gpsLatitude && exif.gpsLongitude && (
                <InfoRow
                  label="GPS"
                  value={`${exif.gpsLatitude.toFixed(4)}, ${exif.gpsLongitude.toFixed(4)}`}
                />
              )}
              {exif.software && (
                <InfoRow label="Software" value={exif.software} />
              )}
            </div>
          </section>
        ) : (
          <section>
            <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
              {t("exifInfo")}
            </h4>
            <p className="text-[#6b6b75] text-[12px]">{t("noExifData")}</p>
          </section>
        )}

        {/* File Location */}
        <section>
          <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
            {t("filePath")}
          </h4>
          <p className="mb-2 truncate text-[11px] text-muted-foreground">
            {dirPath}
          </p>
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
            onClick={() => onOpenExplorer(displayPhoto.path)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("openInExplorer")}
          </button>
        </section>
      </div>
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="flex-shrink-0 text-[#6b6b75] text-[11px]">{label}</span>
      <span className="truncate text-right text-[#a1a1aa] text-[11px]">
        {value}
      </span>
    </div>
  );
}

// Deterministic color from tag name
function getTagColor(name: string): string {
  const colors = [
    "#5e6ad2",
    "#46a758",
    "#ffb224",
    "#e5484d",
    "#7c7fe0",
    "#3b9ec6",
    "#d97a3e",
    "#a855f7",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  return colors[Math.abs(hash) % colors.length];
}
