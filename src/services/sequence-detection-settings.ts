import { getSetting } from "@/services/settings-manager";

export type SequenceDetectionPreset = "strict" | "balanced" | "relaxed";

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
  SequenceDetectionPreset,
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

export function getSequenceDetectionSettings(): SequenceDetectionSettings {
  const raw = getSetting("sequence.detection.settings");
  if (!raw) {
    return defaultSequenceDetectionSettings;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<SequenceDetectionSettings>;
    const preset: SequenceDetectionPreset =
      parsed.preset === "strict" || parsed.preset === "relaxed"
        ? parsed.preset
        : "balanced";
    const base = sequenceDetectionPresets[preset];
    return {
      ...defaultSequenceDetectionSettings,
      ...base,
      ...parsed,
      preset,
      burstMinFrames: Math.max(
        3,
        Number(parsed.burstMinFrames ?? base.burstMinFrames)
      ),
      timelapseMinFrames: Math.max(
        3,
        Number(parsed.timelapseMinFrames ?? base.timelapseMinFrames)
      ),
      minTimelapseGapMs: Math.max(
        1000,
        Number(parsed.minTimelapseGapMs ?? base.minTimelapseGapMs)
      ),
      maxTimelapseGapMs: Math.max(
        2000,
        Number(parsed.maxTimelapseGapMs ?? base.maxTimelapseGapMs)
      ),
      rhythmTolerance: Math.min(
        0.5,
        Math.max(0.01, Number(parsed.rhythmTolerance ?? base.rhythmTolerance))
      ),
      timelapsePHashDistance: Math.min(
        64,
        Math.max(
          1,
          Number(parsed.timelapsePHashDistance ?? base.timelapsePHashDistance)
        )
      ),
      maxMissingFrames: Math.min(
        2,
        Math.max(0, Number(parsed.maxMissingFrames ?? base.maxMissingFrames))
      ),
      continuationWindowMs: Math.max(
        60_000,
        Number(parsed.continuationWindowMs ?? base.continuationWindowMs)
      ),
    };
  } catch {
    return defaultSequenceDetectionSettings;
  }
}
