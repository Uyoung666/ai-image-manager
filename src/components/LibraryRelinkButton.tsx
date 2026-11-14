// biome-ignore-all lint/a11y/noNoninteractiveTabindex: Truncated paths expose their complete value in a keyboard-focusable tooltip.
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { libraryReliabilityActions } from "@/actions/library-reliability";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const PAGE_SIZE = 100;
type RelinkPreview = NonNullable<
  Awaited<ReturnType<typeof libraryReliabilityActions.inspectPhotoRelink>>
>;

export function LibraryPathText({ path }: { path: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="block min-w-0 truncate text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring"
          tabIndex={0}
        >
          {path}
        </span>
      </TooltipTrigger>
      <TooltipContent className="z-[70] max-w-[min(32rem,90dvw)] break-all">
        {path}
      </TooltipContent>
    </Tooltip>
  );
}

export function LibraryRelinkButton({
  target,
  onApplied,
}: {
  target: { photoId: number } | { folderId: number };
  onApplied?: () => void;
}) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<RelinkPreview | null>(null);
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const previewRef = useRef<HTMLUListElement>(null);
  const start = page * PAGE_SIZE;
  const end = start + (preview?.items.length ?? 0);

  async function inspect() {
    setBusy(true);
    try {
      const result =
        "photoId" in target
          ? await libraryReliabilityActions.inspectPhotoRelink(target.photoId)
          : await libraryReliabilityActions.inspectFolderRelink(
              target.folderId
            );
      setConfirmed(new Set());
      setPage(0);
      setPreview(result);
    } catch {
      toast.error(t("libraryReliability.error"));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview?.canApply) {
      return;
    }
    setBusy(true);
    try {
      const { updated } = await libraryReliabilityActions.applyRelink(
        preview.token,
        [...confirmed]
      );
      setPreview(null);
      toast.success(t("libraryReliability.relinkUpdated", { count: updated }));
      onApplied?.();
    } catch {
      setPreview(null);
      toast.error(t("libraryReliability.error"));
    } finally {
      setBusy(false);
    }
  }

  async function movePage(change: number) {
    if (!preview) {
      return;
    }
    const next = page + change;
    setBusy(true);
    try {
      const result = await libraryReliabilityActions.getRelinkInspection(
        preview.token,
        next * PAGE_SIZE
      );
      setPreview(result);
      setPage(next);
      previewRef.current?.scrollTo?.({ top: 0 });
    } catch {
      setPreview(null);
      toast.error(t("libraryReliability.error"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        disabled={busy}
        onClick={inspect}
        ref={trigger}
        size="sm"
        variant="outline"
      >
        {t("libraryReliability.relink")}
      </Button>
      <Dialog
        onOpenChange={(open) => {
          if (!(open || busy)) {
            setPreview(null);
          }
        }}
        open={preview !== null}
      >
        {preview && (
          <DialogContent
            className="z-[64]"
            onCloseAutoFocus={(event) => {
              if (trigger.current?.isConnected) {
                event.preventDefault();
                trigger.current.focus();
              }
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              cancelButton.current?.focus();
            }}
            overlayClassName="z-[63]"
            size="xl"
          >
            <DialogHeader>
              <DialogTitle>{t("libraryReliability.relink")}</DialogTitle>
              <DialogDescription>
                {t("libraryReliability.relinkDescription")}
              </DialogDescription>
            </DialogHeader>
            {!preview.canApply && (
              <p className="text-destructive text-sm" role="alert">
                {t("libraryReliability.relinkBlocked")}
              </p>
            )}
            <dl className="flex flex-wrap gap-2 text-xs">
              {Object.entries(preview.counts)
                .filter(([, count]) => count > 0)
                .map(([status, count]) => (
                  <div
                    className="flex gap-1 rounded-sm bg-muted p-1"
                    key={status}
                  >
                    <dt>{t(`libraryReliability.relinkStatus.${status}`)}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
            </dl>
            {preview.unverifiedPhotoIds.length > 1 && (
              <label className="flex items-start gap-2 text-xs">
                <input
                  checked={confirmed.size === preview.unverifiedPhotoIds.length}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                  onChange={(event) =>
                    setConfirmed(
                      new Set(
                        event.target.checked ? preview.unverifiedPhotoIds : []
                      )
                    )
                  }
                  type="checkbox"
                />
                {t("libraryReliability.relinkWeakAll", {
                  count: preview.unverifiedPhotoIds.length,
                })}
              </label>
            )}
            <ul
              className="max-h-[40dvh] min-w-0 space-y-2 overflow-auto rounded-md border border-border p-2 text-xs"
              ref={previewRef}
            >
              {preview.items.map((item) => (
                <li
                  className="min-w-0 space-y-1 rounded-sm bg-muted/50 p-2"
                  key={item.photoId}
                >
                  <p className="font-medium">
                    {t(`libraryReliability.relinkStatus.${item.status}`)}
                  </p>
                  <LibraryPathText path={item.oldPath} />
                  <LibraryPathText path={item.newPath} />
                  {item.status === "unverified" && (
                    <label className="flex items-start gap-2">
                      <input
                        checked={confirmed.has(item.photoId)}
                        className="mt-0.5 size-4 shrink-0 accent-primary"
                        onChange={(event) => {
                          const next = new Set(confirmed);
                          if (event.target.checked) {
                            next.add(item.photoId);
                          } else {
                            next.delete(item.photoId);
                          }
                          setConfirmed(next);
                        }}
                        type="checkbox"
                      />
                      {t("libraryReliability.relinkWeak")}
                    </label>
                  )}
                </li>
              ))}
            </ul>
            {preview.total > PAGE_SIZE && (
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                <span>
                  {t("libraryReliability.candidatePage", {
                    start: start + 1,
                    end,
                    total: preview.total,
                  })}
                </span>
                <div className="flex flex-wrap gap-1">
                  <Button
                    disabled={busy || start === 0}
                    onClick={() => movePage(-1)}
                    size="sm"
                    variant="outline"
                  >
                    {t("libraryReliability.previousPage")}
                  </Button>
                  <Button
                    disabled={busy || end >= preview.total}
                    onClick={() => movePage(1)}
                    size="sm"
                    variant="outline"
                  >
                    {t("libraryReliability.nextPage")}
                  </Button>
                </div>
              </div>
            )}
            <DialogFooter>
              <DialogClose asChild>
                <Button disabled={busy} ref={cancelButton} variant="outline">
                  {t("cancel")}
                </Button>
              </DialogClose>
              <Button
                disabled={
                  busy ||
                  !preview.canApply ||
                  preview.unverifiedPhotoIds.some(
                    (photoId) => !confirmed.has(photoId)
                  )
                }
                onClick={apply}
              >
                {t("confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
