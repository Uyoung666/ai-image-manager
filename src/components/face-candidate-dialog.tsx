import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toLocalMediaUrl } from "@/utils/local-media-url";

export type FaceReviewReason =
  | "ignored"
  | "low_confidence"
  | "removed_from_identity"
  | "unmatched";

export interface FaceCandidate {
  bboxHeight: number;
  bboxWidth: number;
  bboxX: number;
  bboxY: number;
  bestIdentityId: number | null;
  bestIdentityName: string | null;
  detectionConfidence: number | null;
  faceIndex: number;
  id: number;
  identitySimilarity: number | null;
  photoHeight: number | null;
  photoId: number;
  photoPath: string;
  photoWidth: number | null;
  reason?: FaceReviewReason;
  sourceIdentityId?: number | null;
  sourceIdentityName?: string | null;
  status?: "ignored" | "pending";
  thumbnailPath: string | null;
}

export interface FaceCandidateIdentity {
  id: number;
  name: string | null;
}

type ReviewTab =
  | "all"
  | "ignored"
  | "low_confidence"
  | "removed_from_identity"
  | "unmatched";

interface FaceCandidateDialogProps {
  candidates: FaceCandidate[];
  error?: boolean;
  identities: FaceCandidateIdentity[];
  ignoredCandidates?: FaceCandidate[];
  loading?: boolean;
  onConfirm: (candidate: FaceCandidate, identityId: number) => Promise<void>;
  onCreate: (candidate: FaceCandidate, name: string) => Promise<void>;
  onIgnore?: (candidate: FaceCandidate) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  onRestore?: (candidate: FaceCandidate) => Promise<void>;
  onRetry?: () => void;
  open: boolean;
}

const STAGE_ASPECT = 4 / 3;

export function getContainFrame(width: number, height: number) {
  const imageAspect = width / Math.max(height, 1);
  if (imageAspect > STAGE_ASPECT) {
    const frameHeight = (STAGE_ASPECT / imageAspect) * 100;
    return {
      height: `${frameHeight}%`,
      left: "0%",
      top: `${(100 - frameHeight) / 2}%`,
      width: "100%",
    };
  }
  const frameWidth = (imageAspect / STAGE_ASPECT) * 100;
  return {
    height: "100%",
    left: `${(100 - frameWidth) / 2}%`,
    top: "0%",
    width: `${frameWidth}%`,
  };
}

function reasonLabel(
  candidate: FaceCandidate,
  t: (key: string, options?: Record<string, unknown>) => string
) {
  if (candidate.reason === "ignored") {
    return t("faceReviewIgnoredHint");
  }
  if (candidate.reason === "low_confidence") {
    return t("faceReviewLowConfidenceHint");
  }
  if (candidate.reason === "removed_from_identity") {
    return t("faceReviewRemovedHint", {
      name: candidate.sourceIdentityName || t("unnamedPerson"),
    });
  }
  if (candidate.bestIdentityName) {
    return t("faceReviewPossible", { name: candidate.bestIdentityName });
  }
  return t("faceReviewUnmatchedHint");
}

export function FaceCandidateDialog({
  candidates,
  error = false,
  identities,
  ignoredCandidates = [],
  loading = false,
  onConfirm,
  onCreate,
  onIgnore,
  onRestore,
  onOpenChange,
  open,
  onRetry,
}: FaceCandidateDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<ReviewTab>("all");
  const [selectedIdentity, setSelectedIdentity] = useState<
    Record<number, string>
  >({});
  const [selectedFace, setSelectedFace] = useState<Record<number, number>>({});
  const [newNames, setNewNames] = useState<Record<number, string>>({});
  const [busyId, setBusyId] = useState<number | null>(null);

  const allCandidates = useMemo(
    () => [...candidates, ...ignoredCandidates],
    [candidates, ignoredCandidates]
  );
  const groupedCandidates = useMemo(() => {
    const groups = new Map<number, FaceCandidate[]>();
    for (const candidate of allCandidates) {
      if (
        (tab === "all" && candidate.status === "ignored") ||
        (tab !== "all" && candidate.reason !== tab)
      ) {
        continue;
      }
      const group = groups.get(candidate.photoId) ?? [];
      group.push(candidate);
      groups.set(candidate.photoId, group);
    }
    return [...groups.values()];
  }, [allCandidates, tab]);

  useEffect(() => {
    if (!open) {
      return;
    }
    setSelectedIdentity((current) => {
      const next = { ...current };
      for (const candidate of allCandidates) {
        if (!(candidate.id in next)) {
          next[candidate.id] = candidate.bestIdentityId
            ? String(candidate.bestIdentityId)
            : "";
        }
      }
      return next;
    });
  }, [allCandidates, open]);

  async function run(candidate: FaceCandidate, action: () => Promise<void>) {
    setBusyId(candidate.id);
    try {
      await action();
    } finally {
      setBusyId(null);
    }
  }

  const tabs: { key: ReviewTab; label: string; count: number }[] = [
    { key: "all", label: t("faceReviewAll"), count: candidates.length },
    {
      key: "unmatched",
      label: t("faceReviewUnmatched"),
      count: candidates.filter((item) => item.reason === "unmatched").length,
    },
    {
      key: "low_confidence",
      label: t("faceReviewLowConfidence"),
      count: candidates.filter((item) => item.reason === "low_confidence")
        .length,
    },
    {
      key: "removed_from_identity",
      label: t("faceReviewRemoved"),
      count: candidates.filter(
        (item) => item.reason === "removed_from_identity"
      ).length,
    },
    {
      key: "ignored",
      label: t("faceReviewIgnored"),
      count: ignoredCandidates.length,
    },
  ];

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[85vh] flex-col overflow-hidden"
        size="xl"
      >
        <DialogHeader>
          <DialogTitle>{t("faceReviewTitle")}</DialogTitle>
          <DialogDescription>{t("faceReviewDescription")}</DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 gap-1 overflow-x-auto border-border border-b pb-2">
          {tabs.map((item) => (
            <button
              className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-[12px] ${tab === item.key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"}`}
              key={item.key}
              onClick={() => setTab(item.key)}
              type="button"
            >
              {item.label} <span className="opacity-70">{item.count}</span>
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          {loading && (
            <div className="py-12 text-center text-[13px] text-muted-foreground">
              {t("faceReviewLoading")}
            </div>
          )}
          {!loading && error && (
            <div className="flex flex-col items-center gap-3 py-12 text-center text-[13px] text-muted-foreground">
              <span>{t("faceReviewLoadFailed")}</span>
              <button
                className="rounded-md border border-border px-3 py-1.5 text-[12px] hover:bg-muted"
                onClick={onRetry}
                type="button"
              >
                {t("faceReviewRetry")}
              </button>
            </div>
          )}
          {!(loading || error) && groupedCandidates.length === 0 && (
            <div className="py-12 text-center text-[13px] text-muted-foreground">
              {t("faceReviewEmpty")}
            </div>
          )}
          {!(loading || error) && groupedCandidates.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {groupedCandidates.map((photoCandidates) => {
                const activeId =
                  selectedFace[photoCandidates[0].photoId] ??
                  photoCandidates[0].id;
                const candidate =
                  photoCandidates.find((item) => item.id === activeId) ??
                  photoCandidates[0];
                const busy = busyId === candidate.id;
                const width = candidate.photoWidth || 1;
                const height = candidate.photoHeight || 1;
                const frame = getContainFrame(width, height);
                const image = candidate.thumbnailPath || candidate.photoPath;
                const ignored =
                  candidate.status === "ignored" ||
                  candidate.reason === "ignored";
                return (
                  <article
                    className="overflow-hidden rounded-lg border border-border bg-card"
                    key={candidate.photoId}
                  >
                    <div className="relative aspect-[4/3] overflow-hidden bg-muted">
                      <div className="absolute" style={frame}>
                        <img
                          alt={t("faceReviewTitle")}
                          className="h-full w-full object-contain"
                          height={height}
                          src={toLocalMediaUrl(image)}
                          width={width}
                        />
                        {photoCandidates.map((face) => (
                          <div
                            aria-label={t("faceReviewFace", {
                              index: face.faceIndex + 1,
                            })}
                            className={`pointer-events-none absolute rounded border-2 ${face.id === candidate.id ? "border-primary" : "border-primary/50"}`}
                            key={face.id}
                            role="img"
                            style={{
                              height: `${(face.bboxHeight / height) * 100}%`,
                              left: `${(face.bboxX / width) * 100}%`,
                              top: `${(face.bboxY / height) * 100}%`,
                              width: `${(face.bboxWidth / width) * 100}%`,
                            }}
                          />
                        ))}
                      </div>
                    </div>
                    <div className="space-y-2 p-3">
                      {photoCandidates.length > 1 && (
                        <div className="flex flex-wrap gap-1">
                          {photoCandidates.map((face, index) => (
                            <button
                              className={`rounded border px-2 py-1 text-[11px] ${face.id === candidate.id ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground"}`}
                              key={face.id}
                              onClick={() =>
                                setSelectedFace((current) => ({
                                  ...current,
                                  [candidate.photoId]: face.id,
                                }))
                              }
                              type="button"
                            >
                              {t("faceReviewFace", { index: index + 1 })}
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="truncate text-[12px] text-muted-foreground">
                        {reasonLabel(candidate, t)}
                      </p>
                      {candidate.detectionConfidence !== null && (
                        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-muted-foreground/80">
                          <span>
                            {t("faceDetectionConfidence")}:{" "}
                            {Math.round(candidate.detectionConfidence * 100)}%
                          </span>
                          <span>
                            {t("faceIdentitySimilarity")}:{" "}
                            {candidate.identitySimilarity === null
                              ? "—"
                              : `${Math.round(candidate.identitySimilarity * 100)}%`}
                          </span>
                        </div>
                      )}
                      {ignored ? (
                        <button
                          className="w-full rounded-md border border-border px-2.5 py-1.5 text-[12px] hover:bg-muted disabled:opacity-40"
                          disabled={busy}
                          onClick={() =>
                            onRestore &&
                            run(candidate, () => onRestore(candidate))
                          }
                          type="button"
                        >
                          {t("faceReviewRestore")}
                        </button>
                      ) : (
                        <>
                          <div className="flex gap-2">
                            <select
                              aria-label={t("faceReviewSelectPerson")}
                              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
                              disabled={busy}
                              onChange={(event) =>
                                setSelectedIdentity((current) => ({
                                  ...current,
                                  [candidate.id]: event.target.value,
                                }))
                              }
                              value={selectedIdentity[candidate.id] ?? ""}
                            >
                              <option value="">
                                {t("faceReviewSelectPerson")}
                              </option>
                              {identities.map((identity) => (
                                <option key={identity.id} value={identity.id}>
                                  {identity.name?.trim() ||
                                    `${t("unnamedPerson")} #${identity.id}`}
                                </option>
                              ))}
                            </select>
                            <button
                              className="rounded-md bg-primary px-2.5 py-1.5 text-[12px] text-primary-foreground disabled:opacity-40"
                              disabled={busy || !selectedIdentity[candidate.id]}
                              onClick={() =>
                                run(candidate, () =>
                                  onConfirm(
                                    candidate,
                                    Number(selectedIdentity[candidate.id])
                                  )
                                )
                              }
                              type="button"
                            >
                              {t("faceReviewConfirm")}
                            </button>
                          </div>
                          <div className="flex gap-2">
                            <input
                              aria-label={t("faceReviewCreatePerson")}
                              className="min-w-0 flex-1 rounded-md border border-input bg-background px-2 py-1.5 text-[12px]"
                              disabled={busy}
                              onChange={(event) =>
                                setNewNames((current) => ({
                                  ...current,
                                  [candidate.id]: event.target.value,
                                }))
                              }
                              placeholder={t("faceReviewCreatePerson")}
                              value={newNames[candidate.id] ?? ""}
                            />
                            <button
                              className="rounded-md border border-border px-2.5 py-1.5 text-[12px] disabled:opacity-40"
                              disabled={busy || !newNames[candidate.id]?.trim()}
                              onClick={() =>
                                run(candidate, async () => {
                                  await onCreate(
                                    candidate,
                                    newNames[candidate.id].trim()
                                  );
                                  setNewNames((current) => ({
                                    ...current,
                                    [candidate.id]: "",
                                  }));
                                })
                              }
                              type="button"
                            >
                              {t("faceReviewCreatePerson")}
                            </button>
                          </div>
                          <button
                            className="w-full rounded-md border border-destructive/30 px-2.5 py-1.5 text-[12px] text-destructive hover:bg-destructive/5 disabled:opacity-40"
                            disabled={busy}
                            onClick={() =>
                              onIgnore &&
                              run(candidate, () => onIgnore(candidate))
                            }
                            type="button"
                          >
                            {t("faceReviewIgnore")}
                          </button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </div>
        <DialogFooter>
          <span className="mr-auto text-[11px] text-muted-foreground">
            {t("faceReviewDescription")}
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
