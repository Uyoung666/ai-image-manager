import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { SettingRow } from "@/components/settings/setting-row";
import {
  SettingsPageShell,
  SettingsSection,
} from "@/components/settings/settings-page-shell";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import {
  defaultSequenceDetectionSettings as defaultSettings,
  normalizeSequenceDetectionSettings,
  sequenceDetectionPresets as presets,
  type SequenceDetectionPreset,
  type SequenceDetectionSettings,
} from "@/types/sequence-detection-settings";
import {
  createOptimisticSaveQueue,
  type OptimisticSaveQueue,
} from "@/utils/optimistic-save-queue";

type CustomSequenceValues = Pick<
  SequenceDetectionSettings,
  "rhythmTolerance" | "timelapseMinFrames" | "timelapsePHashDistance"
>;

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
  const settingsRef = useRef(defaultSettings);
  const customValuesRef = useRef<CustomSequenceValues>(defaultCustomValues);
  const saveQueueRef =
    useRef<OptimisticSaveQueue<SequenceDetectionSettings> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  if (!saveQueueRef.current) {
    saveQueueRef.current = createOptimisticSaveQueue({
      initialValue: defaultSettings,
      onCommit: (value) => {
        if (value.preset === "custom") {
          customValuesRef.current = getCustomValues(value);
        }
      },
      onRollback: (value) => {
        settingsRef.current = value;
        setSettings(value);
        if (value.preset === "custom") {
          customValuesRef.current = getCustomValues(value);
        }
      },
      onSaveError: () => toast.error(t("saveFailed")),
      persist: (value) =>
        ipc.client.settings.setAppSetting({
          key: "sequence.detection.settings",
          value: JSON.stringify(value),
        }),
    });
  }

  const hydrateSettings = useCallback((value: SequenceDetectionSettings) => {
    if (!saveQueueRef.current?.hydrate(value)) {
      return;
    }
    if (value.preset === "custom") {
      customValuesRef.current = getCustomValues(value);
    }
    settingsRef.current = value;
    setSettings(value);
  }, []);

  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key: "sequence.detection.settings" })
      .then((result) => {
        const value = (result as { value?: string | null }).value;
        if (!value) {
          hydrateSettings(defaultSettings);
          return;
        }
        const next = normalizeSequenceDetectionSettings(JSON.parse(value));
        hydrateSettings(next);
      })
      .catch(() => hydrateSettings(defaultSettings));
  }, [hydrateSettings]);

  function save(value: SequenceDetectionSettings) {
    const next = normalizeSequenceDetectionSettings(value);
    settingsRef.current = next;
    setSettings(next);
    saveQueueRef.current?.enqueue(next);
  }

  function saveCustom(values: CustomSequenceValues) {
    customValuesRef.current = values;
    save({ ...settingsRef.current, ...values, preset: "custom" });
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
                        ...settingsRef.current,
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
                  ...getCustomValues(settingsRef.current),
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
                  ...getCustomValues(settingsRef.current),
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
                  ...getCustomValues(settingsRef.current),
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
