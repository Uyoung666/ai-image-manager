import {
  CheckCircle,
  Eye,
  Heart,
  HelpCircle,
  SkipForward,
  Trash2,
  Undo2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ZoomableImage } from "@/components/ZoomableImage";
import { ipc } from "@/ipc/manager";
import type { CullDelta } from "@/routes/cull.$sessionId";
import { preloadImage } from "@/utils/local-media-url";

interface PhotoInfo {
  fileDate: number | null;
  filename: string;
  fileSize: number;
  format: string;
  height: number;
  id: number;
  isFavorite: boolean | null;
  isIndexed: boolean;
  path: string;
  thumbnailPath: string | null;
  width: number;
}

interface SingleItem {
  comparisons: number;
  losses: number;
  photo: PhotoInfo;
  rating: number;
  sessionPhotoId: number;
  wins: number;
}

interface ExifData {
  aperture: number | null;
  cameraMake: string | null;
  cameraModel: string | null;
  dateTaken: number | null;
  focalLength: string | null;
  iso: number | null;
  lensModel: string | null;
  shutterSpeed: string | null;
}

interface CullCurateProps {
  onUpdate: (delta: CullDelta) => void;
  session: {
    id: number;
    mode: string;
    totalPhotos: number;
    completedComparisons: number;
    items?: { status: string }[];
  };
}

function formatExifDate(ts: number | null): string {
  if (!ts) {
    return "";
  }
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function CullCurate({ session, onUpdate }: CullCurateProps) {
  const { t } = useTranslation();
  const [item, setItem] = useState<SingleItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [stats, setStats] = useState<{
    total: number;
    completed: number;
    remaining: number;
  } | null>(null);
  const [exif, setExif] = useState<ExifData | null>(null);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [similarCount, setSimilarCount] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const shortcutsOpenRef = useRef(false);
  const finishConfirmOpenRef = useRef(false);
  finishConfirmOpenRef.current = finishConfirmOpen;
  shortcutsOpenRef.current = shortcutsOpen;
  const initialLoadRef = useRef(true);
  const loadNextRef = useRef<(() => Promise<void>) | null>(null);

  async function loadExif(photoId: number): Promise<ExifData | null> {
    try {
      const result = await ipc.client.photos.getPhotoExif({ id: photoId });
      return result as ExifData | null;
    } catch {
      return null;
    }
  }

  const loadNext = useCallback(async () => {
    setLoading(initialLoadRef.current);
    try {
      const result = (await ipc.client.cull.getNextPair({
        sessionId: session.id,
      })) as {
        done: boolean;
        single?: SingleItem;
        similarCount?: number;
        stats: { total: number; completed: number; remaining: number };
      };
      if (result.done || !result.single) {
        setDone(true);
        setStats(result.stats);
      } else {
        preloadImage(result.single.photo.thumbnailPath ?? result.single.photo.path);
        setItem(result.single);
        setStats(result.stats);
        setSimilarCount((result as any).similarCount ?? 0);
        setDone(false);
        const exifData = await loadExif(result.single.photo.id);
        setExif(exifData);
      }
    } catch (err) {
      console.error("[loadNext] failed:", err);
    } finally {
      initialLoadRef.current = false;
      setLoading(false);
    }
  }, [session.id]);

  useEffect(() => {
    loadNextRef.current = loadNext;
  }, [loadNext]);

  useEffect(() => {
    loadNext();
  }, [loadNext]);

  async function handleAction(status: "kept" | "rejected") {
    if (!item || submittingRef.current) {
      return;
    }
    const currentItem = item;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      if (status === "kept") {
        await Promise.all([
          ipc.client.photos.toggleFavorite({
            ids: [currentItem.photo.id],
            favorite: true,
          }),
          ipc.client.cull.updatePhotoStatus({
            sessionId: session.id,
            photoId: currentItem.sessionPhotoId,
            status,
          }),
        ]);
        toast.success(t("toastFavoriteAdded"));
      } else {
        await ipc.client.cull.updatePhotoStatus({
          sessionId: session.id,
          photoId: currentItem.sessionPhotoId,
          status,
        });
      }
      onUpdate(
        status === "kept"
          ? { type: "keep", sessionPhotoId: currentItem.sessionPhotoId }
          : { type: "reject", sessionPhotoId: currentItem.sessionPhotoId }
      );
      await loadNextRef.current?.();
    } catch (err) {
      console.error("[handleAction] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleUndo() {
    if (submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = (await ipc.client.cull.undoLastAction({
        sessionId: session.id,
      })) as { success: boolean };
      if (result.success) {
        onUpdate({ type: "undo" });
        await loadNextRef.current?.();
      }
    } catch (err) {
      console.error("[handleUndo] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleFinish() {
    if (submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await ipc.client.cull.completeSession({ sessionId: session.id });
      onUpdate({ type: "finish" });
      setDone(true);
      setFinishConfirmOpen(false);
    } catch (err) {
      console.error("[handleFinish] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Keyboard shortcuts
  const handleActionRef = useRef(handleAction);
  handleActionRef.current = handleAction;
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const itemRef = useRef(item);
  itemRef.current = item;

  async function handleSkipSimilar() {
    if (submittingRef.current) {
      return;
    }
    const currentItem = itemRef.current;
    if (!currentItem) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const result = (await ipc.client.cull.skipSimilarPhotos({
        sessionId: session.id,
        photoId: currentItem.sessionPhotoId,
      })) as { skippedCount: number };
      if (result.skippedCount > 0) {
        toast.success(t("cullSkippedSimilar", { count: result.skippedCount }));
      }
      onUpdate({ type: "undo" });
      await loadNextRef.current?.();
    } catch (err) {
      console.error("[skipSimilarPhotos] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }
  const handleSkipRef = useRef(handleSkipSimilar);
  handleSkipRef.current = handleSkipSimilar;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (shortcutsOpenRef.current || finishConfirmOpenRef.current) {
        return;
      }
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement
      ) {
        return;
      }
      if (e.key === "?") {
        e.preventDefault();
        e.stopPropagation();
        shortcutsOpenRef.current = true;
        setShortcutsOpen(true);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleActionRef.current("kept");
      } else if (
        e.key === "ArrowLeft" ||
        e.key === "ArrowDown" ||
        e.key === " "
      ) {
        e.preventDefault();
        handleActionRef.current("rejected");
      } else if (e.key === "z" && e.ctrlKey) {
        e.preventDefault();
        handleUndoRef.current();
      } else if (e.key === "s" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleSkipRef.current();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  if (done) {
    const kc = session.items?.filter((i) => i.status === "kept").length ?? 0;
    const rc =
      session.items?.filter((i) => i.status === "rejected").length ?? 0;
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Eye className="mx-auto h-12 w-12 text-success/50" />
          <p className="mt-4 font-[510] text-[16px] text-foreground">
            {t("cullCurateComplete")}
          </p>
          <p className="mt-2 text-[13px] text-muted-foreground/70">
            {t("cullKeptCount", { count: kc })} ·{" "}
            {t("cullRejectedCount", { count: rc })}
          </p>
        </div>
      </div>
    );
  }

  if (!item) {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      );
    }
    return null;
  }

  function renderExifRow(label: string, value: string | null) {
    if (!value) {
      return null;
    }
    return (
      <span className="text-[10px] text-muted-foreground/50">
        {label}: {value}
      </span>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Top bar: progress + actions */}
      <div className="flex items-center justify-between border-border border-b px-6 py-2">
        <span className="text-[11px] text-muted-foreground/70">
          {t("cullCurateProgress", {
            done: stats?.completed ?? session.completedComparisons,
            total: stats?.total ?? session.totalPhotos,
          })}
        </span>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => {
              shortcutsOpenRef.current = true;
              setShortcutsOpen(true);
            }}
          >
            <HelpCircle className="h-3 w-3" />
          </button>
          <button
            className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={() => setFinishConfirmOpen(true)}
          >
            <CheckCircle className="h-3 w-3" />
            {t("cullFinish")}
          </button>
          <button
            className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            onClick={handleUndo}
          >
            <Undo2 className="h-3 w-3" />
            {t("cullUndo")} (Ctrl+Z)
          </button>
        </div>
      </div>

      {/* Photo */}
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <div
          className="flex h-full w-full items-center justify-center"
          data-zoom
        >
          <ZoomableImage
            alt={item.photo.filename}
            filePath={item.photo.path}
            key={item.photo.id}
            thumbnailPath={item.photo.thumbnailPath}
          />
        </div>
      </div>

      {/* EXIF info bar */}
      <div className="border-border border-t px-6 py-2">
        <div className="flex flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
          {exif ? (
            <>
              {renderExifRow(t("cullFileName"), item.photo.filename)}
              {renderExifRow(
                t("cullDateTaken"),
                formatExifDate(exif.dateTaken)
              )}
              {renderExifRow(
                t("cullDimensions"),
                `${item.photo.width}×${item.photo.height}`
              )}
              {renderExifRow(
                t("focalLength"),
                exif.focalLength ? `${exif.focalLength}mm` : null
              )}
              {renderExifRow(t("shutter"), exif.shutterSpeed)}
              {renderExifRow(
                t("iso"),
                exif.iso == null ? null : String(exif.iso)
              )}
              {renderExifRow(
                t("aperture"),
                exif.aperture == null ? null : `f/${exif.aperture}`
              )}
            </>
          ) : (
            <span className="text-[10px] text-muted-foreground/30">
              {t("cullNoExif")}
            </span>
          )}
          {similarCount > 0 && (
            <span className="text-[10px] text-primary">
              {t("cullSimilarPhotos")}: {similarCount}
            </span>
          )}
        </div>
      </div>

      {/* Action bar */}
      <div className="flex items-center justify-center gap-6 border-border border-t px-6 py-3">
        <button
          className="flex items-center gap-2 rounded-full border border-border px-4 py-2 text-[12px] text-muted-foreground transition-all hover:border-primary/30 hover:bg-primary/5"
          onClick={handleSkipSimilar}
        >
          <SkipForward className="h-4 w-4" />
          {t("cullSkipSimilar")} (S)
        </button>
        <button
          className="flex items-center gap-2 rounded-full border border-border px-5 py-2.5 text-[13px] text-muted-foreground transition-all hover:border-destructive/30 hover:bg-destructive/5 hover:text-destructive"
          onClick={() => handleAction("rejected")}
        >
          <Trash2 className="h-4 w-4" />
          {t("cullReject")} ← ↓
        </button>
        <button
          className="flex items-center gap-2 rounded-full border border-success/30 bg-success/5 px-6 py-3 font-[510] text-[14px] text-success transition-all hover:bg-success/10 hover:shadow-md"
          onClick={() => handleAction("kept")}
        >
          <Heart className="h-4 w-4" />
          {t("cullKeep")} →
        </button>
      </div>


      {/* Finish confirm dialog */}
      {finishConfirmOpen && (
        <Dialog onOpenChange={setFinishConfirmOpen} open={finishConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("cullFinishConfirmTitle")}</DialogTitle>
            </DialogHeader>
            <p className="text-[13px] text-muted-foreground">
              {t("cullCurateProgress", {
                done: stats?.completed ?? session.completedComparisons,
                total: stats?.total ?? session.totalPhotos,
              })}
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
                disabled={submitting}
                onClick={() => setFinishConfirmOpen(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={submitting}
                onClick={handleFinish}
              >
                {t("cullFinishAndViewResults")}
              </button>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Keyboard shortcuts dialog */}
      {shortcutsOpen && (
        <Dialog
          onOpenChange={(open) => {
            setShortcutsOpen(open);
            if (!open) {
              shortcutsOpenRef.current = false;
            }
          }}
          open={shortcutsOpen}
        >
          <DialogContent className="max-w-[360px]">
            <DialogHeader>
              <DialogTitle>{t("cullShortcuts")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 py-2 text-[12px] text-muted-foreground">
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  →
                </kbd>{" "}
                <span>{t("cullKeep")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  ← / ↓ / Space
                </kbd>{" "}
                <span>{t("cullReject")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  S
                </kbd>{" "}
                <span>{t("cullSkipSimilar")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Ctrl+Z
                </kbd>{" "}
                <span>{t("cullUndo")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Scroll
                </kbd>{" "}
                <span>{t("cullZoom100")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  DblClick
                </kbd>{" "}
                <span>{t("cullZoom100")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  ?
                </kbd>{" "}
                <span>{t("cullShortcuts")}</span>
              </p>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
