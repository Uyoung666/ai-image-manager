import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, BarChart3, Eye, Swords } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CullCurate } from "@/components/CullCurate";
import { CullDuel } from "@/components/CullDuel";
import { CullResult } from "@/components/CullResult";
import { ipc } from "@/ipc/manager";

export type CullDelta =
  | { type: "keep"; sessionPhotoId: number }
  | { type: "reject"; sessionPhotoId: number }
  | { type: "comparison" }
  | { type: "undo" }
  | { type: "finish" }
  | { type: "full" };

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

interface Session {
  completedAt: number | null;
  completedComparisons: number;
  createdAt: number;
  id: number;
  items: SessionPhoto[];
  mode: "duel" | "curate";
  name: string;
  pkMode?: string;
  status: "active" | "completed";
  totalPhotos: number;
}

function CullSessionPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { sessionId } = Route.useParams();
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [showResults, setShowResults] = useState(false);

  const loadSession = useCallback(async () => {
    setLoading(true);
    try {
      const result = (await ipc.client.cull.getSession({
        sessionId: Number(sessionId),
      })) as Session;
      setSession(result);
    } catch (err) {
      console.error("[loadSession] failed:", err);
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const refreshSession = useCallback(async () => {
    try {
      const result = (await ipc.client.cull.getSession({
        sessionId: Number(sessionId),
      })) as Session;
      setSession(result);
    } catch (err) {
      console.error("[refreshSession] failed:", err);
    }
  }, [sessionId]);

  const handleDelta = useCallback(
    (delta: CullDelta) => {
      switch (delta.type) {
        case "keep":
          setSession((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              completedComparisons: prev.completedComparisons + 1,
              items: prev.items.map((item) =>
                item.id === delta.sessionPhotoId
                  ? { ...item, status: "kept" as const }
                  : item
              ),
            };
          });
          break;
        case "reject":
          setSession((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              completedComparisons: prev.completedComparisons + 1,
              items: prev.items.map((item) =>
                item.id === delta.sessionPhotoId
                  ? { ...item, status: "rejected" as const }
                  : item
              ),
            };
          });
          break;
        case "comparison":
          setSession((prev) => {
            if (!prev) return prev;
            return {
              ...prev,
              completedComparisons: prev.completedComparisons + 1,
            };
          });
          break;
        case "undo":
        case "finish":
        case "full":
          refreshSession();
          break;
      }
    },
    [refreshSession]
  );

  useEffect(() => {
    loadSession();
  }, [loadSession]);

  if (loading && !session) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!session) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted-foreground">{t("cullSessionNotFound")}</p>
      </div>
    );
  }

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
          <h1 className="font-[590] text-[16px] text-foreground">
            {session.name}
          </h1>
          {!showResults && (
            <span className="text-[12px] text-muted-foreground/70">
              {isDuel
                ? `${session.completedComparisons} / ~${(() => {
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
          <span className="rounded-[4px] bg-success/10 px-1.5 py-0.5 font-[510] text-[10px] text-success">
            {t("cullKeptCount", { count: keepCount })}
          </span>
          <span className="rounded-[4px] bg-destructive/10 px-1.5 py-0.5 font-[510] text-[10px] text-destructive">
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
                : "bg-primary/10 font-[510] text-primary"
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
                : "bg-primary/10 font-[510] text-primary"
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
              ? "bg-primary/10 font-[510] text-primary"
              : "text-muted-foreground hover:text-foreground"
          }`}
          onClick={() => { setShowResults(true); refreshSession(); }}
        >
          <BarChart3 className="h-3.5 w-3.5" />
          {t("cullResult")}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden">
        {showResults ? (
          <CullResult onUpdate={refreshSession} session={session} />
        ) : isDuel ? (
          <CullDuel onUpdate={handleDelta} session={session} />
        ) : (
          <CullCurate onUpdate={handleDelta} session={session} />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/cull/$sessionId")({
  component: CullSessionPage,
});
