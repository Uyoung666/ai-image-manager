import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentTheme, type ThemeMode } from "@/actions/theme";
import LangToggle from "@/components/lang-toggle";
import { SettingRow } from "@/components/settings/setting-row";
import ToggleTheme from "@/components/toggle-theme";
import { Switch } from "@/components/ui/switch";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

type SequenceDetectionPreset = "strict" | "balanced" | "relaxed";
interface SequenceDetectionSettings {
  burstMinFrames: number;
  continuationWindowMs: number;
  maxMissingFrames: number;
  maxTimelapseGapMs: number;
  minTimelapseGapMs: number;
  preset: SequenceDetectionPreset;
  rhythmTolerance: number;
  timelapseMinFrames: number;
  timelapsePHashDistance: number;
}
const sequenceDetectionPresets: Record<
  SequenceDetectionPreset,
  Omit<SequenceDetectionSettings, "preset">
> = {
  strict: {
    burstMinFrames: 3,
    continuationWindowMs: 900_000,
    maxMissingFrames: 0,
    maxTimelapseGapMs: 600_000,
    minTimelapseGapMs: 2000,
    rhythmTolerance: 0.1,
    timelapseMinFrames: 8,
    timelapsePHashDistance: 12,
  },
  balanced: {
    burstMinFrames: 3,
    continuationWindowMs: 1_800_000,
    maxMissingFrames: 2,
    maxTimelapseGapMs: 600_000,
    minTimelapseGapMs: 2000,
    rhythmTolerance: 0.15,
    timelapseMinFrames: 6,
    timelapsePHashDistance: 16,
  },
  relaxed: {
    burstMinFrames: 3,
    continuationWindowMs: 2_700_000,
    maxMissingFrames: 2,
    maxTimelapseGapMs: 900_000,
    minTimelapseGapMs: 2000,
    rhythmTolerance: 0.2,
    timelapseMinFrames: 5,
    timelapsePHashDistance: 20,
  },
};
const defaultSequenceDetectionSettings: SequenceDetectionSettings = {
  preset: "balanced",
  ...sequenceDetectionPresets.balanced,
};

const SIDEBAR_COLLAPSED_KEY = "sidebar_collapsed";

interface OpenAtLoginResult {
  openAtLogin?: boolean;
}

interface AppSettingResult {
  value?: string | null;
}

function AppearanceSettingsPage() {
  const { t } = useTranslation();
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [openAtLogin, setOpenAtLogin] = useState(false);
  const [syncCullFavorites, setSyncCullFavorites] = useState(true);
  const [sequenceSettings, setSequenceSettings] =
    useState<SequenceDetectionSettings>(defaultSequenceDetectionSettings);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true";
    } catch {
      return false;
    }
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    getCurrentTheme().then(setThemeMode);
    ipc.client.settings.getOpenAtLogin({}).then((r) => {
      const result = r as OpenAtLoginResult;
      setOpenAtLogin(result.openAtLogin ?? false);
    });
    ipc.client.settings
      .getAppSetting({ key: "cull.syncKeptWithFavorites" })
      .then((r) => {
        const result = r as AppSettingResult;
        setSyncCullFavorites(result.value !== "false");
      });
    ipc.client.settings
      .getAppSetting({ key: "sequence.detection.settings" })
      .then((result) => {
        const value = (result as AppSettingResult | null)?.value;
        if (!value) {
          return;
        }
        const parsed = JSON.parse(value) as Partial<SequenceDetectionSettings>;
        const preset: SequenceDetectionPreset =
          parsed.preset === "strict" || parsed.preset === "relaxed"
            ? parsed.preset
            : "balanced";
        setSequenceSettings({
          ...defaultSequenceDetectionSettings,
          ...sequenceDetectionPresets[preset],
          ...parsed,
          preset,
        });
      })
      .catch(() => undefined);
  }, []);

  let themeDescription = t("themeSystem");
  if (themeMode === "dark") {
    themeDescription = t("themeDark");
  } else if (themeMode === "light") {
    themeDescription = t("themeLight");
  }

  function handleOpenAtLoginToggle() {
    const next = !openAtLogin;
    setOpenAtLogin(next);
    ipc.client.settings.setOpenAtLogin({ openAtLogin: next }).catch(() => {
      setOpenAtLogin(!next); // rollback on failure
    });
  }

  function handleSidebarCollapsedToggle() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    try {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  function handleSyncCullFavoritesToggle() {
    const next = !syncCullFavorites;
    setSyncCullFavorites(next);
    ipc.client.settings
      .setAppSetting({
        key: "cull.syncKeptWithFavorites",
        value: String(next),
      })
      .catch(() => setSyncCullFavorites(!next));
  }

  function saveSequenceSettings(next: SequenceDetectionSettings) {
    setSequenceSettings(next);
    ipc.client.settings
      .setAppSetting({
        key: "sequence.detection.settings",
        value: JSON.stringify(next),
      })
      .catch(() => setSequenceSettings(sequenceSettings));
  }

  function handleSequencePreset(value: SequenceDetectionPreset) {
    saveSequenceSettings({
      preset: value,
      ...sequenceDetectionPresets[value],
    });
  }

  return (
    <div className="h-full overflow-y-auto p-4 sm:p-6" ref={scrollRef}>
      <section className="mx-auto w-full max-w-[820px] space-y-3">
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("settingsAppearance")}
        </h2>
        <div className="rounded-[8px] border border-border bg-secondary p-4">
          <SettingRow
            action={<ToggleTheme onChange={setThemeMode} />}
            description={themeDescription}
            title={t("settingsTheme")}
          />

          <SettingRow action={<LangToggle />} title={t("settingsLanguage")} />

          <SettingRow
            action={
              <Switch
                checked={openAtLogin}
                onCheckedChange={handleOpenAtLoginToggle}
              />
            }
            description={t("openAtLoginHint")}
            title={t("openAtLogin")}
          />

          <SettingRow
            action={
              <Switch
                checked={sidebarCollapsed}
                onCheckedChange={handleSidebarCollapsedToggle}
              />
            }
            description={t("sidebarDefaultCollapsedHint")}
            title={t("sidebarDefaultCollapsed")}
          />

          <SettingRow
            action={
              <Switch
                checked={syncCullFavorites}
                onCheckedChange={handleSyncCullFavoritesToggle}
              />
            }
            description={t("cullSyncFavoritesHint")}
            title={t("cullSyncFavorites")}
          />
        </div>
        <section className="space-y-3 pt-4">
          <div>
            <h2 className="font-semibold text-[14px] text-foreground">
              序列识别
            </h2>
            <p className="mt-1 text-muted-foreground text-sm">
              自动结果只会生成连续且可验证的片段；长暂停仅给出合并建议。
            </p>
          </div>
          <div className="rounded-[8px] border border-border bg-secondary p-4">
            <SettingRow
              action={
                <select
                  className="rounded border border-border bg-background px-2 py-1 text-sm"
                  onChange={(event) =>
                    handleSequencePreset(
                      event.target.value as SequenceDetectionPreset
                    )
                  }
                  value={sequenceSettings.preset}
                >
                  <option value="strict">严格</option>
                  <option value="balanced">平衡</option>
                  <option value="relaxed">宽松</option>
                </select>
              }
              description="严格优先避免错判；平衡为默认；宽松可提高召回。"
              title="识别预设"
            />
            <SettingRow
              action={
                <input
                  className="w-20 rounded border border-border bg-background px-2 py-1 text-sm"
                  min={3}
                  onChange={(event) =>
                    saveSequenceSettings({
                      ...sequenceSettings,
                      timelapseMinFrames: Number(event.target.value) || 6,
                    })
                  }
                  type="number"
                  value={sequenceSettings.timelapseMinFrames}
                />
              }
              description="少于此数量的照片永不自动识别为延时。"
              title="延时最小帧数"
            />
            <SettingRow
              action={
                <input
                  className="w-20 rounded border border-border bg-background px-2 py-1 text-sm"
                  max={50}
                  min={1}
                  onChange={(event) =>
                    saveSequenceSettings({
                      ...sequenceSettings,
                      rhythmTolerance: Number(event.target.value) / 100 || 0.15,
                    })
                  }
                  type="number"
                  value={Math.round(sequenceSettings.rhythmTolerance * 100)}
                />
              }
              description="相邻间隔相对滚动中位数的允许偏差（百分比，另有 1 秒绝对容差）。"
              title="节奏容差"
            />
            <SettingRow
              action={
                <input
                  className="w-20 rounded border border-border bg-background px-2 py-1 text-sm"
                  max={64}
                  min={1}
                  onChange={(event) =>
                    saveSequenceSettings({
                      ...sequenceSettings,
                      timelapsePHashDistance: Number(event.target.value) || 16,
                    })
                  }
                  type="number"
                  value={sequenceSettings.timelapsePHashDistance}
                />
              }
              description="相邻画面 pHash 最大汉明距离；值越小越严格。"
              title="画面距离阈值"
            />
          </div>
        </section>
      </section>
    </div>
  );
}

export const Route = createFileRoute("/settings/appearance")({
  component: AppearanceSettingsPage,
});
