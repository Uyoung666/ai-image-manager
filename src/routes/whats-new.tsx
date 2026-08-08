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
import {
  getChangelog,
  getLatestChangelog,
  getLocalizedText,
} from "@/content/changelogs";

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
      <div className="whats-new-release-visual-core">
        <span />
        <span />
        <span />
        <span />
      </div>
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
      <div className="flex h-full items-center justify-center p-6 text-center">
        <button
          className="rounded-full bg-primary px-5 py-2.5 font-medium text-primary-foreground text-sm transition-transform hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={handleContinue}
          type="button"
        >
          {t("whatsNewContinue")}
        </button>
      </div>
    );
  }

  const language = i18n.language;
  const title = getLocalizedText(entry.title, language);
  const summary = getLocalizedText(entry.summary, language);
  const highlightCount = String(entry.highlights.length).padStart(2, "0");

  return (
    <div className="whats-new-page h-full overflow-hidden">
      <div className="whats-new-page-inner">
        <nav
          aria-label={t("updateChangelogTitle")}
          className="whats-new-topbar"
        >
          <div className="whats-new-brand">
            <span aria-hidden="true" className="whats-new-brand-mark">
              <span />
              <span />
              <span />
              <span />
            </span>
            <span>AI Image Manager</span>
          </div>
          <button
            aria-label={t("whatsNewClose")}
            className="whats-new-close"
            onClick={handleContinue}
            type="button"
          >
            <X className="h-[17px] w-[17px]" strokeWidth={1.8} />
          </button>
        </nav>

        <main className="whats-new-main">
          <header className="whats-new-hero">
            <ReleaseVisual version={entry.version} />
            <div className="whats-new-hero-copy">
              <p className="whats-new-eyebrow">{t("whatsNewEyebrow")}</p>
              <div className="whats-new-meta">
                <span className="whats-new-version">v{entry.version}</span>
                <span aria-hidden="true" className="whats-new-meta-dot" />
                <span>{formatReleaseDate(entry.date, language)}</span>
              </div>
              <h1 className="whats-new-title">{title}</h1>
              <p className="whats-new-summary">{summary}</p>
            </div>
          </header>

          <section
            aria-labelledby="whats-new-highlights"
            className="whats-new-highlights"
          >
            <div className="whats-new-section-heading">
              <h2 id="whats-new-highlights">{t("whatsNewHighlights")}</h2>
              <span className="whats-new-highlight-count">
                {highlightCount}
              </span>
            </div>
            <div className="whats-new-highlight-list">
              {entry.highlights.map((highlight, index) => (
                <article
                  className="whats-new-highlight"
                  key={`${entry.version}-${highlight.title.en}`}
                  style={{ "--whats-new-index": index } as CSSProperties}
                >
                  <span className="whats-new-highlight-number">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <div className="whats-new-highlight-copy">
                    <h3>{getLocalizedText(highlight.title, language)}</h3>
                    <p>{getLocalizedText(highlight.description, language)}</p>
                  </div>
                  <ArrowUpRight
                    aria-hidden="true"
                    className="whats-new-highlight-arrow"
                    strokeWidth={1.6}
                  />
                </article>
              ))}
            </div>
            <button
              className="whats-new-github-link"
              onClick={() => openExternalLink(GITHUB_RELEASE_URL)}
              type="button"
            >
              {t("whatsNewGithub")}
              <ArrowUpRight
                aria-hidden="true"
                className="h-3.5 w-3.5"
                strokeWidth={1.7}
              />
            </button>
          </section>
        </main>

        <footer className="whats-new-actions">
          <button
            autoFocus
            className="whats-new-continue"
            onClick={handleContinue}
            type="button"
          >
            {t("whatsNewContinue")}
            <ArrowRight
              aria-hidden="true"
              className="h-4 w-4"
              strokeWidth={1.8}
            />
          </button>
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
