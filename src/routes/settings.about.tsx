import { SiGithub } from "@icons-pack/react-simple-icons";
import { createFileRoute } from "@tanstack/react-router";
import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "@/actions/shell";
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

function AboutSettingsPage() {
  const { t } = useTranslation();
  const [appVersion, setAppVersion] = useState("");
  const [depsExpanded, setDepsExpanded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
  }, []);

  return (
    <div className="h-full overflow-y-auto p-6" ref={scrollRef}>
      <div className="space-y-6">
        {/* App info */}
        <section className="space-y-3">
          <h2 className="font-[590] text-[14px] text-foreground">
            {t("settingsAbout")}
          </h2>
          <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsVersion")}
              </span>
              <span className="text-[13px] text-foreground">
                {appVersion || "..."}
              </span>
            </div>
            <div className="flex items-center justify-between border-border border-t pt-3">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsLicense")}
              </span>
              <span className="text-[13px] text-foreground">MIT</span>
            </div>
            <div className="flex items-center justify-between border-border border-t pt-3">
              <span className="text-[13px] text-muted-foreground">
                {t("settingsAuthor")}
              </span>
              <span className="text-[13px] text-foreground">Uyoung</span>
            </div>
            <div className="border-border border-t pt-3">
              <button
                className="flex w-full items-center gap-2 rounded-[6px] border border-input px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
                onClick={() =>
                  openExternalLink(
                    "https://github.com/Uyoung666/ai-image-manager"
                  )
                }
                title={t("settingsOpenGitHub")}
                type="button"
              >
                <SiGithub className="h-4 w-4" />
                <span>{t("settingsGitHub")}</span>
              </button>
            </div>
          </div>
        </section>

        {/* Dependencies (collapsible) */}
        <section className="space-y-3">
          <button
            className="flex w-full items-center gap-1.5 text-left font-[590] text-[14px] text-foreground hover:text-foreground/80"
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
