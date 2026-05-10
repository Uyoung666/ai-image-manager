import { FolderOpen, Plus, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

interface PhotoDetail {
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  path: string;
  width: number;
  format?: string;
}

interface ExifData {
  aperture: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  dateTaken: number | null;
  focalLength: string | null;
  iso: number | null;
  lensMake: string | null;
  lensModel: string | null;
  orientation: number | null;
  shutterSpeed: string | null;
  gpsLatitude: number | null;
  gpsLongitude: number | null;
  software: string | null;
}

interface TagInfo {
  color: string | null;
  id: number;
  name: string;
}

interface PhotoDetailPanelProps {
  onClose: () => void;
  onOpenExplorer: (path: string) => void;
  photo: PhotoDetail | null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const tagInputRef = useRef<HTMLInputElement>(null);

  const loadTags = useCallback(async () => {
    if (!photo) return;
    try {
      const [pTags, aTags] = await Promise.all([
        ipc.client.photos.getPhotoTags({ id: photo.id }),
        ipc.client.photos.getTags({}),
      ]);
      setPhotoTags((pTags as TagInfo[]) || []);
      setAllTags((aTags as TagInfo[]) || []);
    } catch {
      /* ignore */
    }
  }, [photo]);

  useEffect(() => {
    if (!photo) return;
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
    if (!photo) return;
    try {
      await ipc.client.photos.setPhotoTag({ photoId: photo.id, tagId });
      loadTags();
    } catch {
      /* ignore */
    }
  }

  async function handleRemoveTag(tagId: number) {
    if (!photo) return;
    try {
      await ipc.client.photos.removePhotoTag({ photoId: photo.id, tagId });
      loadTags();
    } catch {
      /* ignore */
    }
  }

  async function handleCreateTag() {
    const name = newTagName.trim();
    if (!name || !photo) return;
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

  if (!photo) return null;

  const dateStr = exif?.dateTaken
    ? new Date(exif.dateTaken).toLocaleDateString("zh-CN", {
        year: "numeric",
        month: "long",
        day: "numeric",
      })
    : null;

  const dirPath = photo.path.replace(/[/\\][^/\\]+$/, "");

  return (
    <div className="flex h-full w-[300px] shrink-0 flex-col border-border border-l bg-secondary">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-4 py-3">
        <h3 className="font-[590] text-foreground text-[14px]">
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
            alt={photo.filename}
            className="max-h-[200px] object-contain"
            src={toLocalMediaUrl(photo.path)}
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
            <InfoRow label={t("filePath")} value={photo.filename} />
            <InfoRow
              label={t("dimensions")}
              value={`${photo.width} × ${photo.height}`}
            />
            <InfoRow
              label={t("fileSize")}
              value={formatFileSize(photo.fileSize)}
            />
            {dateStr && (
              <InfoRow label={t("dateTaken")} value={dateStr} />
            )}
          </div>
        </section>

        {/* Tags */}
        <section>
          <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
            标签
          </h4>
          <div className="flex flex-wrap gap-1.5">
            {photoTags.map((tag) => (
              <button
                className="flex items-center gap-0.5 rounded-[4px] px-1.5 py-0.5 text-[11px] text-white/90 hover:opacity-80"
                key={tag.id}
                onClick={() => handleRemoveTag(tag.id)}
                style={{
                  background: tag.color || "#5e6ad2",
                }}
              >
                {tag.name}
                <X className="h-2.5 w-2.5 opacity-60" />
              </button>
            ))}
            <button
              className="rounded-[4px] border border-dashed border-input px-1.5 py-0.5 text-[#6b6b75] text-[11px] hover:border-muted-foreground hover:text-muted-foreground"
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
                  className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-foreground text-[12px] outline-none placeholder:text-[#6b6b75] focus:border-primary"
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

        {/* EXIF Info */}
        {loading ? (
          <section>
            <h4 className="mb-2 font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
              {t("exifInfo")}
            </h4>
            <div className="flex items-center justify-center py-6">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-[#5e6ad2] border-t-transparent" />
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
                    [exif.lensMake, exif.lensModel]
                      .filter(Boolean)
                      .join(" ") || "—"
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
                <InfoRow
                  label={t("aperture")}
                  value={`f/${exif.aperture}`}
                />
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
          <p className="mb-2 truncate text-muted-foreground text-[11px]">{dirPath}</p>
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-input px-3 py-1.5 text-muted-foreground text-[12px] transition-colors hover:border-muted-foreground hover:text-foreground"
            onClick={() => onOpenExplorer(photo.path)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {t("openInExplorer")}
          </button>
        </section>
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
