import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { FilterDropdown } from "@/components/filter-dropdown";
import { Switch } from "@/components/ui/switch";
import { getLocalizedText } from "@/plugins/manifest";
import type {
  NormalizedPluginManifestV2,
  PluginManifestV1,
  PluginSettingDefinition,
  PluginSettingDefinitionV2,
  PluginSettingGroupV2,
  PluginSettingValue,
} from "@/plugins/types";

type EditorManifest = PluginManifestV1 | NormalizedPluginManifestV2;
const HEX6_PATTERN = /^#[0-9a-f]{6}$/i;
const HEX8_PATTERN = /^#[0-9a-f]{8}$/i;
const HEX3_PATTERN = /^#[0-9a-f]{3}$/i;
const LEADING_HASH_PATTERN = /^/;
type EditorSetting = (PluginSettingDefinition | PluginSettingDefinitionV2) & {
  group?: string;
  order?: number;
  unit?: string;
  visibleWhen?: {
    equals?: PluginSettingValue;
    in?: PluginSettingValue[];
    notEquals?: PluginSettingValue;
    setting: string;
    value?: PluginSettingValue;
  };
};

export interface PluginSettingsEditorRecord {
  assetUrls: Record<string, string>;
  manifest: EditorManifest;
  settings: Record<string, PluginSettingValue>;
}

export type PluginSettingsResetScope = "all" | "group" | "setting";

export interface PluginSettingsEditorLabels {
  chooseImage?: string;
  chooseVideo?: string;
  removeAsset?: string;
  replaceAsset?: string;
  resetAll?: string;
  resetGroup?: string;
  resetSetting?: string;
}

export interface PluginSettingsEditorProps {
  className?: string;
  labels?: PluginSettingsEditorLabels;
  language?: string;
  onError?: (error: unknown) => void;
  onPatch: (patch: Record<string, PluginSettingValue>) => void | Promise<void>;
  onRemoveAsset?: (settingId: string) => void | Promise<void>;
  onReset?: (
    scope: PluginSettingsResetScope,
    id?: string
  ) => void | Promise<void>;
  onSelectAsset?: (settingId: string) => void | Promise<void>;
  record: PluginSettingsEditorRecord;
  t?: (key: string) => string;
}

interface PendingSlider {
  previous: PluginSettingValue;
  value: number;
}

const EMPTY_LABELS: PluginSettingsEditorLabels = {};

function settingDefinitions(manifest: EditorManifest): EditorSetting[] {
  return manifest.settings as EditorSetting[];
}

function settingGroups(manifest: EditorManifest): PluginSettingGroupV2[] {
  return manifest.manifestVersion === 2
    ? manifest.settingGroups
    : (manifest.settingGroups ?? []);
}

function orderedSettings(settings: EditorSetting[]): EditorSetting[] {
  return settings
    .map((setting, index) => ({ index, setting }))
    .sort(
      (left, right) =>
        (left.setting.order ?? 0) - (right.setting.order ?? 0) ||
        left.index - right.index
    )
    .map(({ setting }) => setting);
}

function localizedLanguage(language?: string): string {
  if (language) {
    return language;
  }
  if (typeof navigator !== "undefined") {
    return navigator.language;
  }
  return "en";
}

function valueFor(
  setting: EditorSetting,
  values: Record<string, PluginSettingValue>
): PluginSettingValue {
  return Object.hasOwn(values, setting.id)
    ? values[setting.id]
    : setting.defaultValue;
}

function conditionVisible(
  condition: EditorSetting["visibleWhen"],
  values: Record<string, PluginSettingValue>,
  definitions: Map<string, EditorSetting>
): boolean {
  if (!condition) {
    return true;
  }
  const target = definitions.get(condition.setting);
  if (!target) {
    return false;
  }
  const current = valueFor(target, values);
  if (condition.equals !== undefined) {
    return Object.is(current, condition.equals);
  }
  if (condition.notEquals !== undefined) {
    return !Object.is(current, condition.notEquals);
  }
  if (condition.in) {
    return condition.in.some((item) => Object.is(current, item));
  }
  if (condition.value !== undefined) {
    return Object.is(current, condition.value);
  }
  return false;
}

function colorInputValue(value: PluginSettingValue): string {
  if (typeof value === "string" && HEX6_PATTERN.test(value)) {
    return value;
  }
  if (typeof value === "string" && HEX8_PATTERN.test(value)) {
    return value.slice(0, 7);
  }
  if (typeof value === "string" && HEX3_PATTERN.test(value)) {
    return value
      .slice(1)
      .split("")
      .map((part) => part + part)
      .join("")
      .replace(LEADING_HASH_PATTERN, "#");
  }
  return "#6d7cff";
}

function colorValueWithPreservedAlpha(
  value: string,
  previous: PluginSettingValue
): string {
  return typeof previous === "string" && HEX8_PATTERN.test(previous)
    ? `${value}${previous.slice(7)}`
    : value;
}

function fallbackText(
  key: keyof PluginSettingsEditorLabels,
  labels: PluginSettingsEditorLabels,
  t?: (key: string) => string
): string {
  const supplied = labels[key];
  if (supplied) {
    return supplied;
  }
  const translated = t?.(`pluginSettings.${String(key)}`);
  return translated || String(key);
}

function runEditorAction(
  action: () => void | Promise<void>,
  onError?: (error: unknown) => void
): void {
  try {
    const result = action();
    if (result && typeof result.then === "function") {
      result.catch((error) => onError?.(error));
    }
  } catch (error) {
    onError?.(error);
  }
}

function usePatchController(
  record: PluginSettingsEditorRecord,
  onPatch: PluginSettingsEditorProps["onPatch"],
  onError: PluginSettingsEditorProps["onError"]
) {
  const [values, setValues] = useState<Record<string, PluginSettingValue>>(
    record.settings
  );
  const valuesRef = useRef(values);
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pendingRef = useRef(new Map<string, PendingSlider>());
  const revisionsRef = useRef(new Map<string, number>());

  useEffect(() => {
    const settingIds = new Set([
      ...Object.keys(valuesRef.current),
      ...Object.keys(record.settings),
    ]);
    for (const id of settingIds) {
      revisionsRef.current.set(id, (revisionsRef.current.get(id) ?? 0) + 1);
    }
    valuesRef.current = record.settings;
    setValues(record.settings);
  }, [record.settings]);

  useEffect(
    () => () => {
      for (const timer of timersRef.current.values()) {
        clearTimeout(timer);
      }
      timersRef.current.clear();
    },
    []
  );

  const setLocal = useCallback((id: string, value: PluginSettingValue) => {
    valuesRef.current = { ...valuesRef.current, [id]: value };
    setValues(valuesRef.current);
  }, []);

  const reportPatchFailure = useCallback(
    (error: unknown, rollback: () => void) => {
      rollback();
      onError?.(error);
    },
    [onError]
  );

  const patchNow = useCallback(
    (id: string, value: PluginSettingValue, previous: PluginSettingValue) => {
      const revision = (revisionsRef.current.get(id) ?? 0) + 1;
      revisionsRef.current.set(id, revision);
      const rollback = () => {
        if (
          revisionsRef.current.get(id) === revision &&
          Object.is(valuesRef.current[id], value)
        ) {
          setLocal(id, previous);
        }
      };
      try {
        const result = onPatch({ [id]: value });
        if (result && typeof (result as Promise<void>).then === "function") {
          (result as Promise<void>).catch((error) =>
            reportPatchFailure(error, rollback)
          );
        }
      } catch (error) {
        reportPatchFailure(error, rollback);
      }
    },
    [onPatch, reportPatchFailure, setLocal]
  );

  const flushSlider = useCallback(
    (id: string) => {
      const timer = timersRef.current.get(id);
      if (timer) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
      const pending = pendingRef.current.get(id);
      if (!pending) {
        return;
      }
      pendingRef.current.delete(id);
      patchNow(id, pending.value, pending.previous);
    },
    [patchNow]
  );

  const updateSlider = useCallback(
    (id: string, value: number) => {
      const existing = pendingRef.current.get(id);
      const previous = existing?.previous ?? valuesRef.current[id] ?? null;
      pendingRef.current.set(id, { previous, value });
      setLocal(id, value);
      const currentTimer = timersRef.current.get(id);
      if (currentTimer) {
        clearTimeout(currentTimer);
      }
      timersRef.current.set(
        id,
        setTimeout(() => {
          flushSlider(id);
        }, 150)
      );
    },
    [flushSlider, setLocal]
  );

  const updateImmediate = useCallback(
    (id: string, value: PluginSettingValue) => {
      const previous = valuesRef.current[id] ?? null;
      setLocal(id, value);
      patchNow(id, value, previous);
    },
    [patchNow, setLocal]
  );

  return {
    flushSlider,
    setLocal,
    updateImmediate,
    updateSlider,
    values,
  };
}

function AssetControl({
  definition,
  onError,
  onRemoveAsset,
  onSelectAsset,
  record,
  text,
}: {
  definition: EditorSetting;
  onError?: (error: unknown) => void;
  onRemoveAsset?: (settingId: string) => void | Promise<void>;
  onSelectAsset?: (settingId: string) => void | Promise<void>;
  record: PluginSettingsEditorRecord;
  text: (key: keyof PluginSettingsEditorLabels) => string;
}) {
  const assetUrl = record.assetUrls[definition.id];
  let chooseLabel: string;
  if (assetUrl) {
    chooseLabel = text("replaceAsset");
  } else if (definition.type === "image") {
    chooseLabel = text("chooseImage");
  } else {
    chooseLabel = text("chooseVideo");
  }
  const choose = () => {
    try {
      const result = onSelectAsset?.(definition.id);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error) => onError?.(error));
      }
    } catch (error) {
      onError?.(error);
    }
  };
  const remove = () => {
    try {
      const result = onRemoveAsset?.(definition.id);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((error) => onError?.(error));
      }
    } catch (error) {
      onError?.(error);
    }
  };
  let preview: ReactNode = null;
  if (assetUrl && definition.type === "image") {
    preview = (
      <img
        alt=""
        className="h-8 w-12 rounded-[4px] border border-border object-cover"
        height={32}
        src={assetUrl}
        width={48}
      />
    );
  } else if (assetUrl) {
    preview = (
      <video
        aria-label={text("chooseVideo")}
        className="h-8 w-12 rounded-[4px] border border-border object-cover"
        controls={false}
        height={32}
        loop
        muted
        playsInline
        src={assetUrl}
        width={48}
      />
    );
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-center justify-end gap-2">
      {preview}
      <button
        className="max-w-full rounded-[6px] border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
        onClick={choose}
        type="button"
      >
        {chooseLabel}
      </button>
      {assetUrl ? (
        <button
          className="max-w-full rounded-[6px] border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted"
          onClick={remove}
          type="button"
        >
          {text("removeAsset")}
        </button>
      ) : null}
    </div>
  );
}

function SettingControl({
  definition,
  flushSlider,
  language,
  onError,
  onRemoveAsset,
  onSelectAsset,
  record,
  text,
  updateImmediate,
  updateSlider,
  value,
}: {
  definition: EditorSetting;
  flushSlider: (id: string) => void;
  language: string;
  onError?: (error: unknown) => void;
  onRemoveAsset?: (settingId: string) => void | Promise<void>;
  onSelectAsset?: (settingId: string) => void | Promise<void>;
  record: PluginSettingsEditorRecord;
  text: (key: keyof PluginSettingsEditorLabels) => string;
  updateImmediate: (id: string, value: PluginSettingValue) => void;
  updateSlider: (id: string, value: number) => void;
  value: PluginSettingValue;
}) {
  const label = getLocalizedText(definition.label, language);
  if (definition.type === "boolean") {
    return (
      <Switch
        ariaLabel={label}
        checked={value === true}
        onCheckedChange={(next) => updateImmediate(definition.id, next)}
      />
    );
  }
  if (definition.type === "select") {
    return (
      <FilterDropdown
        ariaLabel={label}
        className="w-[160px] max-w-full"
        onChange={(next) => updateImmediate(definition.id, next)}
        options={(definition.options ?? []).map((option) => ({
          label: getLocalizedText(option.label, language),
          value: option.value,
        }))}
        placeholder={label}
        value={
          typeof value === "string" ? value : String(definition.defaultValue)
        }
      />
    );
  }
  if (definition.type === "number") {
    let numberValue = 0;
    if (typeof value === "number" && Number.isFinite(value)) {
      numberValue = value;
    } else if (typeof definition.defaultValue === "number") {
      numberValue = definition.defaultValue;
    }
    const display = `${numberValue}${definition.unit ? ` ${definition.unit}` : ""}`;
    const minimum = definition.min ?? Math.min(0, numberValue);
    const maximum = definition.max ?? Math.max(100, numberValue);
    return (
      <div className="flex min-w-[10rem] max-w-full flex-wrap items-center justify-end gap-2">
        <input
          aria-label={label}
          className="w-[140px] max-w-full accent-primary"
          max={maximum}
          min={minimum}
          onBlur={() => flushSlider(definition.id)}
          onChange={(event) =>
            updateSlider(definition.id, Number(event.target.value))
          }
          onPointerUp={() => flushSlider(definition.id)}
          step={definition.step}
          type="range"
          value={numberValue}
        />
        <output className="min-w-[3.5rem] text-right text-[11px] text-muted-foreground">
          {display}
        </output>
      </div>
    );
  }
  if (definition.type === "color") {
    return (
      <input
        aria-label={label}
        className="h-8 w-12 max-w-full cursor-pointer rounded-[4px] border border-border bg-transparent p-0.5"
        onChange={(event) =>
          updateImmediate(
            definition.id,
            colorValueWithPreservedAlpha(event.target.value, value)
          )
        }
        type="color"
        value={colorInputValue(value)}
      />
    );
  }
  return (
    <AssetControl
      definition={definition}
      onError={onError}
      onRemoveAsset={onRemoveAsset}
      onSelectAsset={onSelectAsset}
      record={record}
      text={text}
    />
  );
}

function SettingRow({
  definition,
  editor,
  language,
  onError,
  onRemoveAsset,
  onReset,
  onSelectAsset,
  record,
  text,
}: {
  definition: EditorSetting;
  editor: ReturnType<typeof usePatchController>;
  language: string;
  onError?: (error: unknown) => void;
  onRemoveAsset?: (settingId: string) => void | Promise<void>;
  onReset?: PluginSettingsEditorProps["onReset"];
  onSelectAsset?: (settingId: string) => void | Promise<void>;
  record: PluginSettingsEditorRecord;
  text: (key: keyof PluginSettingsEditorLabels) => string;
}) {
  const label = getLocalizedText(definition.label, language);
  const description = definition.description
    ? getLocalizedText(definition.description, language)
    : undefined;
  const reset = () =>
    runEditorAction(() => onReset?.("setting", definition.id), onError);
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-border/60 border-t py-2 first:border-t-0">
      <div className="min-w-0 flex-1">
        <div className="break-words text-[12px] text-foreground [overflow-wrap:anywhere]">
          {label}
        </div>
        {description ? (
          <div className="break-words text-[11px] text-muted-foreground">
            {description}
          </div>
        ) : null}
      </div>
      <div className="flex min-w-0 max-w-full shrink-0 items-center gap-2">
        <SettingControl
          definition={definition}
          flushSlider={editor.flushSlider}
          language={language}
          onError={onError}
          onRemoveAsset={onRemoveAsset}
          onSelectAsset={onSelectAsset}
          record={record}
          text={text}
          updateImmediate={editor.updateImmediate}
          updateSlider={editor.updateSlider}
          value={valueFor(definition, editor.values)}
        />
        {onReset ? (
          <button
            aria-label={`${text("resetSetting")}: ${label}`}
            className="rounded-[4px] border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted"
            onClick={reset}
            type="button"
          >
            {text("resetSetting")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function PluginSettingsEditor({
  className,
  labels = EMPTY_LABELS,
  language,
  onError,
  onPatch,
  onRemoveAsset,
  onReset,
  onSelectAsset,
  record,
  t,
}: PluginSettingsEditorProps) {
  const editor = usePatchController(record, onPatch, onError);
  const definitions = useMemo(
    () => settingDefinitions(record.manifest),
    [record.manifest]
  );
  const definitionMap = useMemo(
    () => new Map(definitions.map((definition) => [definition.id, definition])),
    [definitions]
  );
  const groups = useMemo(
    () =>
      settingGroups(record.manifest)
        .map((group, index) => ({ group, index }))
        .sort(
          (left, right) =>
            (left.group.order ?? 0) - (right.group.order ?? 0) ||
            left.index - right.index
        )
        .map(({ group }) => group),
    [record.manifest]
  );
  const sorted = useMemo(() => orderedSettings(definitions), [definitions]);
  const text = useCallback(
    (key: keyof PluginSettingsEditorLabels) => fallbackText(key, labels, t),
    [labels, t]
  );
  const visible = (definition: EditorSetting) =>
    conditionVisible(definition.visibleWhen, editor.values, definitionMap);
  const renderSetting = (definition: EditorSetting) =>
    visible(definition) ? (
      <SettingRow
        definition={definition}
        editor={editor}
        key={definition.id}
        language={language ?? localizedLanguage()}
        onError={onError}
        onRemoveAsset={onRemoveAsset}
        onReset={onReset}
        onSelectAsset={onSelectAsset}
        record={{ ...record, settings: editor.values }}
        text={text}
      />
    ) : null;

  const sections: ReactNode[] = [];
  const groupedIds = new Set<string>();
  for (const group of groups) {
    const groupSettings = sorted.filter(
      (setting) => setting.group === group.id
    );
    for (const setting of groupSettings) {
      groupedIds.add(setting.id);
    }
    if (groupSettings.length === 0) {
      continue;
    }
    sections.push(
      <section className="min-w-0" key={group.id}>
        <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
          <h3 className="min-w-0 break-words font-medium text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            {getLocalizedText(group.label, language ?? localizedLanguage())}
          </h3>
          {onReset ? (
            <button
              className="shrink-0 rounded-[4px] border border-border px-1.5 py-1 text-[10px] text-muted-foreground hover:bg-muted"
              onClick={() =>
                runEditorAction(() => onReset("group", group.id), onError)
              }
              type="button"
            >
              {text("resetGroup")}
            </button>
          ) : null}
        </div>
        <div className="min-w-0">{groupSettings.map(renderSetting)}</div>
      </section>
    );
  }
  const ungrouped = sorted.filter((setting) => !groupedIds.has(setting.id));
  if (ungrouped.length > 0) {
    sections.push(
      <section className="min-w-0" key="__ungrouped">
        <div className="min-w-0">{ungrouped.map(renderSetting)}</div>
      </section>
    );
  }

  return (
    <div
      className={`min-w-0 max-w-full space-y-3${className ? ` ${className}` : ""}`}
    >
      {onReset ? (
        <div className="flex min-w-0 justify-end">
          <button
            className="rounded-[4px] border border-border px-2 py-1 text-[10px] text-muted-foreground hover:bg-muted"
            onClick={() => runEditorAction(() => onReset("all"), onError)}
            type="button"
          >
            {text("resetAll")}
          </button>
        </div>
      ) : null}
      {sections}
    </div>
  );
}

export const PluginSettingsPanel = PluginSettingsEditor;
