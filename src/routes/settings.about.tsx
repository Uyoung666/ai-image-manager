import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AboutGallery } from "@/components/about/about-gallery";
import { AboutProductCard } from "@/components/about/about-product-card";
import "@/components/about/about.css";
import { AboutCreatorCard } from "@/components/about/about-creator-card";
import { AboutWebsiteCard } from "@/components/about/about-website-card";
import { ConfettiOverlay } from "@/components/ConfettiOverlay";
import { SignatureOverlay } from "@/components/SignatureOverlay";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

const DEPENDENCIES = [
  { name: "Electron", version: "41" },
  { name: "React", version: "19" },
  { name: "Vite", version: "8" },
  { name: "TypeScript", version: "6" },
  { name: "Tailwind CSS", version: "4" },
  { name: "TanStack Router", version: "1" },
  { name: "TanStack Query", version: "5" },
  { name: "Drizzle ORM", version: "0.44" },
  { name: "better-sqlite3", version: "12" },
  { name: "Sharp", version: "0.34" },
  { name: "ONNX Runtime", version: "1.26" },
  { name: "LanceDB", version: "0.18" },
  { name: "i18next", version: "26" },
  { name: "GSAP", version: "3" },
];

const EASTER_EGG_CLICKS = 7;
const AboutCrowd = lazy(() => import("@/components/about/about-crowd"));

function AboutSettingsPage() {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("");
  const [depsExpanded, setDepsExpanded] = useState(false);
  const [confettiActive, setConfettiActive] = useState(false);
  const [signatureActive, setSignatureActive] = useState(false);
  const [easterEggFound, setEasterEggFound] = useState(false);
  const clickCountRef = useRef(0);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
    return () => {
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  const handleVersionClick = useCallback(() => {
    clickCountRef.current += 1;

    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = setTimeout(() => {
      clickCountRef.current = 0;
    }, 1500);

    if (clickCountRef.current >= EASTER_EGG_CLICKS) {
      clickCountRef.current = 0;
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
      }
      setEasterEggFound(true);
      setConfettiActive(true);
    }
  }, []);

  const handleConfettiMidpoint = useCallback(() => {
    setSignatureActive(true);
  }, []);

  const handleConfettiDone = useCallback(() => {
    setConfettiActive(false);
  }, []);

  const handleSignatureDone = useCallback(() => {
    setSignatureActive(false);
  }, []);

  return (
    <SettingsPageShell scrollRef={scrollRef} title={t("settingsAbout")}>
      <ConfettiOverlay
        active={confettiActive}
        onDone={handleConfettiDone}
        onMidpoint={handleConfettiMidpoint}
      />
      <SignatureOverlay active={signatureActive} onDone={handleSignatureDone} />

      <div className="mx-auto w-full min-w-0 max-w-[820px] space-y-6">
        <div className="about-intro">
          <div className="about-intro-grid">
            <AboutProductCard
              easterEggFound={easterEggFound}
              onVersionClick={handleVersionClick}
              version={appVersion}
            />
            <AboutCreatorCard />
            <AboutWebsiteCard />
          </div>
        </div>
        <AboutGallery />

        {/* Dependencies (collapsible) */}
        <section className="space-y-3">
          <button
            aria-controls="about-dependencies"
            aria-expanded={depsExpanded}
            className="flex w-full items-center gap-1.5 text-left font-semibold text-[14px] text-foreground hover:text-foreground/80"
            onClick={() => setDepsExpanded(!depsExpanded)}
            type="button"
          >
            <ChevronDown
              className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                depsExpanded ? "" : "-rotate-90"
              }`}
            />
            <span>{t("settingsDependencies")}</span>
            <span className="font-normal text-[11px] text-muted-foreground/50">
              ({DEPENDENCIES.length})
            </span>
          </button>
          {depsExpanded && (
            <div
              className="min-w-0 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4"
              id="about-dependencies"
            >
              <div className="space-y-1">
                {DEPENDENCIES.map((dep) => (
                  <div
                    className="flex min-w-0 flex-wrap items-center justify-between gap-2 py-0.5"
                    key={dep.name}
                  >
                    <span className="text-[12px] text-muted-foreground/80">
                      {dep.name}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground/50">
                      v{dep.version}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
        <Suspense fallback={<div className="h-[220px]" />}>
          <AboutCrowd />
        </Suspense>
      </div>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/about")({
  component: AboutSettingsPage,
});
