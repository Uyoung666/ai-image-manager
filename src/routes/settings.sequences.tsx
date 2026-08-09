import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

type SequenceDetectionPreset = "strict" | "balanced" | "relaxed" | "custom";
type BuiltInSequencePreset = Exclude<SequenceDetectionPreset, "custom">;

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

type CustomSequenceValues = Pick<
  SequenceDetectionSettings,
  "rhythmTolerance" | "timelapseMinFrames" | "timelapsePHashDistance"
>;

const presets: Record<
  BuiltInSequencePreset,
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
const defaultSettings: SequenceDetectionSettings = {
  preset: "balanced",
  ...presets.balanced,
};
const defaultCustomValues: CustomSequenceValues = {
  rhythmTolerance: defaultSettings.rhythmTolerance,
  timelapseMinFrames: defaultSettings.timelapseMinFrames,
  timelapsePHashDistance: defaultSettings.timelapsePHashDistance,
};

function getCustomValues(
  settings: SequenceDetectionSettings
): CustomSequenceValues {
  return {
    rhythmTolerance: settings.rhythmTolerance,
    timelapseMinFrames: settings.timelapseMinFrames,
    timelapsePHashDistance: settings.timelapsePHashDistance,
  };
}
const presetLabelKeys: Record<SequenceDetectionPreset, string> = {
  balanced: "sequencePresetBalanced",
  custom: "sequencePresetCustom",
  relaxed: "sequencePresetRelaxed",
  strict: "sequencePresetStrict",
};

function SequencePresetToggle({
  onChange,
  value,
}: {
  onChange: (preset: SequenceDetectionPreset) => void;
  value: SequenceDetectionPreset;
}) {
  const { t } = useTranslation();
  const choices: SequenceDetectionPreset[] = [
    "strict",
    "balanced",
    "relaxed",
    "custom",
  ];

  return (
    <>
      <style>{`
        .sequence-preset-group { position: relative; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); box-sizing: border-box; width: min(260px, 100%); max-width: 100%; padding: 0.25rem; border-radius: 0.5rem; background-color: var(--muted); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.06); font-size: 14px; }
        .sequence-preset-option { min-width: 0; text-align: center; }
        .sequence-preset-option input { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
        .sequence-preset-option span { display: flex; min-width: 0; cursor: pointer; align-items: center; justify-content: center; overflow-wrap: anywhere; border-radius: 0.5rem; padding: 0.5rem 0.25rem; color: var(--muted-foreground); line-height: 1.2; transition: all 0.15s ease-in-out; user-select: none; }
        .sequence-preset-option:hover span { background-color: color-mix(in srgb, var(--surface) 50%, transparent); }
        .sequence-preset-option input:checked + span { position: relative; background-color: var(--surface); color: var(--foreground); font-weight: 600; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1); animation: sequence-preset-select 0.3s ease; }
        .sequence-preset-option input:focus-visible + span { outline: 2px solid var(--ring); outline-offset: 2px; }
        .sequence-preset-option input:checked + span::before, .sequence-preset-option input:checked + span::after { content: ""; position: absolute; width: 4px; height: 4px; border-radius: 50%; background: var(--primary); opacity: 0; animation: sequence-preset-particles 0.5s ease forwards; }
        .sequence-preset-option input:checked + span::before { top: -8px; left: 50%; transform: translateX(-50%); --direction: -10px; }
        .sequence-preset-option input:checked + span::after { bottom: -8px; left: 50%; transform: translateX(-50%); --direction: 10px; }
        @keyframes sequence-preset-select { 0% { transform: scale(0.95); } 50% { transform: scale(1.05); } 100% { transform: scale(1); } }
        @keyframes sequence-preset-particles { 0% { opacity: 0; transform: translateX(-50%) translateY(0); } 50% { opacity: 1; } 100% { opacity: 0; transform: translateX(-50%) translateY(var(--direction)); } }
        @media (max-width: 480px) { .sequence-preset-group { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        @media (prefers-reduced-motion: reduce) { .sequence-preset-option span, .sequence-preset-option input:checked + span, .sequence-preset-option input:checked + span::before, .sequence-preset-option input:checked + span::after { animation: none; transition: none; } }
      `}</style>
      <fieldset
        aria-label={t("sequencePreset")}
        className="sequence-preset-group"
      >
        {choices.map((preset) => (
          <label className="sequence-preset-option" key={preset}>
            <input
              checked={value === preset}
              name="sequence-detection-preset"
              onChange={() => onChange(preset)}
              type="radio"
            />
            <span>{t(presetLabelKeys[preset])}</span>
          </label>
        ))}
      </fieldset>
    </>
  );
}

function SequenceSettingsPage() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState(defaultSettings);
  const customValuesRef = useRef<CustomSequenceValues>(defaultCustomValues);
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key: "sequence.detection.settings" })
      .then((result) => {
        const value = (result as { value?: string | null }).value;
        if (!value) {
          return;
        }
        const parsed = JSON.parse(value) as Partial<SequenceDetectionSettings>;
        const preset: SequenceDetectionPreset =
          parsed.preset === "strict" ||
          parsed.preset === "relaxed" ||
          parsed.preset === "custom"
            ? parsed.preset
            : "balanced";
        const next = {
          ...defaultSettings,
          ...(preset === "custom" ? {} : presets[preset]),
          ...parsed,
          preset,
        };
        if (preset === "custom") {
          customValuesRef.current = getCustomValues(next);
        }
        setSettings(next);
      })
      .catch(() => undefined);
  }, []);

  function save(next: SequenceDetectionSettings) {
    setSettings(next);
    ipc.client.settings
      .setAppSetting({
        key: "sequence.detection.settings",
        value: JSON.stringify(next),
      })
      .catch(() => setSettings(settings));
  }

  function saveCustom(values: CustomSequenceValues) {
    customValuesRef.current = values;
    save({ ...settings, ...values, preset: "custom" });
  }

  return (
    <SettingsPageShell
      description={t("settingsSequenceDetectionHint")}
      scrollRef={scrollRef}
      title={t("settingsSequenceDetection")}
    >
      <SettingsSection>
        <SettingRow
          action={
            <SequencePresetToggle
              onChange={(preset) =>
                save(
                  preset === "custom"
                    ? {
                        ...settings,
                        ...customValuesRef.current,
                        preset,
                      }
                    : { preset, ...presets[preset] }
                )
              }
              value={settings.preset}
            />
          }
          description={t("sequencePresetHint")}
          title={t("sequencePreset")}
        />
        <SettingRow
          action={
            <input
              className="w-20 max-w-full rounded border border-border bg-background px-2 py-1 text-sm"
              min={3}
              onChange={(event) =>
                saveCustom({
                  ...getCustomValues(settings),
                  timelapseMinFrames: Number(event.target.value) || 6,
                })
              }
              type="number"
              value={settings.timelapseMinFrames}
            />
          }
          description={t("sequenceTimelapseMinFramesHint")}
          title={t("sequenceTimelapseMinFrames")}
        />
        <SettingRow
          action={
            <input
              className="w-20 max-w-full rounded border border-border bg-background px-2 py-1 text-sm"
              max={50}
              min={1}
              onChange={(event) =>
                saveCustom({
                  ...getCustomValues(settings),
                  rhythmTolerance: Number(event.target.value) / 100 || 0.15,
                })
              }
              type="number"
              value={Math.round(settings.rhythmTolerance * 100)}
            />
          }
          description={t("sequenceRhythmToleranceHint")}
          title={t("sequenceRhythmTolerance")}
        />
        <SettingRow
          action={
            <input
              className="w-20 max-w-full rounded border border-border bg-background px-2 py-1 text-sm"
              max={64}
              min={1}
              onChange={(event) =>
                saveCustom({
                  ...getCustomValues(settings),
                  timelapsePHashDistance: Number(event.target.value) || 16,
                })
              }
              type="number"
              value={settings.timelapsePHashDistance}
            />
          }
          description={t("sequencePHashDistanceHint")}
          title={t("sequencePHashDistance")}
        />
      </SettingsSection>
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/sequences")({
  component: SequenceSettingsPage,
});
