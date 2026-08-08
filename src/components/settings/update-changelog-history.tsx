import { useNavigate } from "@tanstack/react-router";
import { ChevronRight, Sparkles } from "lucide-react";
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
    <section className="update-changelog-history mt-6 space-y-3">
      <div>
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("updateChangelogTitle")}
        </h2>
        <p className="mt-1 text-[12px] text-muted-foreground">
          {t("updateChangelogDescription")}
        </p>
      </div>
      <div className="update-changelog-list overflow-hidden rounded-[12px] border border-border bg-secondary">
        {changelogEntries.length === 0 ? (
          <p className="p-4 text-[12px] text-muted-foreground">
            {t("updateChangelogEmpty")}
          </p>
        ) : (
          changelogEntries.map((entry) => (
            <button
              className="update-changelog-item flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              key={entry.version}
              onClick={() =>
                navigate({
                  to: "/whats-new",
                  search: { version: entry.version },
                })
              }
              type="button"
            >
              <span className="update-changelog-item-icon flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                <Sparkles className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium text-[13px] text-foreground">
                  {getLocalizedText(entry.title, i18n.language)}
                </span>
                <span className="mt-0.5 block text-[11px] text-muted-foreground">
                  v{entry.version} ·{" "}
                  {formatReleaseDate(entry.date, i18n.language)}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                {t("updateChangelogView")}
                <ChevronRight className="h-3.5 w-3.5" />
              </span>
            </button>
          ))
        )}
      </div>
    </section>
  );
}
