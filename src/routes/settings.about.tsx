import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnimatedGitHubButton } from "@/components/animated-github-button";
import { ConfettiOverlay } from "@/components/ConfettiOverlay";
import { SignatureOverlay } from "@/components/SignatureOverlay";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

const DEPENDENCIES = [
  { name: "Electron", version: "41" },
  { name: "React", version: "19" },
  { name: "Vite", version: "8" },
  { name: "TypeScript", version: "5" },
  { name: "Tailwind CSS", version: "4" },
  { name: "TanStack Router", version: "1" },
  { name: "TanStack Query", version: "5" },
  { name: "Drizzle ORM", version: "0.44" },
  { name: "better-sqlite3", version: "12" },
  { name: "Sharp", version: "0.34" },
  { name: "ONNX Runtime", version: "1.26" },
  { name: "LanceDB", version: "0.18" },
  { name: "i18next", version: "26" },
];

const EASTER_EGG_CLICKS = 7;

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
    <div className="h-full overflow-y-auto p-6" ref={scrollRef}>
      <ConfettiOverlay
        active={confettiActive}
        onDone={handleConfettiDone}
        onMidpoint={handleConfettiMidpoint}
      />
      <SignatureOverlay active={signatureActive} onDone={handleSignatureDone} />

      <div className="space-y-6">
        {/* App info */}
        <section className="space-y-3">
          <h2 className="font-semibold text-[14px] text-foreground">
            {t("settingsAbout")}
          </h2>
          <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsVersion")}
              </span>
              <button
                className="group relative flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[13px] text-foreground transition-colors hover:bg-foreground/5"
                onClick={handleVersionClick}
                title={t("settingsVersion")}
                type="button"
              >
                <span className="select-none">{appVersion || "..."}</span>
                {easterEggFound && (
                  <Sparkles className="h-3.5 w-3.5 shrink-0 text-amber-400" />
                )}
              </button>
            </div>

            {/* License */}
            <div className="flex items-center justify-between border-border border-t pt-3">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsLicense")}
              </span>
              <span className="text-[13px] text-foreground">MIT</span>
            </div>

            {/* Author */}
            <div className="flex items-center justify-between border-border border-t pt-3">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsAuthor")}
              </span>
              <span className="text-[13px] text-foreground">Uyoung</span>
            </div>
          </div>

          {/* GitHub — standalone 3D flip button */}
          <div className="flex justify-start pt-1">
            <AnimatedGitHubButton href="https://github.com/Uyoung666/ai-image-manager" />
          </div>
        </section>

        {/* Dependencies (collapsible) */}
        <section className="space-y-3">
          <button
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
            <div className="rounded-[8px] border border-border bg-secondary p-4">
              <div className="space-y-1">
                {DEPENDENCIES.map((dep) => (
                  <div
                    className="flex items-center justify-between py-0.5"
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
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings/about")({
  component: AboutSettingsPage,
});
