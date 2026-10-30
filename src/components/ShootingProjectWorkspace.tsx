import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Eye,
  FolderSync,
  Info,
  ListChecks,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { cullActions } from "@/actions/cull";
import { shootingProjectActions } from "@/actions/shooting-projects";
import { enterTemporaryDarkTheme } from "@/actions/theme";
import { CullArchiveButton } from "@/components/CullArchiveButton";
import { CullCurate } from "@/components/CullCurate";
import { CullDuel } from "@/components/CullDuel";
import { CullResult } from "@/components/CullResult";
import { FilterDropdown } from "@/components/filter-dropdown";
import { Copy } from "@/components/icons/copy";
import { IconMotionTrigger } from "@/components/icons/icon-motion";
import { RefreshCw } from "@/components/icons/refresh-cw";
import { Swords } from "@/components/icons/swords";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCullSaveStatus } from "@/hooks/use-cull-save-status";
import { useCullArchiveRefresh } from "@/hooks/use-cull-task-archive";
import { useShootingProjectOutputs } from "@/hooks/use-shooting-project-outputs";
import { useShootingProjectWorkspace } from "@/hooks/use-shooting-project-workspace";
import type { Session, SessionSummary } from "@/routes/cull.$sessionId";
import type { ProjectCullScope } from "@/types/cull";
import type { ShootingProjectWorkspaceData } from "@/types/shooting-project";
import { cullReturnOptions } from "@/utils/cull-navigation";
import { ShootingProjectManagement } from "./ShootingProjectManagement";
import {
  ShootingProjectOutputDialog,
  ShootingProjectOutputs,
} from "./ShootingProjectOutputs";
import { ShootingProjectRelinkDialog } from "./ShootingProjectRelinkDialog";
import {
  ShootingProjectSourceStatusLabel,
  shootingProjectBytes,
} from "./ShootingProjectStatus";

export function ShootingProjectProgress({
  data,
  projectId,
  saving,
  run,
  onRelink,
}: {
  data: ShootingProjectWorkspaceData;
  projectId: string;
  saving: boolean;
  run: (action: () => Promise<ShootingProjectWorkspaceData>) => unknown;
  onRelink: () => void;
}) {
  const { t } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  const scanning =
    data.scan.status === "running" || data.scan.status === "pending";
  const previewFailures = data.photos.filter(
    (photo) => photo.previewStatus === "failed"
  ).length;
  const previewsReady =
    !scanning &&
    data.photos.length > 0 &&
    data.project.previewReadyCount === data.photos.length &&
    data.photos.every((photo) => photo.previewStatus === "ready");
  let previewActionKey = previewFailures
    ? "shootingProject.retryPreviews"
    : "shootingProject.preparePreviews";
  if (previewsReady) {
    previewActionKey = "shootingProject.previewsReady";
  }
  return (
    <div className="min-w-0 space-y-2 rounded-lg border border-border bg-card p-3 text-xs">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <p className="break-words" data-testid="shooting-scan-status">
          {scanning
            ? t("shootingProject.scanDiscovering", {
                count: data.scan.discovered,
              })
            : t(`shootingProject.scan_${data.scan.status}`, {
                count: data.photos.length,
              })}
        </p>
        <p
          className="text-muted-foreground"
          data-testid="shooting-preview-progress"
        >
          {t("shootingProject.previewProgress", {
            done: data.project.previewReadyCount,
            total: data.photos.length,
          })}
        </p>
      </div>
      <p className="break-words text-muted-foreground">
        {scanning
          ? t("shootingProject.scanTotalPending")
          : t("shootingProject.selectionProgress", {
              reviewed: data.counts.reviewed,
              decided: data.counts.decided,
              total: data.photos.length,
            })}
        {data.counts.allDecided && !scanning
          ? ` · ${t("shootingProject.allDecided")}`
          : ""}
      </p>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          data-testid="shooting-check-new"
          disabled={
            scanning || saving || data.project.sourceStatus !== "online"
          }
          onClick={() =>
            run(() =>
              shootingProjectActions.prepare({
                projectId,
                checkNew: true,
              })
            )
          }
          type="button"
          variant="outline"
        >
          {t(
            data.scan.status === "failed" || data.scan.status === "interrupted"
              ? "shootingProject.retryScan"
              : "shootingProject.checkNew"
          )}
        </Button>
        <Button
          data-testid="shooting-prepare-previews"
          disabled={
            scanning ||
            saving ||
            previewsReady ||
            data.photos.length === 0 ||
            data.project.sourceStatus !== "online"
          }
          onClick={() =>
            run(() =>
              shootingProjectActions.prepare({
                projectId,
                retryPreviews: true,
              })
            )
          }
          type="button"
          variant="outline"
        >
          {previewsReady && <Check aria-hidden="true" />}
          {t(previewActionKey)}
        </Button>
        <Button
          aria-expanded={showSource}
          onClick={() => setShowSource((value) => !value)}
          type="button"
          variant="ghost"
        >
          {t("shootingProject.sourceDetails")}
        </Button>
        <Button
          data-testid="shooting-relink"
          onClick={onRelink}
          type="button"
          variant="outline"
        >
          <FolderSync />
          {t("shootingProject.relink")}
        </Button>
      </div>
      <p
        className="break-words text-muted-foreground leading-relaxed"
        data-testid="shooting-preview-help"
      >
        {t("shootingProject.previewsHelp")}
      </p>
      {previewFailures > 0 && (
        <p className="text-muted-foreground">
          {t("shootingProject.previewFailures", {
            count: previewFailures,
          })}
        </p>
      )}
      {data.scan.errors.length > 0 && (
        <details className="min-w-0">
          <summary className="cursor-pointer text-destructive">
            {t("shootingProject.scanErrors", {
              count: data.scan.errors.length,
            })}
          </summary>
          <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto">
            {data.scan.errors.map((error) => (
              <li
                className="break-all"
                key={`${error.relativePath}:${error.code}`}
              >
                {error.relativePath} — {t("shootingProject.scanReadFailed")}
              </li>
            ))}
          </ul>
        </details>
      )}
      {showSource && (
        <div className="space-y-2 border-border border-t pt-2">
          <p className="break-all">{data.project.sourceRoot}</p>
          <p className="text-muted-foreground">
            {t("shootingProject.previewUsage", {
              size: shootingProjectBytes(data.previewBytes),
            })}
          </p>
          {data.project.sourceInLibrary && (
            <p className="text-muted-foreground leading-relaxed">
              {t("shootingProject.libraryWarning")}
            </p>
          )}
        </div>
      )}
      {data.project.sourceStatus !== "online" && (
        <p className="text-muted-foreground leading-relaxed">
          {t("shootingProject.offlineDescription")}
        </p>
      )}
    </div>
  );
}

type ProjectView = "curate" | "duel" | "result";

function readProjectView(
  projectId: string,
  workflow: "curate" | "duel" | "hybrid",
  hasDuel: boolean
): ProjectView {
  const fallback = workflow === "duel" && hasDuel ? "duel" : "curate";
  try {
    const value = localStorage.getItem(`cull.project.view.${projectId}`);
    return value === "duel" || value === "result" || value === "curate"
      ? value
      : fallback;
  } catch {
    return fallback;
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The shared project shell coordinates the existing culling modes and their dialogs.
export function ShootingProjectWorkspace({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const workspace = useShootingProjectWorkspace(projectId, false);
  useCullArchiveRefresh("project", projectId, workspace.refresh);
  const { data, errorKey, loading } = workspace;
  const [view, setView] = useState<ProjectView | null>(null);
  const [curateId, setCurateId] = useState<number | null>(null);
  const [duelId, setDuelId] = useState<number | null>(null);
  const [rounds, setRounds] = useState<
    Array<{ id: number; name: string; mode: string; status?: string }>
  >([]);
  const [resultRoundId, setResultRoundId] = useState<number | null>(null);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [outputsOpen, setOutputsOpen] = useState(false);
  const outputs = useShootingProjectOutputs(projectId);
  const [relinkOpen, setRelinkOpen] = useState(false);
  const [copyIds, setCopyIds] = useState<string[] | undefined | null>(null);
  const [pkScope, setPkScope] = useState<ProjectCullScope | null>(null);
  const [pkMode, setPkMode] = useState<"quick" | "standard" | "fine">(
    "standard"
  );
  const selectionSaveStatus = useCullSaveStatus([
    projectId,
    curateId,
    duelId,
    resultRoundId,
  ]);
  const [starting, setStarting] = useState(false);
  const [sessionError, setSessionError] = useState(false);
  const [retry, setRetry] = useState(0);

  const workflow = data?.project.workflow ?? "curate";
  useEffect(() => {
    setPkMode(data?.project.pkMode ?? "standard");
  }, [data?.project.pkMode]);
  const projectReady = Boolean(data);
  const initialDuelPossible =
    (data?.photos.length ?? 0) >= 2 ||
    data?.scan.status === "running" ||
    data?.scan.status === "pending";
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry reruns failed session initialization.
  useEffect(() => {
    if (!projectReady) {
      return;
    }
    let active = true;
    setSessionError(false);
    async function initialize() {
      const [curate, sessions] = await Promise.all([
        cullActions.startProjectSession({
          projectId,
          mode: "curate",
          reuseExisting: true,
        }),
        cullActions.listProjectSessions({ projectId }),
      ]);
      const duels = sessions.filter((session) => session.mode === "duel");
      if (workflow === "duel" && duels.length === 0 && initialDuelPossible) {
        const first = await cullActions.startProjectSession({
          projectId,
          mode: "duel",
          reuseExisting: true,
        });
        duels.push(first);
      }
      if (!active) {
        return;
      }
      setCurateId(curate.id);
      setRounds(duels);
      let saved: number | null = null;
      try {
        saved = Number(localStorage.getItem(`cull.project.round.${projectId}`));
      } catch {
        /* optional preference */
      }
      setDuelId(
        duels.find((round) => round.id === saved)?.id ?? duels[0]?.id ?? null
      );
      try {
        const savedScope = Number(
          localStorage.getItem(`cull.project.resultRound.${projectId}`)
        );
        setResultRoundId(
          duels.some((round) => round.id === savedScope) ? savedScope : null
        );
      } catch {
        setResultRoundId(null);
      }
      setView(readProjectView(projectId, workflow, duels.length > 0));
    }
    initialize().catch(() => {
      if (active) {
        setSessionError(true);
      }
    });
    return () => {
      active = false;
    };
  }, [projectId, retry, projectReady, workflow, initialDuelPossible]);

  useEffect(() => {
    if (!view) {
      return;
    }
    try {
      localStorage.setItem(`cull.project.view.${projectId}`, view);
    } catch {
      /* optional preference */
    }
  }, [view, projectId]);
  useEffect(() => {
    if (view !== "result") {
      return;
    }
    try {
      localStorage.setItem(
        `cull.project.resultRound.${projectId}`,
        resultRoundId === null ? "all" : String(resultRoundId)
      );
    } catch {
      /* optional preference */
    }
  }, [view, resultRoundId, projectId]);
  useEffect(() => {
    if (duelId === null) {
      return;
    }
    try {
      localStorage.setItem(`cull.project.round.${projectId}`, String(duelId));
    } catch {
      /* optional preference */
    }
  }, [duelId, projectId]);
  useEffect(() => enterTemporaryDarkTheme(), []);

  const activeId = view === "duel" ? duelId : curateId;
  const summaryQuery = useQuery({
    queryKey: ["cull", "summary", activeId],
    queryFn: async () =>
      (await cullActions.getSessionSummary({
        sessionId: activeId ?? 0,
      })) as SessionSummary,
    enabled: activeId !== null,
    refetchInterval: 1500,
  });
  const resultSessionId = resultRoundId ?? curateId;
  const resultQuery = useQuery({
    queryKey: ["cull", "session", resultSessionId, "project-results", duelId],
    queryFn: async () =>
      (resultRoundId === null
        ? await cullActions.getProjectResults({
            projectId,
            rankingSessionId: duelId ?? undefined,
          })
        : await cullActions.getSession({
            sessionId: resultRoundId,
          })) as Session,
    enabled: resultSessionId !== null && view === "result",
    refetchInterval:
      data?.scan.status === "running" || data?.scan.status === "pending"
        ? 1500
        : false,
  });
  const session = summaryQuery.data;
  const resultHintKey =
    resultRoundId === null
      ? "cullProject.finalRankingHint"
      : "cullProject.rankingHint";
  const duelCompleted =
    session?.status === "completed" ||
    rounds.find((round) => round.id === duelId)?.status === "completed";
  function openResults(roundId: number | null = null) {
    setResultRoundId(roundId);
    setView("result");
  }
  function openNewRound() {
    setPkScope(
      workflow === "hybrid"
        ? {
            kind: "selected",
            photoIds:
              data?.photos
                .filter((photo) => photo.status === "kept")
                .map((photo) => photo.id) ?? [],
          }
        : { kind: "all" }
    );
  }
  const onMutation = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["cull", "summary"] });
    queryClient.invalidateQueries({ queryKey: ["cull", "session"] });
    workspace.refresh();
  }, [queryClient, workspace.refresh]);

  async function beginPk(scope: ProjectCullScope) {
    if (starting) {
      return;
    }
    setStarting(true);
    try {
      const round = await cullActions.startProjectSession({
        projectId,
        mode: "duel",
        scope,
        pkMode,
      });
      setDuelId(round.id);
      setRounds((previous) => [round, ...previous]);
      setPkScope(null);
      setView("duel");
    } catch {
      toast.error(t("cullActionFailed"));
    } finally {
      setStarting(false);
    }
  }

  async function startPk() {
    if (pkScope) {
      await beginPk(pkScope);
    }
  }

  async function finishReview() {
    if (workflow !== "hybrid") {
      openResults();
      return;
    }
    try {
      const current = await shootingProjectActions.workspace(projectId);
      workspace.accept(current);
      const kept = current.photos
        .filter((photo) => photo.status === "kept")
        .map((photo) => photo.id);
      if (kept.length < 2) {
        openResults();
        toast.info(t("cullProject.needTwoKept"));
        return;
      }
      await beginPk({ kind: "selected", photoIds: kept });
    } catch {
      toast.error(t("cullActionFailed"));
    }
  }

  async function openCurate() {
    if (curateId) {
      try {
        await cullActions.resumeSession({ sessionId: curateId });
      } catch {
        toast.error(t("cullActionFailed"));
        return;
      }
    }
    setView("curate");
    onMutation();
  }

  const projectActions = {
    id: projectId,
    rankingSessionId: resultQuery.data?.rankingSessionId ?? resultRoundId,
    onStartPk: (photoIds: string[]) =>
      setPkScope({ kind: "selected", photoIds }),
    onCopy: (photoIds?: string[]) => setCopyIds(photoIds),
  };

  return (
    <TooltipProvider>
      <div
        className="flex h-full min-h-0 min-w-0 max-w-full flex-col overflow-hidden bg-black text-foreground"
        data-immersive-kind="cull"
        data-surface="immersive"
        data-testid="shooting-project-workspace"
      >
        <header
          className="flex w-full min-w-0 max-w-full shrink-0 flex-wrap items-center gap-2 border-border border-b px-3 py-2"
          data-surface="immersive-chrome"
        >
          <div className="flex min-w-0 flex-1 basis-60 items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={t("cullProject.back")}
                  data-testid="shooting-project-back"
                  onClick={() =>
                    navigate(cullReturnOptions("project", projectId))
                  }
                  size="icon"
                  variant="ghost"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t("cullProject.back")}</TooltipContent>
            </Tooltip>
            <div className="min-w-0 flex-1 basis-28">
              <h1 className="break-all font-semibold text-sm">
                {data?.project.name ?? t("loading")}
              </h1>
              {data && (
                <p
                  className="text-muted-foreground text-xs"
                  data-testid="shooting-save-status"
                >
                  {t("shootingProject.counts", {
                    count: data.photos.length,
                    kept: data.counts.kept,
                  })}{" "}
                  ·{" "}
                  {t(
                    {
                      saved: "shootingProject.selectionSaved",
                      saving: "shootingProject.saving",
                      error: "shootingProject.selectionSaveFailed",
                    }[selectionSaveStatus]
                  )}
                  {data.project.archivedAt != null && (
                    <span className="ml-2">
                      {t("cullProject.archive.taskArchived")}
                    </span>
                  )}
                </p>
              )}
              {data && (
                <ShootingProjectSourceStatusLabel
                  status={data.project.sourceStatus}
                />
              )}
            </div>
          </div>
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2">
            {data && (
              <CullArchiveButton
                onChanged={() => {
                  if (data.project.archivedAt == null) {
                    navigate({ to: "/cull" });
                  }
                }}
                task={{
                  kind: "project",
                  id: projectId,
                  name: data.project.name,
                  archivedAt: data.project.archivedAt,
                }}
              />
            )}
            <IconMotionTrigger asChild disabled={!data?.counts.kept}>
              <Button
                className="h-auto min-h-8 max-w-full whitespace-normal text-xs"
                data-testid="shooting-copy-kept"
                disabled={!data?.counts.kept}
                onClick={() => setCopyIds(undefined)}
              >
                <Copy className="h-3.5 w-3.5" />
                {t("shootingProject.copyKept")}
              </Button>
            </IconMotionTrigger>
            {outputs.tasks[0] && (
              <Button
                className="h-auto min-h-8 max-w-full whitespace-normal text-xs"
                data-testid="shooting-output-summary"
                onClick={() => setOutputsOpen(true)}
                variant="outline"
              >
                {t("cullProject.outputTasks")} ·{" "}
                {t(`shootingProject.outputStatus_${outputs.tasks[0].status}`)}
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  aria-label={t("shootingProject.sourceDetails")}
                  data-testid="shooting-source-details"
                  onClick={() => setSourceOpen(true)}
                  size="icon"
                  variant="ghost"
                >
                  <Info className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t("shootingProject.sourceDetails")}
              </TooltipContent>
            </Tooltip>
            {data && (
              <ShootingProjectManagement
                onChanged={() => workspace.refresh()}
                onDeleted={() => navigate({ to: "/cull" })}
                onOutputs={() => setOutputsOpen(true)}
                onWorkspace={workspace.accept}
                previewBytes={data.previewBytes}
                project={data.project}
              />
            )}
          </div>
        </header>
        <nav
          aria-label={t("cullMode")}
          className="flex w-full min-w-0 max-w-full shrink-0 items-center gap-1 overflow-x-auto border-border border-b px-3 py-1.5"
          data-surface="immersive-chrome"
        >
          <Button
            aria-pressed={view === "curate"}
            data-testid="shooting-tab-curate"
            onClick={openCurate}
            variant={view === "curate" ? "secondary" : "ghost"}
          >
            <Eye className="h-4 w-4" />
            {t("cullProject.curateTab")}
          </Button>
          <IconMotionTrigger asChild>
            <Button
              aria-pressed={view === "duel"}
              data-testid="shooting-tab-duel"
              onClick={() => {
                setView("duel");
                if (!duelId) {
                  openNewRound();
                }
              }}
              variant={view === "duel" ? "secondary" : "ghost"}
            >
              <Swords className="h-4 w-4" />
              {t("cullProject.duelTab")}
            </Button>
          </IconMotionTrigger>
          <Button
            aria-pressed={view === "result"}
            data-testid="shooting-tab-result"
            onClick={() => openResults()}
            variant={view === "result" ? "secondary" : "ghost"}
          >
            <ListChecks className="h-4 w-4" />
            {t("cullProject.results")}
          </Button>
          {view === "duel" && (
            <>
              {rounds.length > 1 && (
                <FilterDropdown
                  ariaLabel={t("cullProject.round")}
                  onChange={(value) => setDuelId(Number(value))}
                  options={rounds.map((round, index) => ({
                    value: String(round.id),
                    label: t("cullProject.roundNumber", {
                      number: rounds.length - index,
                    }),
                  }))}
                  placeholder={t("cullProject.round")}
                  value={String(duelId ?? "")}
                />
              )}
              {duelId !== null && (
                <Button
                  data-testid="shooting-pk-results"
                  onClick={() => openResults(duelId)}
                  variant="ghost"
                >
                  {t("cullProject.viewRanking")}
                </Button>
              )}
              <Button
                data-testid="shooting-pk-new"
                onClick={openNewRound}
                variant="ghost"
              >
                {t("cullProject.newRound")}
              </Button>
            </>
          )}
        </nav>
        {view === "result" && (
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 border-border border-b px-3 py-1.5">
            <FilterDropdown
              ariaLabel={t("cullProject.resultScope")}
              onChange={(value) =>
                setResultRoundId(value === "all" ? null : Number(value))
              }
              options={[
                { value: "all", label: t("cullProject.finalSelection") },
                ...rounds.map((round, index) => ({
                  value: String(round.id),
                  label: t("cullProject.roundNumber", {
                    number: rounds.length - index,
                  }),
                })),
              ]}
              placeholder={t("cullProject.resultScope")}
              value={resultRoundId === null ? "all" : String(resultRoundId)}
            />
            {(resultRoundId !== null || duelId !== null) && (
              <p className="min-w-0 text-muted-foreground text-xs">
                {t(
                  resultQuery.data?.projectScopeOpen
                    ? "cullProject.scanBeforeApply"
                    : resultHintKey
                )}
              </p>
            )}
          </div>
        )}
        {data &&
          (data.scan.status === "running" ||
            data.scan.status === "pending") && (
            <p
              className="shrink-0 px-3 py-1 text-muted-foreground text-xs"
              data-testid="shooting-scan-status"
              role="status"
            >
              {t("shootingProject.scanDiscovering", {
                count: data.scan.discovered,
              })}
            </p>
          )}
        {(errorKey ||
          sessionError ||
          summaryQuery.isError ||
          resultQuery.isError) && (
          <div
            className="flex shrink-0 flex-wrap items-center gap-2 p-3"
            role="alert"
          >
            <p className="text-destructive text-xs">
              {t(errorKey ?? "cullActionFailed")}
            </p>
            <Button
              onClick={() => {
                workspace.retry();
                setRetry((value) => value + 1);
                summaryQuery.refetch();
                resultQuery.refetch();
              }}
              variant="outline"
            >
              {t("retry")}
            </Button>
          </div>
        )}
        <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {(loading ||
            (!session &&
              (view !== "duel" || duelId !== null) &&
              !sessionError &&
              !summaryQuery.isError)) && (
            <div className="flex h-full items-center justify-center">
              <LoadingSpinner size="xl" />
            </div>
          )}
          {session && view === "curate" && (
            <CullCurate
              completionActions={
                <div className="mx-auto mt-4 flex max-w-md flex-wrap justify-center gap-2 px-3">
                  {workflow === "hybrid" && (
                    <>
                      <Button
                        data-testid="shooting-pk-kept"
                        disabled={(data?.counts.kept ?? 0) < 2}
                        onClick={openNewRound}
                      >
                        {t("cullProject.pkKept")}
                      </Button>
                      {(data?.counts.kept ?? 0) < 2 && (
                        <p className="w-full text-muted-foreground text-xs">
                          {t("cullProject.needTwoKept")}
                        </p>
                      )}
                    </>
                  )}
                  <Button onClick={() => openResults()} variant="outline">
                    {t("cullProject.viewResults")}
                  </Button>
                </div>
              }
              finishLabel={
                workflow === "hybrid"
                  ? t("cullProject.finishReview")
                  : undefined
              }
              key={session.id}
              onCompleted={finishReview}
              onMutationSuccess={onMutation}
              onReview={openCurate}
              onSourceDetails={() => setSourceOpen(true)}
              quietSelectionFeedback
              session={session}
            />
          )}
          {session && view === "duel" && !duelCompleted && (
            <CullDuel
              key={session.id}
              onCompleted={() => {
                setRounds((previous) =>
                  previous.map((round) =>
                    round.id === session.id
                      ? { ...round, status: "completed" }
                      : round
                  )
                );
                openResults(session.id);
              }}
              onMutationSuccess={onMutation}
              onReview={openCurate}
              onSourceDetails={() => setSourceOpen(true)}
              session={session}
            />
          )}
          {view === "duel" && (duelCompleted || duelId === null) && (
            <div className="flex h-full min-h-0 flex-col items-center justify-center gap-3 overflow-y-auto p-4 text-center">
              <p className="text-sm">
                {t(
                  duelId === null
                    ? "cullProject.startPkHint"
                    : "cullProject.roundComplete"
                )}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                <Button onClick={openNewRound}>
                  {t("cullProject.newRound")}
                </Button>
                <Button onClick={() => openResults(duelId)} variant="outline">
                  {t("cullProject.viewResults")}
                </Button>
              </div>
            </div>
          )}
          {view === "result" && resultQuery.isLoading && (
            <LoadingSpinner className="m-auto" size="xl" />
          )}
          {view === "result" && resultQuery.data && (
            <CullResult
              canApplyRanking={!resultQuery.data.projectScopeOpen}
              initialStatusFilter={resultRoundId === null ? "kept" : "all"}
              key={`${resultQuery.data.id}:${resultQuery.data.rankingSessionId ?? "round"}`}
              onRankingApplied={() => {
                if (resultRoundId !== null) {
                  setDuelId(resultRoundId);
                }
                openResults();
              }}
              onUpdate={onMutation}
              project={projectActions}
              session={resultQuery.data}
            />
          )}
        </main>
        <Dialog onOpenChange={setSourceOpen} open={sourceOpen}>
          <DialogContent
            className="max-h-[calc(100dvh-1rem)] overflow-y-auto"
            size="lg"
          >
            <DialogHeader>
              <DialogTitle>{t("shootingProject.sourceDetails")}</DialogTitle>
            </DialogHeader>
            {data && (
              <ShootingProjectProgress
                data={data}
                onRelink={() => {
                  setSourceOpen(false);
                  setRelinkOpen(true);
                }}
                projectId={projectId}
                run={workspace.run}
                saving={workspace.saveStatus === "saving"}
              />
            )}
            <IconMotionTrigger asChild>
              <Button onClick={() => workspace.refresh(true)} variant="outline">
                <RefreshCw className="h-4 w-4" />
                {t("shootingProject.checkSource")}
              </Button>
            </IconMotionTrigger>
          </DialogContent>
        </Dialog>
        <Dialog onOpenChange={setOutputsOpen} open={outputsOpen}>
          <DialogContent
            className="max-h-[calc(100dvh-1rem)] overflow-y-auto"
            size="lg"
          >
            <DialogHeader>
              <DialogTitle>{t("cullProject.outputTasks")}</DialogTitle>
            </DialogHeader>
            <ShootingProjectOutputs
              controller={outputs}
              keptCount={data?.counts.kept ?? 0}
              projectId={projectId}
              selectedIds={[]}
            />
          </DialogContent>
        </Dialog>
        {copyIds !== null && (
          <ShootingProjectOutputDialog
            onClose={() => setCopyIds(null)}
            onCreated={(task) => {
              outputs.updateTask(task, true);
              setOutputsOpen(true);
            }}
            photoIds={copyIds}
            projectId={projectId}
          />
        )}
        {relinkOpen && (
          <ShootingProjectRelinkDialog
            onClose={() => setRelinkOpen(false)}
            onComplete={workspace.accept}
            projectId={projectId}
          />
        )}
        <Dialog
          onOpenChange={(open) => !(open || starting) && setPkScope(null)}
          open={pkScope !== null}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("cullModeDuel")}</DialogTitle>
              <DialogDescription>
                {t(
                  pkScope?.kind === "selected"
                    ? "cullProject.pkSelected"
                    : "cullProject.pkAll",
                  {
                    count:
                      pkScope?.kind === "selected"
                        ? pkScope.photoIds.length
                        : (data?.photos.length ?? 0),
                  }
                )}
              </DialogDescription>
            </DialogHeader>
            <FilterDropdown
              ariaLabel={t("cullProject.resultScope")}
              onChange={(value) =>
                setPkScope(
                  value === "all"
                    ? { kind: "all" }
                    : {
                        kind: "selected",
                        photoIds:
                          data?.photos
                            .filter((photo) => photo.status === "kept")
                            .map((photo) => photo.id) ?? [],
                      }
                )
              }
              options={[
                ...(workflow === "hybrid"
                  ? []
                  : [{ value: "all", label: t("cullProject.allPhotos") }]),
                {
                  value: "selected",
                  label: t(
                    pkScope?.kind === "selected"
                      ? "cullProject.pkSelected"
                      : "cullProject.pkKept",
                    {
                      count:
                        pkScope?.kind === "selected"
                          ? pkScope.photoIds.length
                          : 0,
                    }
                  ),
                },
              ]}
              placeholder={t("cullProject.resultScope")}
              value={pkScope?.kind === "all" ? "all" : "selected"}
            />
            <FilterDropdown
              ariaLabel={t("cullPkModeLabel")}
              onChange={(value) => setPkMode(value as typeof pkMode)}
              options={[
                { value: "quick", label: t("cullPkModeQuick") },
                { value: "standard", label: t("cullPkModeStandard") },
                { value: "fine", label: t("cullPkModeFine") },
              ]}
              placeholder={t("cullPkModeLabel")}
              value={pkMode}
            />
            <DialogFooter>
              <Button
                disabled={starting}
                onClick={() => setPkScope(null)}
                variant="outline"
              >
                {t("cancel")}
              </Button>
              <Button
                data-testid="shooting-pk-start"
                disabled={
                  starting ||
                  (pkScope?.kind === "selected"
                    ? pkScope.photoIds.length < 2
                    : data?.scan.status === "completed" &&
                      data.photos.length < 2)
                }
                onClick={startPk}
              >
                {t("cullStart")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
