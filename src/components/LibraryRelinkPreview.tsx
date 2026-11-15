import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { libraryReliabilityActions as actions } from "@/actions/library-reliability";
import { LibraryPathText } from "@/components/LibraryPathText";
import { Button } from "@/components/ui/button";
import type { RelinkPreview } from "@/routes/settings.library";
import { libraryErrorKey } from "@/utils/library-error";

export function LibraryRelinkPreview({
  preview,
  busy,
  onClose,
  onChange,
  onApply,
  onRetry,
}: {
  preview: RelinkPreview;
  busy: boolean;
  onClose: () => void;
  onChange: (preview: RelinkPreview) => void;
  onApply: (ids: number[]) => void;
  onRetry?: () => void;
}) {
  const { t } = useTranslation();
  const [expired, setExpired] = useState(preview.expiresAt <= Date.now());
  useEffect(() => {
    const timer = setTimeout(
      () => setExpired(true),
      Math.max(0, preview.expiresAt - Date.now())
    );
    return () => clearTimeout(timer);
  }, [preview.expiresAt]);
  const [confirmed, setConfirmed] = useState<Set<number>>(new Set());
  const [offset, setOffset] = useState(0);
  const [showMatched, setShowMatched] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  async function page(next: number) {
    setLoading(true);
    setError(undefined);
    try {
      onChange(
        await actions.getRelinkInspection(preview.token, next, undefined)
      );
      setOffset(next);
    } catch (cause) {
      setError(libraryErrorKey(cause));
    } finally {
      setLoading(false);
    }
  }
  return (
    <section
      aria-label={t("libraryReliability.relink")}
      className="min-w-0 space-y-3 rounded-md border border-border p-3 text-xs"
      data-surface="card"
    >
      <h3 className="font-medium text-sm">{t("libraryReliability.relink")}</h3>
      <p>{t("libraryReliability.relinkDescription")}</p>
      {expired && onRetry && (
        <Button disabled={busy} onClick={onRetry} variant="outline">
          {t("libraryReliability.retryLocation")}
        </Button>
      )}
      {error && (
        <p className="text-destructive" role="alert">
          {t(error)}
        </p>
      )}
      {!preview.canApply && (
        <p className="text-destructive" role="alert">
          {t("libraryReliability.relinkBlocked")}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {Object.entries(preview.counts)
          .filter(([, count]) => count > 0)
          .map(([kind, count]) => (
            <span key={kind}>
              {t(`libraryReliability.relinkStatus.${kind}`)} {count}
            </span>
          ))}
      </div>
      {preview.unverifiedPhotoIds.length > 0 && (
        <label className="flex items-start gap-2">
          <input
            checked={confirmed.size === preview.unverifiedPhotoIds.length}
            className="mt-0.5 accent-primary"
            onChange={(event) =>
              setConfirmed(
                new Set(event.target.checked ? preview.unverifiedPhotoIds : [])
              )
            }
            type="checkbox"
          />
          {t("libraryReliability.relinkWeakAll", {
            count: preview.unverifiedPhotoIds.length,
          })}
        </label>
      )}
      {preview.counts.matched > 0 && (
        <Button
          aria-expanded={showMatched}
          onClick={() => setShowMatched(!showMatched)}
          variant="ghost"
        >
          {t("libraryReliability.showMatched", {
            count: preview.counts.matched,
          })}
        </Button>
      )}
      <ul className="min-w-0 space-y-2">
        {preview.items
          .filter((item) => showMatched || item.status !== "matched")
          .sort(
            (a, b) =>
              Number(a.status === "matched") - Number(b.status === "matched")
          )
          .map((item) => (
            <li
              className="min-w-0 space-y-1 rounded bg-muted p-2"
              key={item.photoId}
            >
              <p className="font-medium">
                {t(`libraryReliability.relinkStatus.${item.status}`)}
              </p>
              <p>{t("libraryReliability.oldLocation")}</p>
              <LibraryPathText path={item.oldPath} />
              <p>↓ {t("libraryReliability.newLocation")}</p>
              <LibraryPathText path={item.newPath} />
            </li>
          ))}
      </ul>
      {preview.total > 100 && (
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={loading || offset === 0 || busy}
            onClick={() => page(Math.max(0, offset - 100))}
            variant="outline"
          >
            {t("libraryReliability.previousPage")}
          </Button>
          <Button
            disabled={
              loading || offset + preview.items.length >= preview.total || busy
            }
            onClick={() => page(offset + 100)}
            variant="outline"
          >
            {t("libraryReliability.nextPage")}
          </Button>
        </div>
      )}
      <div className="sticky bottom-0 flex flex-wrap justify-end gap-2 border-border border-t bg-background py-2">
        <Button disabled={busy} onClick={onClose} variant="outline">
          {t("cancel")}
        </Button>
        <Button
          disabled={
            busy ||
            loading ||
            expired ||
            !preview.canApply ||
            preview.unverifiedPhotoIds.some((id) => !confirmed.has(id))
          }
          onClick={() => onApply([...confirmed])}
        >
          {t("libraryReliability.applyRelink")}
        </Button>
      </div>
    </section>
  );
}
