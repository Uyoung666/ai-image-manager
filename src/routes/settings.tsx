import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import LangToggle from "@/components/lang-toggle";
import ToggleTheme from "@/components/toggle-theme";
import { ipc } from "@/ipc/manager";

const WM_SETTINGS_KEY = "watermark_settings";

interface WatermarkSettings {
  enabled: boolean;
  text: string;
  position: "topLeft" | "topRight" | "bottomLeft" | "bottomRight" | "center";
  opacity: number;
  fontSize: number;
}

function loadWatermarkSettings(): WatermarkSettings {
  try {
    const saved = localStorage.getItem(WM_SETTINGS_KEY);
    if (saved) return JSON.parse(saved);
  } catch { /* ignore */ }
  return {
    enabled: false,
    text: "",
    position: "bottomRight",
    opacity: 50,
    fontSize: 24,
  };
}

function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [clearCacheStatus, setClearCacheStatus] = useState("");
  const [cleanupStatus, setCleanupStatus] = useState("");
  const [cleanupCount, setCleanupCount] = useState(0);
  const [wm, setWm] = useState<WatermarkSettings>(loadWatermarkSettings);

  useEffect(() => {
    try {
      localStorage.setItem(WM_SETTINGS_KEY, JSON.stringify(wm));
    } catch { /* ignore */ }
  }, [wm]);

  async function handleClearCache() {
    setClearCacheStatus(t("settingsClearing"));
    try {
      const result = await ipc.client.photos.clearThumbCache({});
      const data = result as { fileCount?: number; freedMB?: number } | null;
      if (data?.fileCount !== undefined) {
        setClearCacheStatus(
          `已清理 ${data.fileCount} 个缓存文件，释放 ${data.freedMB ?? 0} MB`
        );
      } else {
        setClearCacheStatus(t("settingsCleared"));
      }
    } catch {
      setClearCacheStatus("清理失败");
    }
    setTimeout(() => setClearCacheStatus(""), 4000);
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
          <h2 className="font-[590] text-foreground text-[14px]">水印设置</h2>
          <div className="rounded-[8px] border border-border bg-secondary p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground text-[13px]">启用水印</span>
              <button
                className={`h-5 w-9 rounded-full transition-colors ${
                  wm.enabled ? "bg-primary" : "bg-muted"
                }`}
                onClick={() => setWm((prev) => ({ ...prev, enabled: !prev.enabled }))}
              >
                <div
                  className={`h-4 w-4 rounded-full bg-white transition-transform ${
                    wm.enabled ? "translate-x-[18px]" : "translate-x-[2px]"
                  }`}
                />
              </button>
            </div>
            {wm.enabled && (
              <>
                <div className="border-border border-t pt-3">
                  <label className="mb-1 block text-[#6b6b75] text-[11px]">水印文字</label>
                  <input
                    className="h-8 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
                    onChange={(e) => setWm((prev) => ({ ...prev, text: e.target.value }))}
                    placeholder="例如: © 2026 Your Name"
                    value={wm.text}
                  />
                </div>
                <div className="border-border border-t pt-3">
                  <label className="mb-1 block text-[#6b6b75] text-[11px]">位置</label>
                  <div className="grid grid-cols-3 gap-1">
                    {(["topLeft", "topRight", "bottomLeft", "bottomRight", "center"] as const).map((pos) => (
                      <button
                        className={`rounded-[4px] px-2 py-1 text-[11px] transition-colors ${
                          wm.position === pos
                            ? "bg-primary/20 text-primary"
                            : "text-muted-foreground hover:bg-foreground/5"
                        }`}
                        key={pos}
                        onClick={() => setWm((prev) => ({ ...prev, position: pos }))}
                      >
                        {pos === "topLeft" ? "左上" : pos === "topRight" ? "右上" : pos === "bottomLeft" ? "左下" : pos === "bottomRight" ? "右下" : "居中"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="border-border border-t pt-3">
                  <label className="mb-1 block text-[#6b6b75] text-[11px]">透明度: {wm.opacity}%</label>
                  <input
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    max={100}
                    min={10}
                    onChange={(e) => setWm((prev) => ({ ...prev, opacity: Number(e.target.value) }))}
                    step={5}
                    type="range"
                    value={wm.opacity}
                  />
                </div>
                <div className="border-border border-t pt-3">
                  <label className="mb-1 block text-[#6b6b75] text-[11px]">字号: {wm.fontSize}px</label>
                  <input
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    max={72}
                    min={12}
                    onChange={(e) => setWm((prev) => ({ ...prev, fontSize: Number(e.target.value) }))}
                    step={2}
                    type="range"
                    value={wm.fontSize}
                  />
                </div>
              </>
            )}
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
              <span className="text-foreground text-[13px]">0.4.0</span>
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
