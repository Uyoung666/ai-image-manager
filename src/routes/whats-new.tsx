import {
  createFileRoute,
  useNavigate,
  useSearch,
} from "@tanstack/react-router";
import { ArrowRight, ArrowUpRight, X } from "lucide-react";
import { type CSSProperties, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { openExternalLink } from "@/actions/shell";
import { Button } from "@/components/ui/button";
import {
  getChangelog,
  getLatestChangelog,
  getLocalizedText,
} from "@/content/changelogs";
import appIcon from "../../assets/icon.png";

const GITHUB_RELEASE_URL = "https://github.com/Uyoung666/ai-image-manager";

const searchSchema = z.object({
  version: z.string().optional(),
});

function formatReleaseDate(date: string, language: string): string {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }
  return parsed.toLocaleDateString(
    language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US",
    {
      day: "numeric",
      month: "long",
      year: "numeric",
    }
  );
}

function ReleaseVisual({ version }: { version: string }) {
  return (
    <div aria-hidden="true" className="whats-new-release-visual">
      <div className="whats-new-release-visual-glow whats-new-release-visual-glow-one" />
      <div className="whats-new-release-visual-glow whats-new-release-visual-glow-two" />
      <div className="whats-new-release-visual-halo" />
      <img
        alt=""
        className="whats-new-release-visual-image"
        draggable={false}
        height={78}
        src={appIcon}
        width={78}
      />
      <span className="whats-new-release-visual-version">v{version}</span>
    </div>
  );
}

export function WhatsNewPage() {
  const { i18n, t } = useTranslation();
  const navigate = useNavigate();
  const { version } = useSearch({ from: "/whats-new" });
  const entry = getChangelog(version) ?? getLatestChangelog();

  const handleContinue = useCallback(() => {
    navigate({ to: "/", replace: true });
  }, [navigate]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        handleContinue();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleContinue]);

  if (!entry) {
    return (
      <div className="flex h-full min-h-0 min-w-0 items-center justify-center overflow-y-auto p-4 text-center sm:p-6">
        <Button
          className="rounded-full bg-primary px-5 py-2.5 font-medium text-primary-foreground text-sm transition-transform hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={handleContinue}
          type="button"
        >
          {t("whatsNewContinue")}
        </Button>
      </div>
    );
  }

  const language = i18n.language;
  const title = getLocalizedText(entry.title, language);
  const summary = getLocalizedText(entry.summary, language);
  const highlightCount = String(entry.highlights.length).padStart(2, "0");

  return (
    <div className="whats-new-page !overflow-x-hidden !overflow-y-auto h-full min-h-0 min-w-0">
      <div className="whats-new-page-inner min-w-0">
        <nav
          aria-label={t("updateChangelogTitle")}
          className="whats-new-topbar min-w-0 gap-3"
        >
          <div className="whats-new-brand min-w-0">
            <img
              alt=""
              className="whats-new-brand-icon"
              draggable={false}
              height={22}
              src={appIcon}
              width={22}
            />
            <span className="min-w-0 truncate">AI Image Manager</span>
          </div>
          <Button
            aria-label={t("whatsNewClose")}
            className="whats-new-close"
            onClick={handleContinue}
            size="icon"
            type="button"
            variant="outline"
          >
            <X className="h-[17px] w-[17px]" strokeWidth={1.8} />
          </Button>
        </nav>

        <main className="whats-new-main min-w-0">
          <header className="whats-new-hero min-w-0">
            <ReleaseVisual version={entry.version} />
            <div className="whats-new-hero-copy min-w-0 max-w-full">
              <p className="whats-new-eyebrow">{t("whatsNewEyebrow")}</p>
              <div className="whats-new-meta flex-wrap">
                <span className="whats-new-version">v{entry.version}</span>
                <span aria-hidden="true" className="whats-new-meta-dot" />
                <span>{formatReleaseDate(entry.date, language)}</span>
              </div>
              <h1 className="whats-new-title break-words">{title}</h1>
              <p className="whats-new-summary break-words">{summary}</p>
            </div>
          </header>

          <section
            aria-labelledby="whats-new-highlights"
            className="whats-new-highlights min-w-0 max-w-full"
          >
            <div className="whats-new-section-heading min-w-0">
              <h2 id="whats-new-highlights">{t("whatsNewHighlights")}</h2>
              <span className="whats-new-highlight-count">
                {highlightCount}
              </span>
            </div>
            <section
              aria-labelledby="whats-new-highlights"
              className="whats-new-highlight-list min-w-0"
            >
              {entry.highlights.map((highlight, index) => (
                <article
                  className="whats-new-highlight min-w-0"
                  key={`${entry.version}-${highlight.title.en}`}
                  style={{ "--whats-new-index": index } as CSSProperties}
                >
                  <span className="whats-new-highlight-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="whats-new-highlight-copy min-w-0">
                    <h3>{getLocalizedText(highlight.title, language)}</h3>
                    <p>{getLocalizedText(highlight.description, language)}</p>
                  </div>
                </article>
              ))}
            </section>
            <Button
              className="whats-new-github-link"
              onClick={() => openExternalLink(GITHUB_RELEASE_URL)}
              size="sm"
              type="button"
              variant="link"
            >
              {t("whatsNewGithub")}
              <ArrowUpRight
                aria-hidden="true"
                className="h-3.5 w-3.5"
                strokeWidth={1.7}
              />
            </Button>
          </section>
        </main>

        <footer className="whats-new-actions min-w-0 pb-2">
          <Button
            autoFocus
            className="whats-new-continue"
            onClick={handleContinue}
            size="lg"
            type="button"
            variant="default"
          >
            {t("whatsNewContinue")}
            <ArrowRight
              aria-hidden="true"
              className="h-4 w-4"
              strokeWidth={1.8}
            />
          </Button>
          <p className="whats-new-escape-hint">{t("whatsNewEscapeHint")}</p>
        </footer>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/whats-new")({
  validateSearch: searchSchema,
  component: WhatsNewPage,
});
