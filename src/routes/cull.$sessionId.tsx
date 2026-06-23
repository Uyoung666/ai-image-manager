import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, BarChart3, Eye, Swords } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { CullCurate } from "@/components/CullCurate";
import { CullDuel } from "@/components/CullDuel";
import { CullResult } from "@/components/CullResult";
import { ipc } from "@/ipc/manager";
import { RouteError } from "@/components/RouteError";

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

function CullSessionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessionId } = Route.useParams();
  const queryClient = useQueryClient();
  const [showResults, setShowResults] = useState(false);

  // Session data via TanStack Query — single source of truth
  const sessionQuery = useQuery({
    queryKey: ["cull", "session", sessionId],
    queryFn: async () => {
      const result = await ipc.client.cull.getSession({
        sessionId: Number(sessionId),
      });
      return result as Session;
    },
    staleTime: 10_000,
  });

  const session = sessionQuery.data ?? null;
  const isLoading = sessionQuery.isLoading && !sessionQuery.data;

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

      // Read latest session from TanStack Query cache (no ref needed)
      const current = queryClient.getQueryData<Session>([
        "cull",
        "session",
        sessionId,
      ]);
      if (!current?.items) {
        return;
      }

      const affected = current.items.some((item) => item.photo.id === photoId);
      if (!affected) {
        return;
      }

      // Invalidate session query — header stats refresh
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
      queryKey: ["cull", "session", sessionId],
    });
  }, [sessionId, queryClient]);

  // Loading state
  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
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
  const keepCount = session.items.filter((i) => i.status === "kept").length;
  const rejectCount = session.items.filter(
    (i) => i.status === "rejected"
  ).length;
  const pending = session.items.filter((i) => i.status === "pending");

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-3">
        <div className="flex items-center gap-4">
          <button
            className="text-muted-foreground hover:text-foreground"
            onClick={() => navigate({ to: "/cull" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <h1 className="font-semibold text-[16px] text-foreground">
            {session.name}
          </h1>
          {!showResults && (
            <span className="text-[12px] text-muted-foreground/70">
              {isDuel
                ? session.status === "completed"
                  ? `${session.completedComparisons} PKs · ✓`
                  : pending.length === 0
                    ? `${session.completedComparisons} PKs`
                    : `${session.completedComparisons} / ~${(() => {
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
                        const rb = Math.ceil(pending.length * f);
                        return Math.max(
                          1,
                          Math.ceil((pending.length * m) / 2) + rb
                        );
                      })()} PKs`
                : `${keepCount + rejectCount}/${session.totalPhotos} reviewed`}
            </span>
          )}
          <span className="rounded-[4px] bg-success/10 px-1.5 py-0.5 font-medium text-[10px] text-success">
            {t("cullKeptCount", { count: keepCount })}
          </span>
          <span className="rounded-[4px] bg-destructive/10 px-1.5 py-0.5 font-medium text-[10px] text-destructive">
            {t("cullRejectedCount", { count: rejectCount })}
          </span>
        </div>
      </div>

      {/* Toggle bar */}
      <div className="flex items-center gap-1 border-border border-b px-6 py-2">
        {isDuel ? (
          <button
            className={`flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
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
            className={`flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
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
          className={`flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-[12px] transition-colors ${
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
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {showResults ? (
          <CullResult
            onUpdate={() =>
              queryClient.invalidateQueries({
                queryKey: ["cull", "session", sessionId],
              })
            }
            session={session}
          />
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
