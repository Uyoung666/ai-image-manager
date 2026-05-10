import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import LangToggle from "@/components/lang-toggle";
import ToggleTheme from "@/components/toggle-theme";

function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [clearCacheStatus, setClearCacheStatus] = useState("");

  function handleClearCache() {
    setClearCacheStatus(t("settingsClearing"));
    setTimeout(() => setClearCacheStatus(t("settingsCleared")), 1000);
    setTimeout(() => setClearCacheStatus(""), 3000);
  }

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-4 border-[rgba(255,255,255,0.06)] border-b px-6 py-4">
        <button
          className="text-[#a1a1aa] hover:text-[#f7f8f8]"
          onClick={() => navigate({ to: "/" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-[590] text-[#f7f8f8] text-[18px]">
          {t("settingsTitle")}
        </h1>
      </div>

      <div className="max-w-[500px] space-y-6 p-6">
        <section className="space-y-3">
          <h2 className="font-[590] text-[#f7f8f8] text-[14px]">
            {t("settingsAppearance")}
          </h2>
          <div className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#121214] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[#a1a1aa] text-[13px]">
                {t("settingsTheme")}
              </span>
              <ToggleTheme />
            </div>
            <div className="mt-3 flex items-center justify-between border-[rgba(255,255,255,0.04)] border-t pt-3">
              <span className="text-[#a1a1aa] text-[13px]">
                {t("settingsLanguage")}
              </span>
              <LangToggle />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-[590] text-[#f7f8f8] text-[14px]">
            {t("settingsIndexing")}
          </h2>
          <div className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#121214] p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[#a1a1aa] text-[13px]">
                  {t("settingsThumbnailCache")}
                </span>
                <p className="mt-0.5 text-[#6b6b75] text-[11px]">
                  {t("settingsThumbnailCacheHint")}
                </p>
              </div>
              <button
                className="rounded-[6px] border border-[rgba(255,255,255,0.08)] px-3 py-1.5 text-[#a1a1aa] text-[12px] transition-colors hover:border-[rgba(255,255,255,0.15)] hover:text-[#f7f8f8]"
                onClick={handleClearCache}
              >
                {clearCacheStatus || t("settingsClear")}
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-[590] text-[#f7f8f8] text-[14px]">
            {t("settingsAbout")}
          </h2>
          <div className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#121214] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[#a1a1aa] text-[13px]">
                {t("settingsVersion")}
              </span>
              <span className="text-[#f7f8f8] text-[13px]">0.1.0</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-[rgba(255,255,255,0.04)] border-t pt-3">
              <span className="text-[#a1a1aa] text-[13px]">
                {t("settingsLicense")}
              </span>
              <span className="text-[#f7f8f8] text-[13px]">MIT</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-[rgba(255,255,255,0.04)] border-t pt-3">
              <span className="text-[#a1a1aa] text-[13px]">
                {t("settingsAuthor")}
              </span>
              <span className="text-[#f7f8f8] text-[13px]">Uyoung</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsPage });
