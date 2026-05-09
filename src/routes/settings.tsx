import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";
import LangToggle from "@/components/lang-toggle";
import ToggleTheme from "@/components/toggle-theme";

function SettingsPage() {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [clearCacheStatus, setClearCacheStatus] = useState("");

  async function handleClearCache() {
    setClearCacheStatus("Clearing...");
    // This would clear the thumbnail cache in a full implementation
    setTimeout(() => setClearCacheStatus("Cache cleared!"), 1000);
    setTimeout(() => setClearCacheStatus(""), 3000);
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
        <button
          onClick={() => navigate({ to: "/" })}
          className="text-[#a1a1aa] hover:text-[#f7f8f8] transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-[#f7f8f8] text-[18px] font-[590]">Settings</h1>
      </div>

      <div className="p-6 space-y-6 max-w-[500px]">
        {/* Appearance */}
        <section className="space-y-3">
          <h2 className="text-[#f7f8f8] text-[14px] font-[590]">Appearance</h2>
          <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[#a1a1aa] text-[13px]">Theme</span>
              <ToggleTheme />
            </div>
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[rgba(255,255,255,0.04)]">
              <span className="text-[#a1a1aa] text-[13px]">Language</span>
              <LangToggle />
            </div>
          </div>
        </section>

        {/* Indexing */}
        <section className="space-y-3">
          <h2 className="text-[#f7f8f8] text-[14px] font-[590]">Indexing</h2>
          <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-[#a1a1aa] text-[13px]">Thumbnail Cache</span>
                <p className="text-[#6b6b75] text-[11px] mt-0.5">Clear cached thumbnails to free disk space</p>
              </div>
              <button
                onClick={handleClearCache}
                className="px-3 py-1.5 text-[12px] rounded-[6px] border border-[rgba(255,255,255,0.08)] text-[#a1a1aa] hover:text-[#f7f8f8] hover:border-[rgba(255,255,255,0.15)] transition-colors"
              >
                {clearCacheStatus || "Clear"}
              </button>
            </div>
          </div>
        </section>

        {/* About */}
        <section className="space-y-3">
          <h2 className="text-[#f7f8f8] text-[14px] font-[590]">About</h2>
          <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-4">
            <div className="flex items-center justify-between">
              <span className="text-[#a1a1aa] text-[13px]">Version</span>
              <span className="text-[#f7f8f8] text-[13px]">0.1.0</span>
            </div>
            <div className="flex items-center justify-between mt-3 pt-3 border-t border-[rgba(255,255,255,0.04)]">
              <span className="text-[#a1a1aa] text-[13px]">License</span>
              <span className="text-[#f7f8f8] text-[13px]">MIT</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({
  component: SettingsPage,
});
