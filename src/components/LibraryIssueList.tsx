import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { libraryReliabilityActions } from "@/actions/library-reliability";
import { FilterDropdown } from "@/components/filter-dropdown";
import { LibraryPhotoControls } from "@/components/LibraryPhotoControls";
import { LibraryPathText } from "@/components/LibraryRelinkButton";
import { Button } from "@/components/ui/button";
import { toLocalMediaUrl } from "@/utils/local-media-url";

const FILTERS = [
  "all",
  "offline",
  "missing",
  "inaccessible",
  "failed",
] as const;
export function LibraryIssueList({
  folderId,
  onBack,
  showBack = false,
}: {
  folderId?: number;
  onBack?: () => void;
  showBack?: boolean;
}) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const [status, setStatus] = useState<(typeof FILTERS)[number]>("all");
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<number>();
  const issues = useQuery({
    queryKey: ["libraryHealth", "issues", folderId, status, offset],
    queryFn: () =>
      libraryReliabilityActions.getIssues({ folderId, status, offset }),
  });
  useEffect(() => {
    if (issues.data && offset > 0 && offset >= issues.data.total) {
      setOffset(
        Math.max(
          0,
          Math.floor((issues.data.total - 1) / issues.data.limit) *
            issues.data.limit
        )
      );
      setSelected(undefined);
    }
  }, [issues.data, offset]);
  return (
    <section
      aria-label={t("libraryReliability.issueList")}
      className="w-full min-w-0 max-w-full space-y-3 rounded-md border border-border p-3"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="font-medium text-sm">
          {t("libraryReliability.issueList")}
        </h3>
        <FilterDropdown
          ariaLabel={t("libraryReliability.issueFilter")}
          className="w-full min-w-0 max-w-full"
          onChange={(value) => {
            setStatus(value as typeof status);
            setOffset(0);
            setSelected(undefined);
          }}
          options={FILTERS.map((value) => ({
            value,
            label: t(
              value === "all"
                ? "libraryReliability.issueAll"
                : `libraryReliability.status.${value}`
            ),
          }))}
          placeholder={t("libraryReliability.issueAll")}
          value={status}
          wrapperClassName="w-40 min-w-0 max-w-full"
        />
        {showBack && (
          <Button onClick={onBack} size="sm" variant="ghost">
            {t("libraryReliability.backToScope")}
          </Button>
        )}
      </div>
      {issues.isPending && <p role="status">{t("loading")}</p>}
      {issues.isError && (
        <p className="text-destructive" role="alert">
          {t("libraryReliability.error")}
        </p>
      )}
      {issues.data && (
        <>
          <p className="text-muted-foreground text-xs" role="status">
            {t("libraryReliability.issueRange", {
              from: issues.data.items.length ? offset + 1 : 0,
              to: issues.data.items.length
                ? offset + issues.data.items.length
                : 0,
              total: issues.data.total,
            })}
          </p>
          {issues.data.items.length === 0 && (
            <p className="text-muted-foreground text-xs">
              {t("libraryReliability.noIssues")}
            </p>
          )}
          <ul className="min-w-0 space-y-2">
            {issues.data.items.map((photo) => (
              <li
                className="min-w-0 space-y-2 rounded bg-muted/40 p-2 text-xs"
                key={photo.id}
              >
                <div className="flex min-w-0 items-start justify-between gap-2">
                  {photo.thumbnailPath && (
                    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: cache load recovery is not a user interaction.
                    <img
                      alt=""
                      className="size-12 shrink-0 rounded object-contain"
                      height={48}
                      loading="lazy"
                      onError={(event) => {
                        event.currentTarget.style.visibility = "hidden";
                      }}
                      src={toLocalMediaUrl(photo.thumbnailPath)}
                      width={48}
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <LibraryPathText path={photo.filename} />
                    <LibraryPathText path={photo.path} />
                  </div>
                  <Button
                    aria-expanded={selected === photo.id}
                    aria-label={t("libraryReliability.managePhoto", {
                      filename: photo.filename,
                      interpolation: { escapeValue: false },
                    })}
                    onClick={() =>
                      setSelected(selected === photo.id ? undefined : photo.id)
                    }
                    size="sm"
                    variant="outline"
                  >
                    {t("libraryReliability.manage")}
                  </Button>
                </div>
                <p>
                  {t(`libraryReliability.status.${photo.sourceStatus}`)}
                  {photo.refreshStatus === "failed"
                    ? ` · ${t("libraryReliability.status.failed")}`
                    : ""}
                </p>
                {selected === photo.id && (
                  <LibraryPhotoControls
                    onUpdated={() => {
                      client.invalidateQueries({ queryKey: ["libraryHealth"] });
                    }}
                    photo={photo}
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              disabled={offset === 0 || issues.isFetching}
              onClick={() => {
                setOffset(Math.max(0, offset - issues.data.limit));
                setSelected(undefined);
              }}
              size="sm"
              variant="outline"
            >
              {t("libraryReliability.previousPage")}
            </Button>
            <Button
              disabled={
                offset + issues.data.items.length >= issues.data.total ||
                issues.isFetching
              }
              onClick={() => {
                setOffset(offset + issues.data.limit);
                setSelected(undefined);
              }}
              size="sm"
              variant="outline"
            >
              {t("libraryReliability.nextPage")}
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
