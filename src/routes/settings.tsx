import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import LangToggle from "@/components/lang-toggle";
import ToggleTheme from "@/components/toggle-theme";
import { ipc } from "@/ipc/manager";

function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [clearCacheStatus, setClearCacheStatus] = useState("");
  const [cleanupStatus, setCleanupStatus] = useState("");
  const [cleanupCount, setCleanupCount] = useState(0);

  function handleClearCache() {
    setClearCacheStatus(t("settingsClearing"));
    setTimeout(() => setClearCacheStatus(t("settingsCleared")), 1000);
    setTimeout(() => setClearCacheStatus(""), 3000);
  }

  const handleCleanupOrphans = useCallback(async () => {
    setCleanupStatus("正在清理...");
    try {
      const result = await ipc.client.photos.cleanupOrphanPhotos({});
      const removed = (result as any)?.removed ?? 0;
      setCleanupCount(removed);
      setCleanupStatus(`已清除 ${removed} 条无效记录`);
    } catch {
      setCleanupStatus("清理失败，请重试");
    }
    setTimeout(() => setCleanupStatus(""), 4000);
  }, []);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-4 border-border border-b px-6 py-4">
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => navigate({ to: "/" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-[590] text-foreground text-[18px]">
          {t("settingsTitle")}
        </h1>
      </div>

      <div className="max-w-[500px] space-y-6 p-6">
        <section className="space-y-3">
          <h2 className="font-[590] text-foreground text-[14px]">
            {t("settingsAppearance")}
          </h2>
          <div className="rounded-[8px] border border-border bg-secondary p-4">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-[13px]">
                {t("settingsTheme")}
              </span>
              <ToggleTheme />
            </div>
            <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
              <span className="text-muted-foreground text-[13px]">
                {t("settingsLanguage")}
              </span>
              <LangToggle />
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-[590] text-foreground text-[14px]">
            {t("settingsIndexing")}
          </h2>
          <div className="rounded-[8px] border border-border bg-secondary p-4">
            <div className="flex items-center justify-between">
              <div>
                <span className="text-muted-foreground text-[13px]">
                  {t("settingsThumbnailCache")}
                </span>
                <p className="mt-0.5 text-[#6b6b75] text-[11px]">
                  {t("settingsThumbnailCacheHint")}
                </p>
              </div>
              <button
                className="rounded-[6px] border border-input px-3 py-1.5 text-muted-foreground text-[12px] transition-colors hover:border-muted-foreground/30 hover:text-foreground"
                onClick={handleClearCache}
              >
                {clearCacheStatus || t("settingsClear")}
              </button>
            </div>
            <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
              <div>
                <span className="text-muted-foreground text-[13px]">
                  清理无效索引记录
                </span>
                <p className="mt-0.5 text-[#6b6b75] text-[11px]">
                  移除文件夹已不存在或关联丢失的照片索引
                  {cleanupCount > 0 && `（上次清理: ${cleanupCount} 条）`}
                </p>
              </div>
              <button
                className="flex items-center gap-1.5 rounded-[6px] border border-[#e5484d]/30 px-3 py-1.5 text-[#e5484d] text-[12px] transition-colors hover:border-[#e5484d]/50 hover:bg-[#e5484d]/5"
                onClick={handleCleanupOrphans}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {cleanupStatus || "清理无效记录"}
              </button>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="font-[590] text-foreground text-[14px]">
            {t("settingsAbout")}
          </h2>
          <div className="rounded-[8px] border border-border bg-secondary p-4">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-[13px]">
                {t("settingsVersion")}
              </span>
              <span className="text-foreground text-[13px]">0.1.0</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
              <span className="text-muted-foreground text-[13px]">
                {t("settingsLicense")}
              </span>
              <span className="text-foreground text-[13px]">MIT</span>
            </div>
            <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
              <span className="text-muted-foreground text-[13px]">
                {t("settingsAuthor")}
              </span>
              <span className="text-foreground text-[13px]">Uyoung</span>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsPage });
