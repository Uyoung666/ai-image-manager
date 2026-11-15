import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { libraryReliabilityActions as actions } from "@/actions/library-reliability";
import { LibraryPathText } from "@/components/LibraryPathText";
import { LibraryRelinkPreview } from "@/components/LibraryRelinkPreview";
import {
  LibrarySettingsPhoto,
  type PhotoCheckState,
} from "@/components/LibrarySettingsPhoto";
import { LibraryTaskPanel } from "@/components/LibraryTaskPanel";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import { Button } from "@/components/ui/button";
import { LIBRARY_HEALTH_QUERY } from "@/hooks/use-library-change";
import { libraryErrorKey } from "@/utils/library-error";

type Task = Awaited<ReturnType<typeof actions.getTask>>;
export type RelinkPreview = NonNullable<Task["preview"]>;

function LibrarySettingsPage() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [taskId, setTaskId] = useState<string>();
  const [error, setError] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [offset, setOffset] = useState(0);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<RelinkPreview | null>(null);
  const completedTask = useRef<string | undefined>(undefined);
  const health = useQuery({
    queryKey: [...LIBRARY_HEALTH_QUERY, "sources"],
    queryFn: () => actions.getHealth(),
  });
  const updateState = useQuery({
    queryKey: [...LIBRARY_HEALTH_QUERY, "update-state"],
    queryFn: () => actions.getUpdateState(),
    enabled: (health.data?.pending ?? 0) > 0,
  });
  const task = useQuery({
    queryKey: [...LIBRARY_HEALTH_QUERY, "task", taskId],
    queryFn: () => (taskId ? actions.getTask(taskId) : actions.getActiveTask()),
    refetchOnMount: "always",
    refetchInterval: ({ state }) => checkPollInterval(state.data),
  });
  const running =
    task.data?.status === "queued" || task.data?.status === "running";
  const listingScope = search.folderId || search.unassigned;
  const expanded = Boolean(listingScope || search.photoId);
  const photos = useQuery({
    queryKey: [
      ...LIBRARY_HEALTH_QUERY,
      "photos",
      search.folderId,
      search.photoId,
      search.unassigned,
      query,
      offset,
    ],
    queryFn: () =>
      actions.getPhotos({
        folderId: search.folderId,
        photoId: search.photoId,
        unassigned: search.unassigned,
        status: "attention",
        query,
        offset,
      }),
    enabled: expanded,
  });
  const refresh = () =>
    client.invalidateQueries({ queryKey: LIBRARY_HEALTH_QUERY });
  useEffect(() => {
    const result = task.data;
    if (
      !result ||
      result.status === "queued" ||
      result.status === "running" ||
      completedTask.current === result.taskId
    ) {
      return;
    }
    completedTask.current = result.taskId;
    if (result.preview) {
      setPreview(result.preview);
    }
    if (result.updated !== undefined) {
      setPreview(null);
    }
    client.invalidateQueries({ queryKey: LIBRARY_HEALTH_QUERY });
  }, [task.data, client]);
  useEffect(() => {
    if (photos.data && offset > 0 && offset >= photos.data.total) {
      setOffset(
        Math.max(
          0,
          Math.floor((photos.data.total - 1) / photos.data.limit) *
            photos.data.limit
        )
      );
    }
  }, [photos.data, offset]);
  async function run(
    work: () => Promise<{ taskId: string } | null>,
    onError = (cause: unknown) => setError(libraryErrorKey(cause))
  ) {
    setStarting(true);
    setError(undefined);
    try {
      const result = await work();
      if (result) {
        setTaskId(result.taskId);
      }
      return result;
    } catch (cause) {
      onError(cause);
      return null;
    } finally {
      setStarting(false);
    }
  }
  async function dismiss() {
    if (task.data) {
      await actions.dismissTask(task.data.taskId);
    }
    setPreview(null);
    setTaskId(undefined);
    await refresh();
  }
  const busy = [starting, running, taskId && task.isPending].some(Boolean);
  const setScope = (folderId?: number, unassigned?: boolean) => {
    setOffset(0);
    setQuery("");
    navigate({ search: { folderId, unassigned } });
  };
  const folders = health.data?.folders ?? [];
  const roots = folders.filter((folder) => folder.parentId === null);
  const unassignedCount = health.data?.unassignedCount ?? 0;
  const affected = roots.filter(
    (folder) => folder.attentionCount > 0 || folder.unavailable > 0
  );
  const hasAffected = affected.length + unassignedCount > 0;
  return (
    <SettingsPageShell
      description={preview ? undefined : t("libraryReliability.description")}
      headerAction={
        <Button
          disabled={busy || Boolean(preview)}
          onClick={() => run(() => actions.reconcile({}))}
          variant="outline"
        >
          {t("libraryReliability.checkAll")}
        </Button>
      }
      title={t("libraryReliability.title")}
    >
      {health.data && !preview && (
        <p className="text-muted-foreground text-xs">
          {t("libraryReliability.summary", health.data)} ·{" "}
          {t("libraryReliability.offlineCount", {
            count: health.data.offlineCount,
          })}
        </p>
      )}
      {[error, health.isError, expanded && photos.isError, task.isError].some(
        Boolean
      ) && (
        <p className="text-destructive text-xs" role="alert">
          {t(error ?? "libraryReliability.error")}
        </p>
      )}
      <PausedUpdateHint state={updateState.data?.autoIndex.state} />
      {task.data && showTaskPanel(task.data, preview) && (
        <LibraryTaskPanel
          onCancel={() =>
            run(async () => {
              if (task.data) {
                await actions.cancelTask(task.data.taskId);
              }
              await task.refetch();
              return null;
            })
          }
          onDismiss={() =>
            run(async () => {
              await dismiss();
              return null;
            })
          }
          task={task.data}
        />
      )}
      {preview ? (
        <LibraryRelinkPreview
          busy={busy}
          key={preview.token}
          onApply={(confirmed) =>
            run(() => actions.beginApplyRelink(preview.token, confirmed))
          }
          onChange={setPreview}
          onClose={() =>
            run(async () => {
              await dismiss();
              return null;
            })
          }
          onRetry={() =>
            run(async () => {
              if (!task.data) {
                return null;
              }
              const next = await actions.retryRelink(task.data.taskId);
              setPreview(null);
              return next;
            })
          }
          preview={preview}
        />
      ) : (
        <>
          {expanded && (
            <section
              aria-label={t("libraryReliability.tab.photos")}
              className="min-w-0 space-y-3"
            >
              <Button onClick={() => setScope()} variant="ghost">
                {t("libraryReliability.backToSources")}
              </Button>
              {listingScope && (
                <input
                  aria-label={t("libraryReliability.search")}
                  className="h-8 w-full min-w-0 rounded-md border border-input bg-background px-2 text-xs"
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setOffset(0);
                  }}
                  placeholder={t("libraryReliability.search")}
                  value={query}
                />
              )}
              <LibraryPhotoResults
                busy={busy}
                data={photos.data}
                fetching={photos.isFetching}
                latestTask={task.data}
                offset={offset}
                onCheck={(photo) =>
                  run(() => actions.reconcile({ photoIds: [photo.id] }))
                }
                onFolder={(folderId) => setScope(folderId)}
                onOffset={setOffset}
                onRelink={(photoId, candidatePath) =>
                  run(() => actions.beginRelink({ photoId, candidatePath }))
                }
                onUpdated={refresh}
                pending={photos.isPending}
                photoId={search.photoId}
              />
            </section>
          )}
          {!expanded && (
            <section
              aria-label={t("libraryReliability.tab.folders")}
              className="space-y-3"
            >
              {health.isPending && <p role="status">{t("loading")}</p>}
              {health.data && !hasAffected && (
                <p role="status">{t("libraryReliability.noIssues")}</p>
              )}
              <UnassignedSource
                count={unassignedCount}
                onOpen={() => setScope(undefined, true)}
              />
              {affected.map((folder) => (
                <section
                  className="min-w-0 space-y-2 rounded-[8px] border border-border bg-secondary p-3"
                  data-surface="card"
                  key={folder.id}
                >
                  <h3 className="break-words font-medium text-sm">
                    {folder.displayName}
                  </h3>
                  <LibraryPathText path={folder.path} />
                  <p className="text-muted-foreground text-xs">
                    {t("libraryReliability.sourceSummary", {
                      count: folder.attentionCount,
                      offline: folder.offlineCount,
                    })}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {folder.failedCount > 0 && !folder.unavailable && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run(() => actions.retrySourceUpdates(folder.id))
                        }
                      >
                        {t("libraryReliability.retryRefresh")}
                      </Button>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() =>
                        folder.sourceStatus === "offline" ||
                        folder.sourceStatus === "inaccessible"
                          ? run(() =>
                              actions.reconcile({ folderId: folder.id })
                            )
                          : setScope(folder.id)
                      }
                      variant="outline"
                    >
                      {t(folderActionLabel(folder.sourceStatus))}
                    </Button>
                    {folder.unavailable > 0 && (
                      <Button
                        disabled={busy}
                        onClick={() =>
                          run(() =>
                            actions.beginRelink({ folderId: folder.id })
                          )
                        }
                        variant="outline"
                      >
                        {t("libraryReliability.relink")}
                      </Button>
                    )}
                    {(folder.sourceStatus === "offline" ||
                      folder.sourceStatus === "inaccessible") && (
                      <Button
                        onClick={() => setScope(folder.id)}
                        variant="ghost"
                      >
                        {t("libraryReliability.viewIssues")}
                      </Button>
                    )}
                  </div>
                </section>
              ))}
            </section>
          )}
        </>
      )}
    </SettingsPageShell>
  );
}
export const Route = createFileRoute("/settings/library")({
  component: LibrarySettingsPage,
  validateSearch: (
    input: Record<string, unknown>
  ): {
    folderId?: number;
    photoId?: number;
    unassigned?: boolean;
  } => ({
    folderId: positiveId(input.folderId),
    photoId: positiveId(input.photoId),
    unassigned: input.unassigned === true || undefined,
  }),
});
function positiveId(value: unknown) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

type PhotoPage = Awaited<ReturnType<typeof actions.getPhotos>>;
type PhotoRow = PhotoPage["items"][number];

function LibraryPhotoResults({
  data,
  pending,
  fetching,
  photoId,
  offset,
  onOffset,
  busy,
  onCheck,
  onRelink,
  onFolder,
  onUpdated,
  latestTask,
}: {
  data?: PhotoPage;
  pending: boolean;
  fetching: boolean;
  photoId?: number;
  offset: number;
  onOffset: (offset: number) => void;
  busy: boolean;
  onCheck: (photo: PhotoRow) => void;
  onRelink: (photoId: number, candidatePath?: string) => void;
  onFolder: (folderId?: number) => void;
  onUpdated: () => void;
  latestTask?: Task | null;
}) {
  const { t } = useTranslation();
  if (pending) {
    return <p role="status">{t("loading")}</p>;
  }
  if (!data) {
    return null;
  }
  const items = data.items;
  const latestPhotoId = singlePhotoCheckId(latestTask);
  return (
    <>
      {data.total > 0 && (
        <p className="text-muted-foreground text-xs" role="status">
          {t("libraryReliability.issueRange", {
            from: data.total ? offset + 1 : 0,
            to: offset + data.items.length,
            total: data.total,
          })}
        </p>
      )}
      {!items.length && (
        <p className="text-sm" role="status">
          {t(
            photoId
              ? "libraryReliability.photoGone"
              : "libraryReliability.noIssues"
          )}
        </p>
      )}
      {items.map((photo) => {
        const latest = photo.id === latestPhotoId ? latestTask : undefined;
        return (
          <LibrarySettingsPhoto
            busy={busy}
            checkedSourceStatus={latest?.photoStatus?.sourceStatus}
            checkState={latest ? checkOutcome(latest) : undefined}
            key={photo.id}
            onCheck={() => onCheck(photo)}
            onFolder={
              photoId ? () => onFolder(photo.folderId ?? undefined) : undefined
            }
            onRelink={(candidatePath) => onRelink(photo.id, candidatePath)}
            onUpdated={onUpdated}
            photo={photo}
          />
        );
      })}
      {data.total > data.limit && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            disabled={offset === 0 || fetching}
            onClick={() => onOffset(Math.max(0, offset - data.limit))}
            variant="outline"
          >
            {t("libraryReliability.previousPage")}
          </Button>
          <Button
            disabled={offset + data.items.length >= data.total || fetching}
            onClick={() => onOffset(offset + data.limit)}
            variant="outline"
          >
            {t("libraryReliability.nextPage")}
          </Button>
        </div>
      )}
    </>
  );
}

function folderActionLabel(status: string) {
  if (status === "offline") {
    return "libraryReliability.checkConnection";
  }
  if (status === "inaccessible") {
    return "libraryReliability.check";
  }
  return "libraryReliability.viewIssues";
}

function showTaskPanel(task: Task, preview: RelinkPreview | null) {
  return (
    singlePhotoCheckId(task) === undefined &&
    (!preview ||
      task.status === "running" ||
      task.status === "queued" ||
      task.errorCount > 0)
  );
}

function singlePhotoCheckId(task?: Task | null) {
  return task?.kind === "check" && task.scope.photoIds?.length === 1
    ? task.scope.photoIds[0]
    : undefined;
}

function checkPollInterval(task?: Task | null) {
  if (task?.status !== "queued" && task?.status !== "running") {
    return false;
  }
  return 800;
}

function checkOutcome(task: Task): PhotoCheckState {
  if (task.status === "queued" || task.status === "running") {
    return "checking";
  }
  if (task.status === "cancelled") {
    return "cancelled";
  }
  return task.status === "done" && task.errorCount === 0 && task.photoStatus
    ? "done"
    : "failed";
}

function UnassignedSource({
  count,
  onOpen,
}: {
  count: number;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  if (!count) {
    return null;
  }
  return (
    <section
      className="min-w-0 space-y-2 rounded-[8px] border border-border bg-secondary p-3"
      data-surface="card"
    >
      <h3 className="font-medium text-sm">
        {t("libraryReliability.unassignedSource")}
      </h3>
      <Button onClick={onOpen} variant="outline">
        {t("libraryReliability.unassignedReview", { count })}
      </Button>
    </section>
  );
}

function PausedUpdateHint({ state }: { state?: string }) {
  const { t } = useTranslation();
  if (state !== "paused") {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs">
      {t("libraryReliability.waitingAi")}{" "}
      <Link className="text-primary underline" to="/settings/ai-index">
        {t("settingsAiIndex")}
      </Link>
    </p>
  );
}
