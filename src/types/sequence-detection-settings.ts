export type SequenceDetectionPreset =
  | "strict"
  | "balanced"
  | "relaxed"
  | "custom";
export type BuiltInSequencePreset = Exclude<SequenceDetectionPreset, "custom">;

export interface SequenceDetectionSettings {
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

export const sequenceDetectionPresets: Record<
  BuiltInSequencePreset,
  Omit<SequenceDetectionSettings, "preset">
> = {
  strict: {
    burstMinFrames: 3,
    continuationWindowMs: 15 * 60_000,
    maxMissingFrames: 0,
    maxTimelapseGapMs: 10 * 60_000,
    minTimelapseGapMs: 2000,
    rhythmTolerance: 0.1,
    timelapseMinFrames: 8,
    timelapsePHashDistance: 12,
  },
  balanced: {
    burstMinFrames: 3,
    continuationWindowMs: 30 * 60_000,
    maxMissingFrames: 2,
    maxTimelapseGapMs: 10 * 60_000,
    minTimelapseGapMs: 2000,
    rhythmTolerance: 0.15,
    timelapseMinFrames: 6,
    timelapsePHashDistance: 16,
  },
  relaxed: {
    burstMinFrames: 3,
    continuationWindowMs: 45 * 60_000,
    maxMissingFrames: 2,
    maxTimelapseGapMs: 15 * 60_000,
    minTimelapseGapMs: 2000,
    rhythmTolerance: 0.2,
    timelapseMinFrames: 5,
    timelapsePHashDistance: 20,
  },
};

export const defaultSequenceDetectionSettings: SequenceDetectionSettings = {
  preset: "balanced",
  ...sequenceDetectionPresets.balanced,
};

export function normalizeSequenceDetectionSettings(
  value: unknown
): SequenceDetectionSettings {
  const parsed =
    value && typeof value === "object"
      ? (value as Partial<SequenceDetectionSettings>)
      : {};
  const preset =
    parsed.preset === "strict" ||
    parsed.preset === "relaxed" ||
    parsed.preset === "custom"
      ? parsed.preset
      : "balanced";
  const base =
    sequenceDetectionPresets[preset === "custom" ? "balanced" : preset];
  const number = (
    key: keyof typeof base,
    min: number,
    max: number,
    integer = false
  ) => {
    const raw = parsed[key];
    const next =
      typeof raw === "number" && Number.isFinite(raw) ? raw : base[key];
    return Math.min(max, Math.max(min, integer ? Math.round(next) : next));
  };
  const minTimelapseGapMs = number("minTimelapseGapMs", 1000, 86_400_000, true);
  return {
    preset,
    burstMinFrames: number("burstMinFrames", 3, 1_000_000, true),
    timelapseMinFrames: number("timelapseMinFrames", 3, 1_000_000, true),
    minTimelapseGapMs,
    maxTimelapseGapMs: Math.max(
      minTimelapseGapMs,
      number("maxTimelapseGapMs", 2000, 86_400_000, true)
    ),
    rhythmTolerance: number("rhythmTolerance", 0.01, 0.5),
    timelapsePHashDistance: number("timelapsePHashDistance", 1, 64, true),
    maxMissingFrames: number("maxMissingFrames", 0, 2, true),
    continuationWindowMs: number(
      "continuationWindowMs",
      60_000,
      86_400_000,
      true
    ),
  };
}
