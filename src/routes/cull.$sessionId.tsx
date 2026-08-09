import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, BarChart3, Eye, RotateCcw, Swords } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { enterTemporaryDarkTheme } from "@/actions/theme";
import { CullCurate } from "@/components/CullCurate";
import { CullDuel } from "@/components/CullDuel";
import { CullResult } from "@/components/CullResult";
import { RouteError } from "@/components/RouteError";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ipc } from "@/ipc/manager";

// ── Shared types ──

/** Lightweight delta sent by child components after mutation success.
 *  The parent invalidates its session query in response — no manual
 *  state patching needed because TanStack Query refetches atomically. */
export type CullDelta = { type: "mutation" | "finish" };

interface SessionPhoto {
  comparisons: number;
  id: number;
  losses: number;
  photo: {
    id: number;
    filename: string;
    path: string;
    width: number;
    height: number;
    fileSize: number;
    format: string;
    thumbnailPath: string | null;
    fileDate: number | null;
    isFavorite: boolean | null;
    isIndexed: boolean;
  };
  rating: number;
  status: "pending" | "kept" | "rejected";
  wins: number;
}

export interface Session {
  completedAt: number | null;
  completedComparisons: number;
  createdAt: number;
  id: number;
  items: SessionPhoto[];
  mode: "duel" | "curate";
  name: string;
  pkMode?: string;
  sortStrategy?: string;
  status: "active" | "completed";
  totalPhotos: number;
}

export interface SessionSummary extends Omit<Session, "items"> {
  keptCount: number;
  pendingCount: number;
  rejectedCount: number;
}

function CullSessionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessionId } = Route.useParams();
  const queryClient = useQueryClient();
  const [showResults, setShowResults] = useState(false);

  // Lightweight summary stays on the hot path; full result rows load only
  // when the user opens the result view.
  const sessionQuery = useQuery({
    queryKey: ["cull", "summary", sessionId],
    queryFn: async () => {
      const result = await ipc.client.cull.getSessionSummary({
        sessionId: Number(sessionId),
      });
      return result as SessionSummary;
    },
    staleTime: 10_000,
  });

  const resultQuery = useQuery({
    queryKey: ["cull", "session", sessionId],
    queryFn: async () => {
      const result = await ipc.client.cull.getSession({
        sessionId: Number(sessionId),
      });
      return result as Session;
    },
    enabled: showResults,
    staleTime: 5_000,
  });

  const session = sessionQuery.data ?? null;
  const isLoading = sessionQuery.isLoading && !sessionQuery.data;

  useEffect(() => {
    if (session?.mode !== "duel") {
      return;
    }
    return enterTemporaryDarkTheme();
  }, [session?.mode]);

  useEffect(() => {
    if (session?.status === "completed") {
      setShowResults(true);
    }
  }, [session?.status]);

  // File-change listener: invalidates both session AND pair queries
  // so header stats refresh AND CullDuel/CullCurate immediately refetch.
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data?.channel !== "file-change") {
        return;
      }
      const { type, photoId } = event.data as {
        type: string;
        photoId?: number;
      };
      if (!photoId) {
        return;
      }

      queryClient.invalidateQueries({
        queryKey: ["cull", "summary", sessionId],
      });
      queryClient.invalidateQueries({
        queryKey: ["cull", "session", sessionId],
      });
      // Also invalidate the active pair query so CullDuel/CullCurate
      // immediately refetch instead of waiting on stale pair data.
      // Without this, the child component sits frozen with the old
      // pair because its query key hasn't changed.
      queryClient.invalidateQueries({
        queryKey: ["cull", "pair", Number(sessionId)],
      });

      if (type === "remove") {
        toast.warning(t("cullPhotoDeletedExternally"));
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, [sessionId, queryClient, t]);

  // Called by child components after every mutation
  const onMutationSuccess = useCallback(() => {
    queryClient.invalidateQueries({
      queryKey: ["cull", "summary", sessionId],
    });
  }, [sessionId, queryClient]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <LoadingSpinner size="xl" />
      </div>
    );
  }

  if (sessionQuery.isError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <p className="text-[13px] text-destructive">{t("cullActionFailed")}</p>
        <button
          className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground"
          onClick={() => sessionQuery.refetch()}
          type="button"
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  // Not-found
  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{t("cullSessionNotFound")}</p>
      </div>
    );
  }

  // ── Derived data ──
  const isDuel = session.mode !== "curate";
  const keepCount = session.keptCount;
  const rejectCount = session.rejectedCount;
  const pendingCount = session.pendingCount;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-background">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-border border-b px-3 py-2 sm:px-6 sm:py-3">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 sm:gap-x-4">
          <button
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ to: "/cull" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="min-w-0 max-w-full truncate font-semibold text-[16px] text-foreground">
            {session.name}
          </h1>
          {!showResults && (
            <span className="min-w-0 truncate text-[12px] text-muted-foreground/70">
              {isDuel
                ? session.status === "completed"
                  ? `${t("cullPkCount", { count: session.completedComparisons })} · ✓`
                  : pendingCount === 0
                    ? t("cullPkCount", { count: session.completedComparisons })
                    : t("cullPkProgress", {
                        done: session.completedComparisons,
                        total: (() => {
                          const m =
                            session.pkMode === "quick"
                              ? 5
                              : session.pkMode === "fine"
                                ? 12
                                : 8;
                          const f =
                            session.pkMode === "quick"
                              ? 0
                              : session.pkMode === "fine"
                                ? 0.3
                                : 0.15;
                          const rb = Math.ceil(pendingCount * f);
                          return Math.max(
                            1,
                            Math.ceil((pendingCount * m) / 2) + rb
                          );
                        })(),
                      })
                : t("cullReviewedProgress", {
                    done: keepCount + rejectCount,
                    total: session.totalPhotos,
                  })}
            </span>
          )}
          <span className="shrink-0 rounded-[4px] bg-success/10 px-1.5 py-0.5 font-medium text-[10px] text-success">
            {t("cullKeptCount", { count: keepCount })}
          </span>
          <span className="shrink-0 rounded-[4px] bg-destructive/10 px-1.5 py-0.5 font-medium text-[10px] text-destructive">
            {t("cullRejectedCount", { count: rejectCount })}
          </span>
        </div>
      </div>

      {/* Toggle bar */}
      <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-border border-b px-3 py-1.5 sm:px-6 sm:py-2">
        {isDuel ? (
          <button
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
              showResults
                ? "text-muted-foreground hover:text-foreground"
                : "bg-primary/10 font-medium text-primary"
            }`}
            onClick={() => setShowResults(false)}
          >
            <Swords className="h-3.5 w-3.5" />
            {t("cullModeDuel")}
          </button>
        ) : (
          <button
            className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
              showResults
                ? "text-muted-foreground hover:text-foreground"
                : "bg-primary/10 font-medium text-primary"
            }`}
            onClick={() => setShowResults(false)}
          >
            <Eye className="h-3.5 w-3.5" />
            {t("cullModeCurate")}
          </button>
        )}
        <button
          className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
            showResults
              ? "bg-primary/10 font-medium text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => {
            setShowResults(true);
            // Invalidate to ensure Result view has fresh data
            queryClient.invalidateQueries({
              queryKey: ["cull", "session", sessionId],
            });
          }}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          {t("cullResult")}
        </button>
        {session.status === "completed" && (
          <button
            className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[6px] px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            onClick={async () => {
              try {
                await ipc.client.cull.resumeSession({ sessionId: session.id });
                await queryClient.invalidateQueries({
                  queryKey: ["cull", "summary", sessionId],
                });
                setShowResults(false);
                toast.success(t("cullSessionResumed"));
              } catch (error) {
                console.error("[resumeSession] failed:", error);
                toast.error(t("cullActionFailed"));
              }
            }}
            type="button"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("cullResumeSession")}
          </button>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {showResults ? (
          resultQuery.data ? (
            <CullResult
              onUpdate={() => {
                queryClient.invalidateQueries({
                  queryKey: ["cull", "summary", sessionId],
                });
                queryClient.invalidateQueries({
                  queryKey: ["cull", "session", sessionId],
                });
              }}
              session={resultQuery.data}
            />
          ) : resultQuery.isError ? (
            <div className="flex h-full flex-col items-center justify-center gap-3">
              <p className="text-[13px] text-destructive">
                {t("cullActionFailed")}
              </p>
              <button
                className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground"
                onClick={() => resultQuery.refetch()}
                type="button"
              >
                {t("retry")}
              </button>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner size="xl" />
            </div>
          )
        ) : isDuel ? (
          <CullDuel onMutationSuccess={onMutationSuccess} session={session} />
        ) : (
          <CullCurate onMutationSuccess={onMutationSuccess} session={session} />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/cull/$sessionId")({
  component: CullSessionPage,
  errorComponent: RouteError,
});
