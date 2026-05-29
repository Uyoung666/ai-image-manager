import {
  CheckCircle2,
  HelpCircle,
  Link,
  Swords,
  Undo2,
  Unlink,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ZoomableImage, type ZoomState } from "@/components/ZoomableImage";
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

interface PairItem {
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

interface CullDuelProps {
  onUpdate: (delta: CullDelta) => void;
  session: {
    id: number;
    mode: string;
    pkMode?: string;
    totalPhotos: number;
    completedComparisons: number;
    status?: "active" | "completed";
  };
}

const FATIGUE_THRESHOLD = 100;
const MAX_FATIGUE_REMINDERS = 2;

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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(0)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function CullDuel({ session, onUpdate }: CullDuelProps) {
  const { t } = useTranslation();
  const [pair, setPair] = useState<[PairItem, PairItem] | null>(null);
  const [loading, setLoading] = useState(true);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stats, setStats] = useState<{
    total: number;
    completed: number;
    remaining: number;
    ready?: number;
  } | null>(null);
  const submittingRef = useRef(false);
  const loadPairRef = useRef<(() => Promise<void>) | null>(null);
  const [finishConfirmOpen, setFinishConfirmOpen] = useState(false);
  const [lastReason, setLastReason] = useState<string | null>(null);
  const isSessionCompleted = done || session.status === "completed";

  // Phase 3: EXIF
  const [exifLeft, setExifLeft] = useState<ExifData | null>(null);
  const [exifRight, setExifRight] = useState<ExifData | null>(null);

  // Phase 3: Sync zoom — share full ZoomState (scale + translate)
  // Only enable by default when both photos have the same aspect ratio
  const [syncZoom, setSyncZoom] = useState(true);
  const [syncState, setSyncState] = useState<ZoomState | null>(null);
  const syncStateRef = useRef<ZoomState | null>(null);

  // Detect if left/right photos have the same aspect ratio
  const sameRatio = pair
    ? Math.abs(
        pair[0].photo.width / pair[0].photo.height -
          pair[1].photo.width / pair[1].photo.height
      ) < 0.02
    : false;

  // If ratios differ, force sync off
  const effectiveSync = syncZoom && sameRatio;

  // Phase 3: Shortcuts dialog (guarded via ref to avoid stale closures)
  const shortcutsOpenRef = useRef(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const finishConfirmOpenRef = useRef(false);
  finishConfirmOpenRef.current = finishConfirmOpen;
  const fatigueOpenRef = useRef(false);

  // Phase 3: Fatigue
  const [fatigueOpen, setFatigueOpen] = useState(false);
  const comparisonCountRef = useRef(0);
  const fatigueRemindersRef = useRef(0);

  // Reset fatigue counters when switching sessions
  useEffect(() => {
    comparisonCountRef.current = 0;
    fatigueRemindersRef.current = 0;
  }, [session.id]);

  // Phase 3: Pair index — used as key to force ZoomableImage remount on every new pair
  const pairIndexRef = useRef(0);

  async function loadExif(photoId: number): Promise<ExifData | null> {
    try {
      const result = await ipc.client.photos.getPhotoExif({ id: photoId });
      return result as ExifData | null;
    } catch {
      return null;
    }
  }

  const initialLoadRef = useRef(true);

  const loadPair = useCallback(async () => {
    if (session.status === "completed") {
      setDone(true);
      setLoading(false);
      setStats(
        (current) =>
          current ?? {
            total: session.totalPhotos,
            completed: session.completedComparisons,
            remaining: 0,
          }
      );
      return;
    }
    // Only show spinner on first load; transitions keep old pair visible
    if (initialLoadRef.current) {
      setLoading(true);
    }
    try {
      const result = (await ipc.client.cull.getNextPair({
        sessionId: session.id,
      })) as {
        done: boolean;
        pair?: PairItem[];
        stats: {
          total: number;
          completed: number;
          remaining: number;
          ready?: number;
        };
        reason?: string;
      };
      if (result.done || !result.pair || result.pair.length < 2) {
        setDone(true);
        setStats(result.stats);
      } else {
        const [a, b] = result.pair;
        pairIndexRef.current++;
        preloadImage(a.photo.thumbnailPath ?? a.photo.path);
        preloadImage(b.photo.thumbnailPath ?? b.photo.path);
        setPair([a, b]);
        setStats(result.stats);
        setDone(false);
        setSyncState(null);
        if (result.reason) {
          setLastReason(result.reason);
        }

        const [exifA, exifB] = await Promise.all([
          loadExif(a.photo.id),
          loadExif(b.photo.id),
        ]);
        setExifLeft(exifA);
        setExifRight(exifB);

        comparisonCountRef.current++;
        if (
          fatigueRemindersRef.current < MAX_FATIGUE_REMINDERS &&
          comparisonCountRef.current > 0 &&
          comparisonCountRef.current % FATIGUE_THRESHOLD === 0
        ) {
          fatigueRemindersRef.current++;
          setFatigueOpen(true);
        }
      }
    } catch (err) {
      console.error("[loadPair] failed:", err);
    } finally {
      initialLoadRef.current = false;
      setLoading(false);
    }
  }, [
    session.completedComparisons,
    session.id,
    session.status,
    session.totalPhotos,
  ]);

  useEffect(() => {
    loadPairRef.current = loadPair;
  }, [loadPair]);

  useEffect(() => {
    loadPair();
  }, [loadPair]);

  async function handlePick(winnerIdx: 0 | 1) {
    if (!pair || isSessionCompleted || submittingRef.current) {
      return;
    }
    const winner = pair[winnerIdx];
    const loser = pair[1 - winnerIdx];
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await ipc.client.cull.submitComparison({
        sessionId: session.id,
        winnerId: winner.sessionPhotoId,
        loserId: loser.sessionPhotoId,
      });
      onUpdate({ type: "comparison" });
      await loadPairRef.current?.();
    } catch (err) {
      console.error("[handlePick] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleSkip() {
    if (!pair || isSessionCompleted || submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await ipc.client.cull.recordSkip({
        sessionId: session.id,
        photoAId: pair[0].sessionPhotoId,
        photoBId: pair[1].sessionPhotoId,
      });
      onUpdate({ type: "comparison" });
      await loadPairRef.current?.();
    } catch (err) {
      console.error("[handleSkip] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleUndo() {
    if (isSessionCompleted || submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await ipc.client.cull.undoLastAction({ sessionId: session.id });
      onUpdate({ type: "undo" });
      await loadPairRef.current?.();
    } catch {
      // ignore
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
      setFatigueOpen(false);
    } catch (err) {
      console.error("[handleFinish] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  async function handleDraw() {
    if (!pair || isSessionCompleted || submittingRef.current) {
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      await ipc.client.cull.submitComparison({
        sessionId: session.id,
        winnerId: pair[0].sessionPhotoId,
        loserId: pair[1].sessionPhotoId,
        isDraw: true,
      });
      onUpdate({ type: "comparison" });
      await loadPairRef.current?.();
    } catch (err) {
      console.error("[handleDraw] failed:", err);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  // Keyboard shortcuts — use refs to avoid stale closure issues
  const handlePickRef = useRef(handlePick);
  handlePickRef.current = handlePick;
  const handleSkipRef = useRef(handleSkip);
  handleSkipRef.current = handleSkip;
  const handleUndoRef = useRef(handleUndo);
  handleUndoRef.current = handleUndo;
  const handleDrawRef = useRef(handleDraw);
  handleDrawRef.current = handleDraw;

  useEffect(() => {
    // Use capture phase so "?" is consumed before base-layout's bubble handler fires
    function onKey(e: KeyboardEvent) {
      // Block all shortcuts when any dialog is open
      if (
        shortcutsOpenRef.current ||
        fatigueOpenRef.current ||
        finishConfirmOpenRef.current
      ) {
        return;
      }
      if (isSessionCompleted) {
        return;
      }
      // Don't fire when typing in input fields
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
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePickRef.current(0);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handlePickRef.current(1);
      } else if (e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        handleSkipRef.current();
      } else if (e.key === "z" && e.ctrlKey) {
        e.preventDefault();
        handleUndoRef.current();
      } else if (e.key === "d" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleDrawRef.current();
      }
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isSessionCompleted]);

  // Sync shortcutsOpen state to ref
  useEffect(() => {
    shortcutsOpenRef.current = shortcutsOpen;
  }, [shortcutsOpen]);

  // Sync fatigueOpen state to ref
  useEffect(() => {
    fatigueOpenRef.current = fatigueOpen;
  }, [fatigueOpen]);

  if (done) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center">
          <Swords className="mx-auto h-12 w-12 text-success/50" />
          <p className="mt-4 font-[510] text-[16px] text-foreground">
            {t("cullAllComparisonsComplete")}
          </p>
          {stats && (
            <p className="mt-2 text-[13px] text-muted-foreground/70">
              {stats.total} {t("photos")} · {stats.completed} PKs
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!pair) {
    if (loading) {
      return (
        <div className="flex h-full items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      );
    }
    return null;
  }

  const [left, right] = pair;
  const pairKey = pairIndexRef.current;

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

  function renderExifInfo(exif: ExifData | null, photo: PhotoInfo) {
    return (
      <div className="mt-2 flex max-w-[400px] flex-wrap items-center justify-center gap-x-3 gap-y-0.5">
        {exif ? (
          <>
            {renderExifRow(t("cullFileName"), photo.filename)}
            {renderExifRow(t("cullDateTaken"), formatExifDate(exif.dateTaken))}
            {renderExifRow(
              t("cullDimensions"),
              `${photo.width}×${photo.height}`
            )}
            {renderExifRow(t("cullSize"), formatFileSize(photo.fileSize))}
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
      </div>
    );
  }

  return (
    <div className="relative flex h-full flex-col">
      {/* Top bar */}
      <div className="flex items-center justify-between border-border border-b px-6 py-2">
        <span className="text-[11px] text-muted-foreground/70">
          {(() => {
            const pkCount = stats?.completed ?? session.completedComparisons;
            const totalPhotos = stats?.total ?? session.totalPhotos;
            const minC =
              session.pkMode === "quick"
                ? 5
                : session.pkMode === "fine"
                  ? 12
                  : 8;
            const recompareBudget =
              session.pkMode === "quick"
                ? 0
                : session.pkMode === "fine"
                  ? Math.ceil(totalPhotos * 0.3)
                  : Math.ceil(totalPhotos * 0.15);
            const totalWork = Math.max(
              1,
              Math.ceil((totalPhotos * minC) / 2) + recompareBudget
            );
            const pct = Math.min(100, Math.round((pkCount / totalWork) * 100));
            const remainingPks = Math.max(0, totalWork - pkCount);
            return `${pkCount} / ~${totalWork} PKs (${pct}%) · 剩余 ~${remainingPks} 次`;
          })()}
        </span>
        <span className="ml-2 rounded-[3px] bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {(() => {
            const labels: Record<string, string> = {
              quick: t("cullPkModeQuick"),
              standard: t("cullPkModeStandard"),
              fine: t("cullPkModeFine"),
            };
            return (
              labels[session.pkMode ?? "standard"] ?? t("cullPkModeStandard")
            );
          })()}
        </span>
        <div className="flex items-center gap-2">
          {sameRatio && (
            <button
              className="flex items-center gap-1 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => {
                setSyncZoom((v) => !v);
                setSyncState(null);
                syncStateRef.current = null;
              }}
              title={t("cullSyncZoomDesc")}
            >
              {syncZoom ? (
                <Link className="h-3 w-3" />
              ) : (
                <Unlink className="h-3 w-3" />
              )}
            </button>
          )}
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
            <CheckCircle2 className="h-3 w-3" />
            {t("cullFinish")}
          </button>
          <button
            className="flex items-center gap-1 rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
            disabled={submitting}
            onClick={handleUndo}
          >
            <Undo2 className="h-3 w-3" />
            {t("cullUndo")} (Ctrl+Z)
          </button>
        </div>
      </div>

      {/* Comparison area */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left photo */}
        <div
          className="flex flex-1 cursor-pointer flex-col items-center justify-center overflow-hidden border-border border-r p-4 transition-colors focus:outline-none hover:bg-primary/5"
          onClick={(e) => {
            if (e.detail !== 1) {
              return;
            }
            if (
              e.target instanceof HTMLElement &&
              e.target.closest("[data-zoom]")
            ) {
              return;
            }
            handlePick(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handlePick(0);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="min-h-0 flex-1" data-zoom>
            <ZoomableImage
              alt={left.photo.filename}
              filePath={left.photo.path}
              key={`L-${pairKey}`}
              onSync={(s) => {
                if (!effectiveSync) {
                  return;
                }
                const prev = syncStateRef.current;
                if (
                  prev &&
                  prev.scale === s.scale &&
                  prev.translate.x === s.translate.x &&
                  prev.translate.y === s.translate.y
                ) {
                  return;
                }
                syncStateRef.current = s;
                setSyncState(s);
              }}
              syncState={effectiveSync ? syncState : null}
              thumbnailPath={left.photo.thumbnailPath}
            />
          </div>
          <div className="mt-2 shrink-0 text-center">
            {renderExifInfo(exifLeft, left.photo)}
            <div className="mt-1 flex items-center justify-center gap-3 text-[10px] text-muted-foreground/60">
              <span>
                {t("cullRating")}: {left.rating}
              </span>
              <span>
                {t("cullWins")}: {left.wins}
              </span>
              <span>
                {t("cullLosses")}: {left.losses}
              </span>
            </div>
          </div>
          <div className="mt-2 shrink-0 rounded-[6px] bg-primary/10 px-4 py-2 font-[510] text-[13px] text-primary transition-colors hover:bg-primary/20">
            {t("cullPickLeft")} ←
          </div>
        </div>

        {/* VS divider */}
        <div className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 select-none rounded-full border border-border bg-background px-3 py-1.5 font-[590] text-[11px] text-muted-foreground shadow-sm">
          VS
        </div>

        {/* Right photo */}
        <div
          className="flex flex-1 cursor-pointer flex-col items-center justify-center overflow-hidden p-4 transition-colors focus:outline-none hover:bg-primary/5"
          onClick={(e) => {
            if (e.detail !== 1) {
              return;
            }
            if (
              e.target instanceof HTMLElement &&
              e.target.closest("[data-zoom]")
            ) {
              return;
            }
            handlePick(1);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              handlePick(1);
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="min-h-0 flex-1" data-zoom>
            <ZoomableImage
              alt={right.photo.filename}
              filePath={right.photo.path}
              key={`R-${pairKey}`}
              onSync={(s) => {
                if (!effectiveSync) {
                  return;
                }
                const prev = syncStateRef.current;
                if (
                  prev &&
                  prev.scale === s.scale &&
                  prev.translate.x === s.translate.x &&
                  prev.translate.y === s.translate.y
                ) {
                  return;
                }
                syncStateRef.current = s;
                setSyncState(s);
              }}
              syncState={effectiveSync ? syncState : null}
              thumbnailPath={right.photo.thumbnailPath}
            />
          </div>
          <div className="mt-2 shrink-0 text-center">
            {renderExifInfo(exifRight, right.photo)}
            <div className="mt-1 flex items-center justify-center gap-3 text-[10px] text-muted-foreground/60">
              <span>
                {t("cullRating")}: {right.rating}
              </span>
              <span>
                {t("cullWins")}: {right.wins}
              </span>
              <span>
                {t("cullLosses")}: {right.losses}
              </span>
            </div>
          </div>
          <div className="mt-2 shrink-0 rounded-[6px] bg-primary/10 px-4 py-2 font-[510] text-[13px] text-primary transition-colors hover:bg-primary/20">
            → {t("cullPickRight")}
          </div>
        </div>
      </div>

      {/* Bottom bar */}
      <div className="flex items-center justify-center gap-4 border-border border-t px-6 py-3">
        <button
          className="rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={handleSkip}
        >
          {t("cullSkip")} (Space)
        </button>
        <button
          className="rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          onClick={handleDraw}
        >
          {t("cullDraw")} (D)
        </button>
        {lastReason && (
          <span className="ml-auto text-[10px] text-muted-foreground/40">
            {t("cullNextPairReason")}: {lastReason}
          </span>
        )}
      </div>


      {/* Finish confirm dialog */}
      {finishConfirmOpen && (
        <Dialog onOpenChange={setFinishConfirmOpen} open={finishConfirmOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("cullFinishConfirmTitle")}</DialogTitle>
              <DialogDescription>
                {(stats?.ready ?? 0) < (stats?.total ?? session.totalPhotos)
                  ? t("cullFinishConfirmIncomplete", {
                      ready: stats?.ready ?? 0,
                      total: stats?.total ?? session.totalPhotos,
                    })
                  : t("cullFinishConfirmComplete")}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
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
            </DialogFooter>
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
                  ←
                </kbd>{" "}
                <span>{t("cullPickLeft")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  →
                </kbd>{" "}
                <span>{t("cullPickRight")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  Space
                </kbd>{" "}
                <span>{t("cullSkip")}</span>
              </p>
              <p className="flex justify-between">
                <kbd className="rounded-[3px] bg-muted px-1.5 text-[11px]">
                  D
                </kbd>{" "}
                <span>{t("cullDraw")}</span>
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

      {/* Fatigue reminder */}
      {fatigueOpen && (
        <Dialog onOpenChange={setFatigueOpen} open={fatigueOpen}>
          <DialogContent className="max-w-[340px]">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Swords className="h-4 w-4 text-primary" />
                {t("cullFatigueTitle")}
              </DialogTitle>
              <DialogDescription>{t("cullFatigueMsg")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <button
                className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={() => setFatigueOpen(false)}
              >
                {t("cullFatigueDismiss")}
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
