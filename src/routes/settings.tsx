import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
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
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center gap-4 px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
        <button onClick={() => navigate({ to: "/" })} className="text-[#a1a1aa] hover:text-[#f7f8f8]">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-[#f7f8f8] text-[18px] font-[590]">{t("settingsTitle")}</h1>
      </div>

      <div className="p-6 space-y-6 max-w-[500px]">
        <section className="space-y-3">
          <h2 className="text-[#f7f8f8] text-[14px] font-[590]">{t("settingsAppearance")}</h2>
          <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[#a1a1aa] text-[13px]">{t("settingsTheme")}</span>
              <ToggleTheme />
            </div>
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[rgba(255,255,255,0.04)]">
              <span className="text-[#a1a1aa] text-[13px]">{t("settingsLanguage")}</span>
              <LangToggle />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-[#f7f8f8] text-[14px] font-[590]">{t("settingsIndexing")}</h2>
          <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[#a1a1aa] text-[13px]">{t("settingsThumbnailCache")}</span>
                <p className="text-[#6b6b75] text-[11px] mt-0.5">{t("settingsThumbnailCacheHint")}</p>
              </div>
              <button
                onClick={handleClearCache}
                className="px-3 py-1.5 text-[12px] rounded-[6px] border border-[rgba(255,255,255,0.08)] text-[#a1a1aa] hover:text-[#f7f8f8] hover:border-[rgba(255,255,255,0.15)] transition-colors"
              >
                {clearCacheStatus || t("settingsClear")}
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-[#f7f8f8] text-[14px] font-[590]">{t("settingsAbout")}</h2>
          <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[#a1a1aa] text-[13px]">{t("settingsVersion")}</span>
              <span className="text-[#f7f8f8] text-[13px]">0.1.0</span>
            </div>
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[rgba(255,255,255,0.04)]">
              <span className="text-[#a1a1aa] text-[13px]">{t("settingsLicense")}</span>
              <span className="text-[#f7f8f8] text-[13px]">MIT</span>
            </div>
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[rgba(255,255,255,0.04)]">
              <span className="text-[#a1a1aa] text-[13px]">{t("settingsAuthor")}</span>
              <span className="text-[#f7f8f8] text-[13px]">Uyoung</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsPage });
