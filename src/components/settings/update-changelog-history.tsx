import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { changelogEntries, getLocalizedText } from "@/content/changelogs";

const CHANGELOG_PAGE_SIZE = 5;

function formatReleaseDate(date: string, language: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return parsed.toLocaleDateString(
    language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US",
    {
      day: "numeric",
      month: "short",
      year: "numeric",
    }
  );
}

export function UpdateChangelogHistory({
  initialVisibleCount = CHANGELOG_PAGE_SIZE,
}: {
  initialVisibleCount?: number;
}) {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();
  const listId = useId();
  const [visibleCount, setVisibleCount] = useState(initialVisibleCount);
  const visibleEntries = changelogEntries.slice(0, visibleCount);
  const expanded = visibleCount > CHANGELOG_PAGE_SIZE;

  return (
    <section className="update-changelog-history min-w-0 space-y-3">
      <div>
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("updateChangelogTitle")}
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground [overflow-wrap:anywhere]">
          {t("updateChangelogDescription")}
        </p>
      </div>
      <div
        className="update-changelog-list overflow-hidden rounded-[8px] border border-border bg-secondary p-2 min-[480px]:p-3"
        data-surface="section-card"
        id={listId}
      >
        {changelogEntries.length === 0 ? (
          <p className="p-4 text-[12px] text-muted-foreground">
            {t("updateChangelogEmpty")}
          </p>
        ) : (
          visibleEntries.map((entry) => (
            <article
              className="update-changelog-item flex min-w-0 items-center gap-3 px-2 py-2.5 min-[480px]:px-3"
              key={entry.version}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <h3 className="min-w-0 max-w-full truncate font-medium text-[13px] text-foreground">
                    {getLocalizedText(entry.title, i18n.language)}
                  </h3>
                  <span className="shrink-0 text-[11px] text-muted-foreground/70">
                    v{entry.version}
                  </span>
                </div>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {formatReleaseDate(entry.date, i18n.language)}
                </p>
              </div>
              <button
                aria-label={`${getLocalizedText(entry.title, i18n.language)} · ${t("updateChangelogView")}`}
                className="cta shrink-0"
                onClick={() =>
                  navigate({
                    to: "/whats-new",
                    search: {
                      historyCount: expanded ? visibleCount : undefined,
                      source: "settings-update",
                      version: entry.version,
                    },
                  })
                }
                type="button"
              >
                <span className="hover-underline-animation">
                  {t("updateChangelogView")}
                </span>
                <svg
                  aria-hidden="true"
                  height="10"
                  viewBox="0 0 46 16"
                  width="30"
                >
                  <path
                    d="M8,0,6.545,1.455l5.506,5.506H-30V9.039H12.052L6.545,14.545,8,16l8-8Z"
                    transform="translate(30)"
                  />
                </svg>
              </button>
            </article>
          ))
        )}
      </div>
      {(changelogEntries.length > visibleCount || expanded) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {changelogEntries.length > visibleCount && (
            <button
              aria-controls={listId}
              aria-expanded={expanded}
              className="min-h-8 max-w-full rounded-md px-3 py-1.5 text-[12px] text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() =>
                setVisibleCount((count) => count + CHANGELOG_PAGE_SIZE)
              }
              type="button"
            >
              {t("updateChangelogShowMore")}
            </button>
          )}
          {expanded && (
            <button
              aria-controls={listId}
              aria-expanded={expanded}
              className="min-h-8 max-w-full rounded-md px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => setVisibleCount(CHANGELOG_PAGE_SIZE)}
              type="button"
            >
              {t("updateChangelogCollapse")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
