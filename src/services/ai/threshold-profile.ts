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
    /** Conservative development-set floors keyed by stable candidate ID. */
    candidateMinimumById?: Record<string, number>;
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
      // Calibrated on tag-benchmark-v2 development rows with explicit media
      // negatives. Infinity keeps labels with insufficient evidence in the
      // audit candidate set without allowing them into automatic output.
      candidateMinimumById: {
        photograph: 0.09,
        illustration: 0.0585,
        // Anime has only 14 reviewed positives in v2 (<20); keep it as an
        // experiment candidate until a larger, balanced set is annotated.
        anime: Number.POSITIVE_INFINITY,
        text_overlay: 0.0638,
        sticker: Number.POSITIVE_INFINITY,
        emoji: Number.POSITIVE_INFINITY,
        cartoon: Number.POSITIVE_INFINITY,
        digital_art: Number.POSITIVE_INFINITY,
        "format:comic panel or comic art": Number.POSITIVE_INFINITY,
        "format:computer screenshot": Number.POSITIVE_INFINITY,
        "format:scanned document": 0.0775,
        "format:chart or data visualization": Number.POSITIVE_INFINITY,
        "format:map or map illustration": Number.POSITIVE_INFINITY,
        // Poster has only 15 development positives (<20); keep it in the
        // audit candidate set until the next reviewed batch expands evidence.
        "format:poster or flyer": Number.POSITIVE_INFINITY,
        "format:icon or pictogram": Number.POSITIVE_INFINITY,
        "format:logo or brand mark": Number.POSITIVE_INFINITY,
        "format:pixel art": Number.POSITIVE_INFINITY,
        "format:watercolor painting": Number.POSITIVE_INFINITY,
        "format:pencil sketch or line drawing": Number.POSITIVE_INFINITY,
        "format:three dimensional render": Number.POSITIVE_INFINITY,
      },
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
      candidateMinimumById: {},
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
