import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { useSequenceSuggestions } from "@/hooks/useSequenceSuggestions";
import type { Photo } from "@/types/photo";
import type {
  SequenceSuggestion,
  SequenceSuggestionSegment,
} from "@/types/photo-sequence";
import { toLocalMediaUrl } from "@/utils/local-media-url";

function Preview({ photo, label }: { photo: Photo; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="min-w-0">
      <div className="flex h-24 items-center justify-center overflow-hidden rounded-md bg-muted sm:h-28">
        {failed ? (
          <span className="text-muted-foreground text-xs">{label}</span>
        ) : (
          // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Image load errors only select a non-interactive placeholder.
          <img
            alt={label}
            className="h-full w-full object-contain"
            height={photo.height || 100}
            onError={() => setFailed(true)}
            src={toLocalMediaUrl(photo.thumbnailPath ?? photo.path)}
            width={photo.width || 160}
          />
        )}
      </div>
      <Tooltip>
        <TooltipTrigger
          className="block w-full truncate text-left text-xs"
          type="button"
        >
          {photo.filename}
        </TooltipTrigger>
        <TooltipContent>{photo.filename}</TooltipContent>
      </Tooltip>
    </div>
  );
}

function Segment({
  segment,
  label,
  onOpen,
}: {
  segment: SequenceSuggestionSegment;
  label: string;
  onOpen: (id: number) => void;
}) {
  const { i18n, t } = useTranslation();
  const date = (time: number) => new Date(time).toLocaleString(i18n.language);
  return (
    <section className="min-w-0 space-y-2 rounded-lg border border-border p-3">
      <h3 className="font-medium text-sm">
        {label} · {t("sequenceSuggestionFrames", { count: segment.frameCount })}
      </h3>
      <Preview label={label} photo={segment.representative} />
      <p className="break-words text-xs">
        {date(segment.startedAt)} – {date(segment.endedAt)}
      </p>
      <p className="break-words text-muted-foreground text-xs">
        {segment.cameraModel} · {segment.lensModel}
      </p>
      <p className="text-xs">
        {t("sequenceSuggestionInterval", {
          seconds: (segment.intervalMs / 1000).toFixed(1),
        })}
      </p>
      <p className="break-all text-muted-foreground text-xs">
        {segment.firstPhoto.filename} → {segment.lastPhoto.filename}
      </p>
      <Button
        className="max-w-full whitespace-normal"
        onClick={() => onOpen(segment.id)}
        size="sm"
        variant="outline"
      >
        {t("sequenceSuggestionViewSegment", { segment: label })}
      </Button>
    </section>
  );
}

export function SequenceSuggestionsDialog({
  open,
  onOpenChange,
  onOpenSequence,
  onReturnFocus,
  folderScoped,
  state,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSequence: (id: number) => void;
  onReturnFocus: () => void;
  folderScoped: boolean;
  state: ReturnType<typeof useSequenceSuggestions>;
}) {
  const { i18n, t } = useTranslation();
  const [pending, setPending] = useState<SequenceSuggestion | null>(null);
  const [mergedId, setMergedId] = useState<number | null>(null);
  const busy = (entry: SequenceSuggestion) =>
    state.busyIds.includes(entry.firstSequenceId) ||
    state.busyIds.includes(entry.secondSequenceId);
  const view = (id: number) => {
    onOpenChange(false);
    onOpenSequence(id);
  };
  const confirm = async () => {
    const entry = pending;
    if (!entry) {
      return;
    }
    setPending(null);
    try {
      const result = await state.accept(entry);
      if (!result) {
        return;
      }
      if (result.status === "stale") {
        toast.info(t("sequenceSuggestionStale"));
        return;
      }
      setMergedId(result.id);
      toast.success(t("sequenceMergeSuccess"));
    } catch {
      toast.error(t("sequenceMergeFailed"));
    }
  };
  return (
    <>
      <Dialog onOpenChange={onOpenChange} open={open}>
        <DialogContent
          className="max-w-3xl"
          data-testid="sequence-suggestions-dialog"
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            onReturnFocus();
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("sequenceSuggestionsTitle")}</DialogTitle>
            <DialogDescription>
              {t(
                folderScoped
                  ? "sequenceSuggestionsFolderScope"
                  : "sequenceSuggestionsAllScope"
              )}
            </DialogDescription>
          </DialogHeader>
          {state.error && (
            <div
              className="flex flex-wrap items-center gap-2 text-sm"
              role="alert"
            >
              {t("sequenceSuggestionsLoadFailed")}
              <Button onClick={state.refresh} size="sm" variant="outline">
                {t("retry")}
              </Button>
            </div>
          )}
          {state.loading && (
            <p className="text-muted-foreground text-sm" role="status">
              {t("loading")}
            </p>
          )}
          {mergedId != null && (
            <Button onClick={() => view(mergedId)} variant="outline">
              {t("sequenceSuggestionViewMerged")}
            </Button>
          )}
          {!(state.loading || state.error) &&
            state.suggestions.length === 0 && (
              <p role="status">{t("sequenceSuggestionsEmpty")}</p>
            )}
          {state.suggestions.map((entry) => (
            <article
              className="min-w-0 space-y-3 rounded-lg border border-border p-3"
              data-suggestion-id={entry.id}
              key={entry.id}
            >
              <div className="grid min-w-0 grid-cols-1 gap-3 min-[800px]:grid-cols-2">
                <Segment
                  label={t("sequenceSuggestionFirst")}
                  onOpen={view}
                  segment={entry.first}
                />
                <Segment
                  label={t("sequenceSuggestionSecond")}
                  onOpen={view}
                  segment={entry.second}
                />
              </div>
              <div className="grid min-w-0 grid-cols-2 gap-3">
                <Preview
                  label={t("sequenceSuggestionLastFrame")}
                  photo={entry.first.lastPhoto}
                />
                <Preview
                  label={t("sequenceSuggestionFirstFrame")}
                  photo={entry.second.firstPhoto}
                />
              </div>
              <p className="text-sm">
                {t("sequenceSuggestionGap", {
                  seconds: (entry.gapMs / 1000).toFixed(1),
                })}
              </p>
              <p className="break-words text-muted-foreground text-xs">
                {entry.reasonKeys.map((key) => t(key)).join(" · ")}
              </p>
              <Button
                className="max-w-full whitespace-normal"
                disabled={busy(entry)}
                onClick={() => setPending(entry)}
              >
                {t(
                  busy(entry)
                    ? "sequenceSuggestionMerging"
                    : "sequenceMergeAction"
                )}
              </Button>
            </article>
          ))}
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        confirmText={t("sequenceMergeAction")}
        description={
          pending
            ? t("sequenceSuggestionConfirm", {
                count: pending.first.frameCount + pending.second.frameCount,
                start: new Date(pending.first.startedAt).toLocaleString(
                  i18n.language
                ),
                end: new Date(pending.second.endedAt).toLocaleString(
                  i18n.language
                ),
              })
            : undefined
        }
        disabled={pending ? busy(pending) : false}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
        open={pending != null}
        title={t("sequenceMergeConfirmTitle")}
      />
    </>
  );
}
