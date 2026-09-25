import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { duplicateActions } from "@/actions/duplicates";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function DuplicateCleanupBatches({
  onRestored,
}: {
  onRestored?: () => void;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [failures, setFailures] = useState<
    Record<string, Array<{ id: number; filename: string }>>
  >({});
  const batches = useQuery({
    queryKey: ["duplicate-cleanup-batches"],
    queryFn: duplicateActions.listCleanupBatches,
  });
  const restore = useMutation({
    mutationFn: duplicateActions.restoreCleanupBatch,
    onError: () => toast.error(t("duplicateCleanupRestoreFailed")),
    onSuccess: (result) => {
      setFailures((previous) => ({
        ...previous,
        [result.batchId]: result.failed,
      }));
      if (result.failed.length === 0) {
        toast.success(
          t("duplicateCleanupRestoreSuccess", {
            count: result.restoredIds.length,
          })
        );
      } else {
        toast.error(
          t("duplicateCleanupRestorePartial", {
            count: result.restoredIds.length,
            failed: result.failed.length,
          })
        );
      }
      client.invalidateQueries({ queryKey: ["duplicate-cleanup-batches"] });
      client.invalidateQueries({ queryKey: ["duplicates"] });
      onRestored?.();
    },
  });
  if (batches.isError) {
    return (
      <button
        className="px-4 py-2 text-left text-destructive text-sm"
        onClick={() => batches.refetch()}
        type="button"
      >
        {t("duplicateBatchLoadFailed")}
      </button>
    );
  }
  if (!batches.data?.length) {
    return null;
  }
  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          className="rounded-md border border-border px-3 py-1.5 text-[13px] text-muted-foreground hover:text-foreground"
          type="button"
        >
          {t("duplicateCleanupHistory", { count: batches.data.length })}
        </button>
      </DialogTrigger>
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {t("duplicateCleanupHistory", { count: batches.data.length })}
          </DialogTitle>
          <DialogDescription>
            {t("duplicateCleanupHistoryHint")}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3">
          {batches.data.map((batch) => (
            <li
              className="flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
              key={batch.batchId}
            >
              <div className="min-w-0 [overflow-wrap:anywhere]">
                <p>
                  {t("duplicateCleanupBatchLabel", {
                    date: new Date(batch.executedAt).toLocaleString(),
                    count: batch.remainingCount,
                    interpolation: { escapeValue: false },
                  })}
                </p>
                {failures[batch.batchId]?.length ? (
                  <div
                    className="mt-3 rounded-md bg-destructive/5 p-3 text-destructive text-sm"
                    role="alert"
                  >
                    <p>{t("duplicateCleanupRestoreFailureHint")}</p>
                    <ul className="mt-2 space-y-1 text-foreground">
                      {failures[batch.batchId].map((item) => (
                        <li className="[overflow-wrap:anywhere]" key={item.id}>
                          {item.filename}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
              <button
                aria-label={t("duplicateCleanupRestoreButtonForBatch", {
                  id: batch.batchId.slice(0, 8),
                })}
                className="shrink-0 rounded border border-border px-3 py-1.5 disabled:opacity-50"
                disabled={restore.isPending}
                onClick={() => restore.mutate(batch.batchId)}
                type="button"
              >
                {t("duplicateCleanupRestoreButton")}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
