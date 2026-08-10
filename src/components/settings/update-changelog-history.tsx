import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { changelogEntries, getLocalizedText } from "@/content/changelogs";

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

export function UpdateChangelogHistory() {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();

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
      <div className="update-changelog-list overflow-hidden rounded-[8px] border border-border bg-secondary p-2 min-[480px]:p-3">
        {changelogEntries.length === 0 ? (
          <p className="p-4 text-[12px] text-muted-foreground">
            {t("updateChangelogEmpty")}
          </p>
        ) : (
          changelogEntries.map((entry) => (
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
                    search: { version: entry.version },
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
    </section>
  );
}
