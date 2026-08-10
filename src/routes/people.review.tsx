import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  RotateCcw,
  User,
  UserPlus,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { faceActions } from "@/actions/faces";
import {
  type FaceCandidate,
  getContainFrame,
  getFaceReviewOverlayStyle,
} from "@/components/face-candidate-dialog";
import { RouteError } from "@/components/RouteError";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip as AppTooltip,
  TooltipContent as AppTooltipContent,
  TooltipTrigger as AppTooltipTrigger,
} from "@/components/ui/tooltip";
import { toLocalMediaUrl } from "@/utils/local-media-url";

type ReviewTab =
  | "all"
  | "ignored"
  | "low_confidence"
  | "removed_from_identity"
  | "unmatched";

interface IdentityOption {
  faceCount: number;
  id: number;
  name: string | null;
}

interface PhotoFace {
  bboxHeight: number;
  bboxWidth: number;
  bboxX: number;
  bboxY: number;
  detectionConfidence: number | null;
  faceIndex: number;
  id: number;
  identityId: number | null;
  identityName: string | null;
  status: "assigned" | "ignored" | "pending" | "skipped";
}

function photoFaceBoxClass(face: PhotoFace, active: boolean): string {
  if (active) {
    return "z-10 border-primary shadow-[0_0_0_2px_rgba(255,255,255,0.8),0_0_0_9999px_rgba(0,0,0,0.12)]";
  }
  if (face.status === "assigned") {
    return "border-emerald-400/80 bg-emerald-400/5";
  }
  if (face.status === "ignored") {
    return "border-amber-300/75 border-dashed bg-amber-300/5 hover:border-primary";
  }
  if (face.status === "skipped") {
    return "border-white/35 border-dashed bg-black/10";
  }
  return "border-white/75 bg-black/5 hover:border-primary";
}

function photoFaceChipClass(face: PhotoFace, activeId: number): string {
  if (face.id === activeId) {
    return "border-primary bg-primary/10 text-primary";
  }
  if (face.status === "assigned") {
    return "cursor-default border-emerald-500/30 bg-emerald-500/10 text-emerald-600";
  }
  if (face.status === "skipped") {
    return "cursor-default border-border/60 text-muted-foreground opacity-65";
  }
  return "border-border text-muted-foreground hover:border-primary/50 hover:text-foreground";
}

const PATH_SEPARATOR_RE = /[\\/]/;

function candidateFilename(candidate: FaceCandidate): string {
  return (
    candidate.photoPath.split(PATH_SEPARATOR_RE).pop() || candidate.photoPath
  );
}

function candidateReason(
  candidate: FaceCandidate,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (candidate.reason === "low_confidence") {
    return t("faceReviewLowConfidenceHint");
  }
  if (candidate.reason === "removed_from_identity") {
    return t("faceReviewRemovedHint", {
      name: candidate.sourceIdentityName || t("unnamedPerson"),
    });
  }
  if (candidate.reason === "ignored") {
    return t("faceReviewIgnoredHint");
  }
  if (candidate.bestIdentityName) {
    return t("faceReviewPossible", { name: candidate.bestIdentityName });
  }
  return t("faceReviewUnmatchedHint");
}

function FaceCrop({ candidate }: { candidate: FaceCandidate }) {
  const width = Math.max(candidate.photoWidth || 1, 1);
  const height = Math.max(candidate.photoHeight || 1, 1);
  const centerX = ((candidate.bboxX + candidate.bboxWidth / 2) / width) * 100;
  const centerY = ((candidate.bboxY + candidate.bboxHeight / 2) / height) * 100;
  const faceRatio = Math.max(
    candidate.bboxWidth / width,
    candidate.bboxHeight / height
  );
  const scale = Math.min(Math.max(1 / Math.max(faceRatio * 2.1, 0.01), 1.2), 5);
  return (
    <div className="relative aspect-square overflow-hidden rounded-[10px] bg-muted">
      <img
        alt=""
        className="h-full w-full object-cover"
        height={height}
        src={toLocalMediaUrl(candidate.thumbnailPath || candidate.photoPath)}
        style={{
          objectPosition: `${centerX}% ${centerY}%`,
          transform: `scale(${scale})`,
          transformOrigin: `${centerX}% ${centerY}%`,
        }}
        width={width}
      />
    </div>
  );
}

function ReviewPreview({
  candidate,
  faces,
  onSelectFace,
  reviewableFaceIds,
}: {
  candidate: FaceCandidate;
  faces: PhotoFace[];
  onSelectFace: (face: PhotoFace) => void;
  reviewableFaceIds: Set<number>;
}) {
  const { t } = useTranslation();
  const width = candidate.photoWidth || 1;
  const height = candidate.photoHeight || 1;
  const frame = getContainFrame(width, height);
  return (
    <div className="flex min-h-[220px] min-w-0 flex-1 items-center justify-center overflow-hidden rounded-[12px] border border-border bg-black/90 p-2 shadow-sm sm:min-h-[300px] sm:p-3 xl:min-h-0">
      <div className="relative aspect-[4/3] max-h-full w-full max-w-[min(1200px,calc((100dvh-14rem)*4/3))] overflow-hidden rounded-[8px] bg-black">
        <div className="absolute" style={frame}>
          <div className="relative h-full w-full">
            <img
              alt={candidateFilename(candidate)}
              className="h-full w-full object-contain"
              height={height}
              src={toLocalMediaUrl(candidate.photoPath)}
              width={width}
            />
            {faces.map((face) => {
              const active = face.id === candidate.id;
              const actionable = reviewableFaceIds.has(face.id);
              return (
                <button
                  aria-label={t("faceReviewFace", {
                    index: face.faceIndex + 1,
                  })}
                  className={`absolute rounded-[4px] border-2 transition-all ${photoFaceBoxClass(face, active)} ${actionable ? "cursor-pointer" : "cursor-default"}`}
                  disabled={!actionable}
                  key={face.id}
                  onClick={() => onSelectFace(face)}
                  style={getFaceReviewOverlayStyle(face, width, height)}
                  type="button"
                >
                  <span
                    className={`absolute -top-6 left-0 rounded px-1.5 py-0.5 text-[10px] text-white shadow ${
                      active ? "bg-primary" : "bg-black/70"
                    }`}
                  >
                    {face.faceIndex + 1}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function FaceReviewPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ReviewTab>("all");
  const [activeId, setActiveId] = useState<number | null>(null);
  const [selectedIdentity, setSelectedIdentity] = useState("");
  const [identityQuery, setIdentityQuery] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  const pendingQuery = useQuery({
    queryKey: ["faces", "review-queue", "pending"],
    queryFn: async () =>
      (await faceActions.listReviewQueue({
        status: "pending",
        limit: 500,
      })) as FaceCandidate[],
    staleTime: 0,
  });
  const ignoredQuery = useQuery({
    queryKey: ["faces", "review-queue", "ignored"],
    queryFn: async () =>
      (await faceActions.listReviewQueue({
        category: "ignored",
        status: "ignored",
        limit: 500,
      })) as FaceCandidate[],
    staleTime: 0,
  });
  const identitiesQuery = useQuery({
    queryKey: ["faces", "identities"],
    queryFn: async () =>
      (await faceActions.listIdentities()) as IdentityOption[],
    staleTime: 30_000,
  });

  const pending = pendingQuery.data ?? [];
  const ignored = ignoredQuery.data ?? [];
  const visibleCandidates = useMemo(() => {
    if (tab === "ignored") {
      return ignored;
    }
    if (tab === "all") {
      return pending;
    }
    return pending.filter((candidate) => candidate.reason === tab);
  }, [ignored, pending, tab]);
  const activeIndex = Math.max(
    0,
    visibleCandidates.findIndex((candidate) => candidate.id === activeId)
  );
  const activeCandidate = visibleCandidates[activeIndex] ?? null;
  const activeCandidateId = activeCandidate?.id;
  const photoGroups = useMemo(() => {
    const groups = new Map<number, FaceCandidate[]>();
    for (const candidate of visibleCandidates) {
      const group = groups.get(candidate.photoId);
      if (group) {
        group.push(candidate);
      } else {
        groups.set(candidate.photoId, [candidate]);
      }
    }
    return [...groups.values()];
  }, [visibleCandidates]);
  const activePhotoCandidates = useMemo(
    () =>
      activeCandidate
        ? visibleCandidates.filter(
            (candidate) => candidate.photoId === activeCandidate.photoId
          )
        : [],
    [activeCandidate, visibleCandidates]
  );
  const photoFacesQuery = useQuery({
    enabled: activeCandidate !== null,
    queryKey: ["faces", "photo-faces", activeCandidate?.photoId],
    queryFn: async () =>
      (await faceActions.listPhotoFaces(
        activeCandidate?.photoId ?? 0
      )) as PhotoFace[],
    staleTime: 0,
  });
  const photoFaces = useMemo<PhotoFace[]>(() => {
    if (photoFacesQuery.data) {
      return photoFacesQuery.data;
    }
    return activePhotoCandidates.map((face) => ({
      bboxHeight: face.bboxHeight,
      bboxWidth: face.bboxWidth,
      bboxX: face.bboxX,
      bboxY: face.bboxY,
      detectionConfidence: face.detectionConfidence,
      faceIndex: face.faceIndex,
      id: face.id,
      identityId: null,
      identityName: null,
      status: face.status === "ignored" ? "ignored" : "pending",
    }));
  }, [activePhotoCandidates, photoFacesQuery.data]);
  const reviewableFaceIds = useMemo(
    () => new Set([...pending, ...ignored].map((face) => face.id)),
    [ignored, pending]
  );

  useEffect(() => {
    if (!activeCandidate) {
      setActiveId(null);
      return;
    }
    setActiveId(activeCandidate.id);
  }, [activeCandidate]);

  useEffect(() => {
    if (activeCandidateId === undefined) {
      setSelectedIdentity("");
      setNewName("");
      setIdentityQuery("");
      return;
    }
    setSelectedIdentity("");
    setNewName("");
    setIdentityQuery("");
  }, [activeCandidateId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
        return;
      }
      if (event.key === "ArrowLeft") {
        setActiveId(
          visibleCandidates[Math.max(0, activeIndex - 1)]?.id ?? null
        );
      } else if (event.key === "ArrowRight") {
        setActiveId(
          visibleCandidates[
            Math.min(visibleCandidates.length - 1, activeIndex + 1)
          ]?.id ?? null
        );
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeIndex, visibleCandidates]);

  const identityOptions = useMemo(() => {
    const query = identityQuery.trim().toLocaleLowerCase();
    return (identitiesQuery.data ?? [])
      .filter(
        (identity) =>
          !query || identity.name?.toLocaleLowerCase().includes(query)
      )
      .slice(0, 100);
  }, [identitiesQuery.data, identityQuery]);

  const tabs: Array<{ count: number; key: ReviewTab; label: string }> = [
    { key: "all", label: t("faceReviewAll"), count: pending.length },
    {
      key: "unmatched",
      label: t("faceReviewUnmatched"),
      count: pending.filter((item) => item.reason === "unmatched").length,
    },
    {
      key: "low_confidence",
      label: t("faceReviewLowConfidence"),
      count: pending.filter((item) => item.reason === "low_confidence").length,
    },
    {
      key: "removed_from_identity",
      label: t("faceReviewRemoved"),
      count: pending.filter((item) => item.reason === "removed_from_identity")
        .length,
    },
    { key: "ignored", label: t("faceReviewIgnored"), count: ignored.length },
  ];

  async function refreshReviewData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["faces", "review-queue"] }),
      queryClient.invalidateQueries({ queryKey: ["faces", "identities"] }),
      queryClient.invalidateQueries({ queryKey: ["faces", "photo-faces"] }),
    ]);
  }

  async function runAction(action: () => Promise<unknown>, success: string) {
    if (!activeCandidate) {
      return;
    }
    setBusy(true);
    try {
      const nextInPhoto = activePhotoCandidates.find(
        (candidate) => candidate.id !== activeCandidate.id
      );
      const nextInQueue =
        visibleCandidates[activeIndex + 1] ??
        visibleCandidates[Math.max(0, activeIndex - 1)] ??
        null;
      await action();
      setActiveId(nextInPhoto?.id ?? nextInQueue?.id ?? null);
      toast.success(success);
      await refreshReviewData();
    } catch {
      toast.error(t("faceReviewActionFailed"));
    } finally {
      setBusy(false);
    }
  }

  const isLoading =
    pendingQuery.isLoading ||
    ignoredQuery.isLoading ||
    identitiesQuery.isLoading;
  const hasError =
    pendingQuery.isError || ignoredQuery.isError || identitiesQuery.isError;

  function selectPhotoFace(face: PhotoFace) {
    if (face.status === "assigned") {
      return;
    }
    const candidate = [...pending, ...ignored].find(
      (item) => item.id === face.id
    );
    if (!candidate) {
      return;
    }
    setTab(candidate.status === "ignored" ? "ignored" : "all");
    setActiveId(candidate.id);
  }

  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <header className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3 sm:px-6 sm:py-4">
        <div className="flex min-w-0 items-center gap-3">
          <AppTooltip>
            <AppTooltipTrigger asChild>
              <Button
                aria-label={t("back")}
                onClick={() => navigate({ to: "/people" })}
                size="icon-lg"
                variant="ghost"
              >
                <ArrowLeft />
              </Button>
            </AppTooltipTrigger>
            <AppTooltipContent>{t("back")}</AppTooltipContent>
          </AppTooltip>
          <div className="min-w-0">
            <h1 className="font-semibold text-[22px] text-foreground tracking-tight">
              {t("faceReviewTitle")}
            </h1>
            <p className="mt-0.5 truncate text-[12px] text-muted-foreground">
              {t("faceReviewPageDescription")}
            </p>
          </div>
        </div>
        <span className="rounded-full bg-primary/10 px-3 py-1 text-[12px] text-primary">
          {t("faceReviewRemainingSummary", {
            faces: pending.length,
            photos: new Set(pending.map((item) => item.photoId)).size,
          })}
        </span>
      </header>

      <div
        aria-label={t("faceReviewTitle")}
        className="flex max-w-full shrink-0 gap-1 overflow-x-auto border-border border-b px-4 py-2 sm:px-6"
        role="tablist"
      >
        {tabs.map((item) => (
          <button
            aria-selected={tab === item.key}
            className={`whitespace-nowrap rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
              tab === item.key
                ? "bg-secondary font-medium text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            }`}
            key={item.key}
            onClick={() => {
              setTab(item.key);
              setActiveId(null);
            }}
            role="tab"
            type="button"
          >
            {item.label}
            <span className="ml-1.5 text-[10px] text-muted-foreground">
              {item.count}
            </span>
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-muted-foreground">
          <LoadingSpinner />
          {t("faceReviewLoading")}
        </div>
      )}
      {!isLoading && hasError && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
          <p className="text-[13px]">{t("faceReviewLoadFailed")}</p>
          <Button
            onClick={() => {
              pendingQuery.refetch();
              ignoredQuery.refetch();
              identitiesQuery.refetch();
            }}
            variant="outline"
          >
            {t("retry")}
          </Button>
        </div>
      )}
      {!(isLoading || hasError || activeCandidate) && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-secondary">
            <Check className="h-6 w-6 text-primary" />
          </span>
          <p className="font-medium text-[14px] text-foreground">
            {pending.length === 0 && ignored.length === 0
              ? t("faceReviewNoPending")
              : t("faceReviewEmpty")}
          </p>
          <Button onClick={() => navigate({ to: "/people" })}>
            {t("backToPeople")}
          </Button>
        </div>
      )}

      {!(isLoading || hasError) && activeCandidate && (
        <main className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:gap-4 sm:p-4 xl:flex-row xl:overflow-hidden">
          <aside className="hidden w-28 shrink-0 flex-col gap-2 overflow-y-auto xl:flex">
            {photoGroups.map((group, index) => {
              const candidate = group[0];
              return (
                <button
                  aria-label={`${candidateFilename(candidate)} ${index + 1}`}
                  className={`relative aspect-[4/3] shrink-0 overflow-hidden rounded-[8px] border-2 bg-muted transition-colors ${
                    candidate.photoId === activeCandidate.photoId
                      ? "border-primary"
                      : "border-transparent hover:border-border"
                  }`}
                  key={candidate.photoId}
                  onClick={() => setActiveId(candidate.id)}
                  type="button"
                >
                  <img
                    alt=""
                    className="h-full w-full object-cover"
                    height={candidate.photoHeight || 1}
                    src={toLocalMediaUrl(
                      candidate.thumbnailPath || candidate.photoPath
                    )}
                    width={candidate.photoWidth || 1}
                  />
                  <span className="absolute right-1 bottom-1 rounded bg-black/75 px-1.5 py-0.5 text-[9px] text-white">
                    {t("faceReviewPendingFaceCount", { count: group.length })}
                  </span>
                </button>
              );
            })}
          </aside>

          <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
            <ReviewPreview
              candidate={activeCandidate}
              faces={photoFaces}
              onSelectFace={selectPhotoFace}
              reviewableFaceIds={reviewableFaceIds}
            />
            <div className="flex items-center gap-2 overflow-x-auto rounded-[8px] border border-border bg-card/60 p-2">
              <span className="shrink-0 px-1 text-[11px] text-muted-foreground">
                {t("faceReviewFacesInPhoto", { count: photoFaces.length })}
              </span>
              {photoFaces.map((face) => (
                <button
                  className={`flex min-w-0 shrink-0 items-center gap-2 rounded-[6px] border p-1.5 pr-2.5 text-left text-[11px] transition-colors ${photoFaceChipClass(face, activeCandidate.id)}`}
                  disabled={!reviewableFaceIds.has(face.id)}
                  key={face.id}
                  onClick={() => selectPhotoFace(face)}
                  type="button"
                >
                  <span className="block size-10 shrink-0 overflow-hidden rounded-[5px]">
                    <FaceCrop
                      candidate={{
                        ...activeCandidate,
                        bboxHeight: face.bboxHeight,
                        bboxWidth: face.bboxWidth,
                        bboxX: face.bboxX,
                        bboxY: face.bboxY,
                        faceIndex: face.faceIndex,
                        id: face.id,
                      }}
                    />
                  </span>
                  <span className="min-w-0">
                    <span className="block font-medium">
                      {t("faceReviewFace", { index: face.faceIndex + 1 })}
                    </span>
                    <span className="block max-w-32 truncate opacity-80">
                      {face.status === "assigned" &&
                        (face.identityName?.trim() ||
                          t("faceReviewAssignedStatus"))}
                      {face.status === "ignored" && t("faceReviewIgnored")}
                      {face.status === "pending" &&
                        t("faceReviewPendingStatus")}
                      {face.status === "skipped" &&
                        t("faceReviewSkippedStatus")}
                    </span>
                  </span>
                </button>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 px-1">
              <div className="min-w-0">
                <AppTooltip>
                  <AppTooltipTrigger asChild>
                    <p className="truncate text-[12px] text-foreground">
                      {candidateFilename(activeCandidate)}
                    </p>
                  </AppTooltipTrigger>
                  <AppTooltipContent>
                    {candidateFilename(activeCandidate)}
                  </AppTooltipContent>
                </AppTooltip>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {candidateReason(activeCandidate, t)}
                </p>
              </div>
              <div className="ml-auto flex shrink-0 items-center gap-2">
                <span className="text-[11px] text-muted-foreground tabular-nums">
                  {activeIndex + 1} / {visibleCandidates.length}
                </span>
                <AppTooltip>
                  <AppTooltipTrigger asChild>
                    <Button
                      aria-label={t("previous")}
                      disabled={activeIndex === 0}
                      onClick={() =>
                        setActiveId(
                          visibleCandidates[activeIndex - 1]?.id ?? null
                        )
                      }
                      size="icon"
                      variant="outline"
                    >
                      <ChevronLeft />
                    </Button>
                  </AppTooltipTrigger>
                  <AppTooltipContent>{t("previous")}</AppTooltipContent>
                </AppTooltip>
                <AppTooltip>
                  <AppTooltipTrigger asChild>
                    <Button
                      aria-label={t("next")}
                      disabled={activeIndex >= visibleCandidates.length - 1}
                      onClick={() =>
                        setActiveId(
                          visibleCandidates[activeIndex + 1]?.id ?? null
                        )
                      }
                      size="icon"
                      variant="outline"
                    >
                      <ChevronRight />
                    </Button>
                  </AppTooltipTrigger>
                  <AppTooltipContent>{t("next")}</AppTooltipContent>
                </AppTooltip>
              </div>
            </div>
          </section>

          <aside className="w-full min-w-0 shrink-0 overflow-y-auto rounded-[12px] border border-border bg-card p-3 sm:p-4 xl:w-[min(360px,32vw)]">
            <div className="grid grid-cols-[minmax(72px,92px)_minmax(0,1fr)] gap-3">
              <FaceCrop candidate={activeCandidate} />
              <div className="min-w-0 self-center">
                <p className="font-medium text-[13px] text-foreground">
                  {t("faceReviewWhoIsThis")}
                </p>
                <div className="mt-2 space-y-1 text-[11px] text-muted-foreground">
                  <p>
                    {t("faceReviewCurrentFace", {
                      current: activeCandidate.faceIndex + 1,
                      total: photoFaces.length,
                    })}
                  </p>
                  <p>
                    {t("faceDetectionConfidence")}:{" "}
                    {activeCandidate.detectionConfidence === null
                      ? "—"
                      : `${Math.round(activeCandidate.detectionConfidence * 100)}%`}
                  </p>
                  <p>
                    {t("faceIdentitySimilarity")}:{" "}
                    {activeCandidate.identitySimilarity === null
                      ? "—"
                      : `${Math.round(activeCandidate.identitySimilarity * 100)}%`}
                  </p>
                </div>
              </div>
            </div>

            {activeCandidate.reason === "ignored" ? (
              <div className="mt-5 border-border border-t pt-4">
                <p className="mb-3 text-[12px] text-muted-foreground leading-5">
                  {t("faceReviewIgnoredHint")}
                </p>
                <Button
                  className="w-full"
                  disabled={busy}
                  onClick={() =>
                    runAction(
                      () => faceActions.restoreRejected(activeCandidate.id),
                      t("faceReviewRestored")
                    )
                  }
                  size="lg"
                  variant="outline"
                >
                  <RotateCcw />
                  {t("faceReviewRestore")}
                </Button>
              </div>
            ) : (
              <div className="mt-5 space-y-5 border-border border-t pt-4">
                <section>
                  <label
                    className="mb-1.5 block font-medium text-[11px] text-muted-foreground"
                    htmlFor="identity-search"
                  >
                    {t("faceReviewAssignExisting")}
                  </label>
                  <input
                    className="mb-2 h-8 w-full rounded-[6px] border border-input bg-background px-2.5 text-[12px] outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
                    id="identity-search"
                    onChange={(event) => setIdentityQuery(event.target.value)}
                    placeholder={t("peopleSearch")}
                    value={identityQuery}
                  />
                  <div className="-mx-1 max-h-[200px] overflow-y-auto">
                    {identityOptions.length === 0 ? (
                      <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
                        {t("peopleSearchEmpty")}
                      </p>
                    ) : (
                      identityOptions.map((identity) => {
                        const isSelected =
                          selectedIdentity === String(identity.id);
                        return (
                          <button
                            className={`flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left text-[13px] text-foreground transition-colors disabled:opacity-50 ${isSelected ? "bg-primary/10" : "hover:bg-foreground/5"}`}
                            disabled={busy}
                            key={identity.id}
                            onClick={() =>
                              setSelectedIdentity(String(identity.id))
                            }
                            type="button"
                          >
                            <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-white/5 text-muted-foreground">
                              <User className="h-4 w-4" />
                            </div>
                            <span className="flex-1 truncate">
                              {identity.name?.trim() ||
                                `${t("unnamedPerson")} #${identity.id}`}
                            </span>
                            <span className="text-[11px] text-muted-foreground">
                              {identity.faceCount}
                            </span>
                            {isSelected && (
                              <Check className="h-4 w-4 text-primary" />
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                  <Button
                    className="mt-2 w-full"
                    disabled={
                      busy ||
                      !identityOptions.some(
                        (identity) => String(identity.id) === selectedIdentity
                      )
                    }
                    onClick={() =>
                      runAction(
                        () =>
                          faceActions.confirm(
                            activeCandidate.id,
                            Number(selectedIdentity)
                          ),
                        t("faceReviewAssigned")
                      )
                    }
                    size="lg"
                  >
                    <User />
                    {t("faceReviewConfirm")}
                  </Button>
                </section>

                <section className="border-border border-t pt-4">
                  <label
                    className="mb-1.5 block font-medium text-[11px] text-muted-foreground"
                    htmlFor="new-person-name"
                  >
                    {t("faceReviewCreateNew")}
                  </label>
                  <div className="grid grid-cols-1 gap-2 2xl:grid-cols-[minmax(0,1fr)_auto]">
                    <input
                      className="h-9 min-w-0 flex-1 rounded-[6px] border border-input bg-background px-2.5 text-[12px] outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/20"
                      id="new-person-name"
                      onChange={(event) => setNewName(event.target.value)}
                      placeholder={t("personNamePlaceholder")}
                      value={newName}
                    />
                    <Button
                      className="w-full"
                      disabled={busy || !newName.trim()}
                      onClick={() =>
                        runAction(
                          () =>
                            faceActions.createIdentity(newName.trim(), [
                              activeCandidate.id,
                            ]),
                          t("faceReviewCreated")
                        )
                      }
                      size="lg"
                      variant="outline"
                    >
                      <UserPlus />
                      {t("create")}
                    </Button>
                  </div>
                </section>

                <section className="border-border border-t pt-4">
                  <Button
                    className="w-full"
                    disabled={busy}
                    onClick={() =>
                      runAction(
                        () => faceActions.reject(activeCandidate.id),
                        t("faceReviewIgnoredSuccess")
                      )
                    }
                    size="lg"
                    variant="ghost"
                  >
                    <X />
                    {t("faceReviewNotAFace")}
                  </Button>
                </section>
              </div>
            )}
          </aside>
        </main>
      )}
    </div>
  );
}

export const Route = createFileRoute("/people/review" as const)({
  component: FaceReviewPage,
  errorComponent: RouteError,
});
