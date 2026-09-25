export const DUPLICATE_SENSITIVITY_PRESETS = [
  "strict",
  "standard",
  "loose",
] as const;

export type DuplicateSensitivity =
  (typeof DUPLICATE_SENSITIVITY_PRESETS)[number];

export interface DuplicateSensitivityConfig {
  embeddingThreshold: number;
  phashThreshold: number;
  preset: DuplicateSensitivity;
  version: string;
}

const CONFIGS: Record<DuplicateSensitivity, DuplicateSensitivityConfig> = {
  strict: {
    embeddingThreshold: 0.98,
    phashThreshold: 4,
    preset: "strict",
    version: "duplicate-thresholds-v1",
  },
  standard: {
    embeddingThreshold: 0.95,
    phashThreshold: 8,
    preset: "standard",
    version: "duplicate-thresholds-v1",
  },
  loose: {
    embeddingThreshold: 0.92,
    phashThreshold: 12,
    preset: "loose",
    version: "duplicate-thresholds-v1",
  },
};

export function parseDuplicateSensitivity(
  value: string | null
): DuplicateSensitivity {
  return value && value in CONFIGS
    ? (value as DuplicateSensitivity)
    : "standard";
}

export function getDuplicateSensitivityConfig(
  _value: string | null
): DuplicateSensitivityConfig {
  return { ...CONFIGS.standard, version: "duplicate-thresholds-v2" };
}
