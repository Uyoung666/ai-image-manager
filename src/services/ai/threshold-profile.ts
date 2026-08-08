import {
  getActiveEmbeddingAdapter,
  getEmbeddingAdapter,
} from "./model-adapter";
import { getModelFingerprint } from "./model-fingerprint";

export type CalibrationStatus = "official" | "user" | "uncalibrated";

export interface ThresholdProfile {
  adapterId: string;
  calibrationStatus: CalibrationStatus;
  duplicate: {
    confirmationSimilarity: number;
  };
  hybrid?: {
    semanticWeight: number;
    tagWeight: number;
    rescueThreshold: number;
  };
  modelFingerprint: string;
  profileId: string;
  schemaVersion: 1;
  semanticSearch: {
    absoluteMinimumSimilarity: number;
    candidateMinimumSimilarity: number;
    consensusThresholdRatio: number;
    relativeToTopRatio: number;
  };
  tag: {
    candidateFromMedian: number;
    candidateFromTop: number;
    confidenceMax: number;
    confidenceMin: number;
    topFromMedian: number;
    topMinimum: number;
  };
  textDistance: {
    englishMaxCosineDistance: number;
    noCoverageMaxCosineDistance: number;
    fullCoverageMaxCosineDistance: number;
  };
}

export const SIGLIP_V1_THRESHOLD_PROFILE_ID =
  "siglip-v1-base-patch16-224-default";

function createSiglipV1Profile(): ThresholdProfile {
  const adapter = getActiveEmbeddingAdapter();
  return {
    schemaVersion: 1,
    profileId: SIGLIP_V1_THRESHOLD_PROFILE_ID,
    adapterId: adapter.id,
    modelFingerprint: getModelFingerprint(adapter),
    calibrationStatus: "official",
    duplicate: {
      confirmationSimilarity: 0.95,
    },
    semanticSearch: {
      absoluteMinimumSimilarity: 0.04,
      candidateMinimumSimilarity: 0.02,
      consensusThresholdRatio: 0.75,
      relativeToTopRatio: 0.4,
    },
    tag: {
      candidateFromMedian: 0.02,
      candidateFromTop: 0.04,
      confidenceMax: 0.95,
      confidenceMin: 0.55,
      topFromMedian: 0.03,
      topMinimum: 0.035,
    },
    textDistance: {
      englishMaxCosineDistance: 0.98,
      noCoverageMaxCosineDistance: 0.98,
      fullCoverageMaxCosineDistance: 0.98,
    },
  };
}

const officialProfiles = new Map<string, () => ThresholdProfile>([
  [SIGLIP_V1_THRESHOLD_PROFILE_ID, createSiglipV1Profile],
]);

export function registerThresholdProfile(
  profile: ThresholdProfile | (() => ThresholdProfile)
): void {
  const value = typeof profile === "function" ? profile() : profile;
  officialProfiles.set(value.profileId, () => value);
}

export function getActiveThresholdProfile(): ThresholdProfile {
  const adapter = getActiveEmbeddingAdapter();
  const fingerprint = getModelFingerprint(adapter);
  return (
    resolveThresholdProfile(adapter.id, fingerprint) ??
    getUncalibratedThresholdProfile(adapter.id, fingerprint)
  );
}

export function resolveThresholdProfile(
  adapterId: string,
  fingerprint: string
): ThresholdProfile | null {
  const adapter = getEmbeddingAdapter(adapterId);
  const profileFactory = officialProfiles.get(adapter.thresholdProfileId);
  if (!profileFactory) {
    return null;
  }
  const profile = profileFactory();
  return profile.adapterId === adapterId &&
    profile.modelFingerprint === fingerprint
    ? profile
    : null;
}

export function getUncalibratedThresholdProfile(
  adapterId: string,
  fingerprint: string
): ThresholdProfile {
  const adapter = getEmbeddingAdapter(adapterId);
  return {
    schemaVersion: 1,
    profileId: `${adapter.id}-uncalibrated`,
    adapterId,
    modelFingerprint: fingerprint,
    calibrationStatus: "uncalibrated",
    duplicate: { confirmationSimilarity: Number.POSITIVE_INFINITY },
    semanticSearch: {
      absoluteMinimumSimilarity: Number.NEGATIVE_INFINITY,
      candidateMinimumSimilarity: Number.NEGATIVE_INFINITY,
      consensusThresholdRatio: 0,
      relativeToTopRatio: 0,
    },
    tag: {
      candidateFromMedian: Number.POSITIVE_INFINITY,
      candidateFromTop: Number.POSITIVE_INFINITY,
      confidenceMax: 0,
      confidenceMin: 0,
      topFromMedian: Number.POSITIVE_INFINITY,
      topMinimum: Number.POSITIVE_INFINITY,
    },
    textDistance: {
      englishMaxCosineDistance: 1,
      noCoverageMaxCosineDistance: 1,
      fullCoverageMaxCosineDistance: 1,
    },
  };
}

export function getTextSearchThreshold(
  coverage: number,
  language: "en" | "zh"
): number {
  const profile = getActiveThresholdProfile();
  if (language === "en") {
    return profile.textDistance.englishMaxCosineDistance;
  }
  const safeCoverage = Math.max(0, Math.min(1, coverage));
  return (
    profile.textDistance.noCoverageMaxCosineDistance +
    safeCoverage *
      (profile.textDistance.fullCoverageMaxCosineDistance -
        profile.textDistance.noCoverageMaxCosineDistance)
  );
}

export function getDuplicateThreshold(): number {
  return getActiveThresholdProfile().duplicate.confirmationSimilarity;
}

export function getTagThresholds(): ThresholdProfile["tag"] {
  return getActiveThresholdProfile().tag;
}

export function getThresholdProfileIdentity(): string {
  const profile = getActiveThresholdProfile();
  return `${profile.profileId}:v${profile.schemaVersion}`;
}
