import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { photoTagActions } from "@/actions/photo-tags";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { queryClient } from "@/providers/QueryProvider";

type Tag = Awaited<ReturnType<typeof photoTagActions.list>>[number];
type Intent = "add" | "remove";

function TagChoice({
  tag,
  count,
  total,
  intent,
  disabled,
  onToggle,
}: {
  tag: Tag;
  count: number;
  total: number;
  intent?: Intent;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const checked = intent === "add" || (!intent && count === total && count > 0);
  const mixed = !intent && count > 0 && count < total;
  const statusKey =
    intent === "add" ? "batchTagsWillAdd" : "batchTagsWillRemove";
  const status = intent
    ? t(statusKey)
    : t("batchTagsOwnership", { count, total });
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="flex min-w-0 cursor-pointer items-center gap-3 rounded px-2 py-2 hover:bg-muted">
          <input
            aria-checked={mixed ? "mixed" : checked}
            aria-label={tag.name}
            checked={checked}
            className="size-4 shrink-0 accent-primary"
            disabled={disabled}
            onChange={onToggle}
            ref={(element) => {
              if (element) {
                element.indeterminate = mixed;
              }
            }}
            type="checkbox"
          />
          <span className="min-w-0 flex-1 truncate text-sm">{tag.name}</span>
          <span
            className={`shrink-0 text-[11px] ${intent ? "text-primary" : "text-muted-foreground"}`}
          >
            {status}
          </span>
        </label>
      </TooltipTrigger>
      <TooltipContent className="max-w-[min(28rem,calc(100dvw-1rem))] break-all">
        {tag.name}
      </TooltipContent>
    </Tooltip>
  );
}

function notifyChanged() {
  // The tags-changed subscribers refresh text/tag scopes and smart albums.
  // Tag mutations do not change the unfiltered gallery's order or membership.
  for (const key of ["tags", "albums"]) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
  window.dispatchEvent(new Event("tags-changed"));
}

export function BatchTagDialog({
  photoIds,
  onClose,
}: {
  photoIds: number[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [tags, setTags] = useState<Tag[]>([]);
  const [summary, setSummary] = useState<{
    counts: Map<number, number>;
    total: number;
  } | null>(null);
  const [draft, setDraft] = useState<Map<number, Intent>>(new Map());
  const [query, setQuery] = useState("");
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const busyRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reloads the same selection after an IPC failure.
  useEffect(() => {
    let active = true;
    setSummary(null);
    setError(false);
    Promise.all([photoTagActions.list(), photoTagActions.summary(photoIds)])
      .then(([list, result]) => {
        if (active) {
          setTags(list);
          setSummary(result);
        }
      })
      .catch(() => {
        if (active) {
          setError(true);
        }
      });
    return () => {
      active = false;
    };
  }, [photoIds, retry]);

  function toggle(tagId: number) {
    const count = summary?.counts.get(tagId) ?? 0;
    let initial = "none";
    if (count > 0) {
      initial = count === summary?.total ? "all" : "some";
    }
    setDraft((current) => {
      const next = new Map(current);
      const intent = current.get(tagId);
      if (!intent) {
        next.set(tagId, initial === "all" ? "remove" : "add");
      } else if (initial === "some" && intent === "add") {
        next.set(tagId, "remove");
      } else {
        next.delete(tagId);
      }
      return next;
    });
  }

  async function apply() {
    if (busyRef.current || !summary || !draft.size) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const add = [...draft]
        .filter(([, intent]) => intent === "add")
        .map(([id]) => id);
      const remove = [...draft]
        .filter(([, intent]) => intent === "remove")
        .map(([id]) => id);
      const result = await photoTagActions.apply(
        photoIds,
        add,
        remove,
        setProgress
      );
      if (result.changed) {
        notifyChanged();
      }
      if (result.failed) {
        toast.error(t("batchTagsPartial", { count: result.failed }));
      }
      if (result.changed) {
        let undone = false;
        toast.success(t("batchTagsSuccess", { count: result.changed }), {
          duration: 10_000,
          action: {
            label: t("toastUndo"),
            onClick: async () => {
              if (undone) {
                return;
              }
              undone = true;
              const pending = toast.loading(t("batchTagsUndoing"));
              try {
                const restored = await photoTagActions.undo(result.operationId);
                if (restored.restored) {
                  notifyChanged();
                }
                if (restored.expired || restored.skipped) {
                  toast.error(
                    t("batchTagsUndoConflict", { count: restored.skipped })
                  );
                } else {
                  toast.success(
                    t("batchTagsUndone", { count: restored.restored })
                  );
                }
              } catch {
                toast.error(t("batchTagsFailed"));
              } finally {
                toast.dismiss(pending);
              }
            },
          },
        });
      } else if (!result.failed) {
        toast.success(t("batchTagsNoChanges"));
      }
      onClose();
    } catch {
      toast.error(t("batchTagsFailed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const shown = tags.filter((tag) =>
    tag.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())
  );
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!(open || busyRef.current)) {
          onClose();
        }
      }}
      open
    >
      <DialogContent
        className="flex max-h-[calc(100dvh-1rem)] min-w-0 flex-col overflow-hidden"
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
          if (busyRef.current) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (busyRef.current) {
            event.preventDefault();
          }
        }}
        showCloseButton={!busy}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>
            {t("batchTagsTitle", { count: photoIds.length })}
          </DialogTitle>
          <DialogDescription>{t("batchTagsDescription")}</DialogDescription>
        </DialogHeader>
        {/* Loading, error, and editable states are mutually exclusive. */}
        {error && (
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span role="alert">{t("loadFailedRetry")}</span>
            <button
              onClick={() => setRetry((value) => value + 1)}
              type="button"
            >
              {t("retry")}
            </button>
          </div>
        )}
        {!error && summary && (
          <>
            <SmoothInput
              aria-label={t("batchTagsSearch")}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              disabled={busy}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("batchTagsSearch")}
              value={query}
              wrapperClassName="min-w-0 w-full"
            />
            <div
              className="min-h-0 min-w-0 overflow-y-auto overscroll-contain rounded-md border border-border p-1"
              data-batch-tag-list
            >
              <fieldset
                aria-label={t("batchTagsTitle", { count: photoIds.length })}
                className="min-w-0 border-0 p-0"
              >
                {shown.length ? (
                  shown.map((tag) => (
                    <TagChoice
                      count={summary.counts.get(tag.id) ?? 0}
                      disabled={busy}
                      intent={draft.get(tag.id)}
                      key={tag.id}
                      onToggle={() => toggle(tag.id)}
                      tag={tag}
                      total={summary.total}
                    />
                  ))
                ) : (
                  <p className="p-3 text-muted-foreground text-sm">
                    {t("batchTagsNoMatches")}
                  </p>
                )}
              </fieldset>
            </div>
            {draft.size > 50 && (
              <p className="text-[12px] text-destructive" role="alert">
                {t("batchTagsLimit")}
              </p>
            )}
            <p
              aria-live="polite"
              className="text-[12px] text-muted-foreground"
              role="status"
            >
              {busy
                ? t("batchTagsProgress", {
                    count: progress,
                    total: photoIds.length,
                  })
                : t("batchTagsDraft", { count: draft.size })}
            </p>
          </>
        )}
        {!(error || summary) && (
          <div className="flex items-center gap-2 text-sm">
            <LoadingSpinner size="sm" />
            {t("loading")}
          </div>
        )}
        <DialogFooter className="shrink-0 flex-wrap">
          <button
            className="rounded-md border border-border px-3 py-1.5 text-sm disabled:opacity-50"
            disabled={busy}
            onClick={onClose}
            type="button"
          >
            {t("cancel")}
          </button>
          <button
            className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-primary-foreground text-sm disabled:opacity-50"
            disabled={busy || !summary?.total || !draft.size || draft.size > 50}
            onClick={apply}
            type="button"
          >
            {busy && <LoadingSpinner size="sm" variant="inherit" />}
            {t("batchTagsApply")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
