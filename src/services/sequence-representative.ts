import sharp from "sharp";

const DEFAULT_ANALYSIS_CONCURRENCY = 3;
const DEFAULT_ANALYSIS_SIZE = 192;

export type SequenceRepresentativeReasonKey =
  | "sequence.representative.reason.analysisFailed"
  | "sequence.representative.reason.balancedExposure"
  | "sequence.representative.reason.favorite"
  | "sequence.representative.reason.highResolution"
  | "sequence.representative.reason.manualPreference"
  | "sequence.representative.reason.richDetail"
  | "sequence.representative.reason.sharp"
  | "sequence.representative.reason.highRating"
  | "sequence.representative.reason.stableFallback";

export const sequenceRepresentativeReasonLabels: Record<
  SequenceRepresentativeReasonKey,
  string
> = {
  "sequence.representative.reason.analysisFailed": "无法分析画面质量",
  "sequence.representative.reason.balancedExposure": "曝光有效",
  "sequence.representative.reason.favorite": "已收藏",
  "sequence.representative.reason.highResolution": "分辨率较高",
  "sequence.representative.reason.manualPreference": "符合人工偏好",
  "sequence.representative.reason.richDetail": "画面信息丰富",
  "sequence.representative.reason.sharp": "画面清晰",
  "sequence.representative.reason.highRating": "评分较高",
  "sequence.representative.reason.stableFallback": "按序列顺序选择",
};

export interface SequenceRepresentativeCandidate {
  height: number | null;
  id: number;
  isFavorite: boolean;
  /**
   * Optional normalized user preference in the [0, 1] range. This is kept
   * separate from a persisted representative so automatic recommendations do
   * not silently overwrite an explicit user choice.
   */
  manualPreference?: number | null;
  path: string;
  /** Optional zero-to-five star rating. */
  rating?: number | null;
  thumbnailPath?: string | null;
  width: number | null;
}

export interface SequenceRepresentativeImageMetrics {
  exposure: number;
  information: number;
  sharpness: number;
}

export interface SequenceRepresentativeScore {
  id: number;
  metrics: SequenceRepresentativeImageMetrics | null;
  reasonKeys: SequenceRepresentativeReasonKey[];
  score: number;
}

export interface SequenceRepresentativeRecommendation {
  candidates: SequenceRepresentativeScore[];
  reasonKeys: SequenceRepresentativeReasonKey[];
  recommendedPhotoId: number;
}

export interface SequenceRepresentativeOptions {
  analysisSize?: number;
  analyzeCandidate?: (
    candidate: SequenceRepresentativeCandidate
  ) => Promise<SequenceRepresentativeImageMetrics>;
  concurrency?: number;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizedResolution(
  candidate: SequenceRepresentativeCandidate
): number {
  const area =
    Math.max(0, finiteOrZero(candidate.width)) *
    Math.max(0, finiteOrZero(candidate.height));
  return area > 0 ? clamp(Math.log1p(area) / Math.log1p(24_000_000)) : 0;
}

/**
 * Computes lightweight visual metrics from an 8-bit grayscale image.
 * Exported to keep the quality heuristic independently testable.
 */
export function analyzeSequenceLuma(
  pixels: Uint8Array,
  width: number,
  height: number
): SequenceRepresentativeImageMetrics {
  if (width < 1 || height < 1 || pixels.length < width * height) {
    throw new Error("Invalid grayscale image");
  }

  const histogram = new Uint32Array(256);
  let effectiveExposurePixels = 0;
  for (let index = 0; index < width * height; index += 1) {
    const value = pixels[index];
    histogram[value] += 1;
    if (value >= 10 && value <= 245) {
      effectiveExposurePixels += 1;
    }
  }

  const pixelCount = width * height;
  let entropy = 0;
  for (const count of histogram) {
    if (count === 0) {
      continue;
    }
    const probability = count / pixelCount;
    entropy -= probability * Math.log2(probability);
  }

  let laplacianSum = 0;
  let laplacianSquareSum = 0;
  let laplacianCount = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const index = y * width + x;
      const laplacian =
        pixels[index - width] +
        pixels[index + width] +
        pixels[index - 1] +
        pixels[index + 1] -
        4 * pixels[index];
      laplacianSum += laplacian;
      laplacianSquareSum += laplacian * laplacian;
      laplacianCount += 1;
    }
  }
  const laplacianMean = laplacianCount > 0 ? laplacianSum / laplacianCount : 0;
  const laplacianVariance =
    laplacianCount > 0
      ? laplacianSquareSum / laplacianCount - laplacianMean * laplacianMean
      : 0;

  return {
    exposure: effectiveExposurePixels / pixelCount,
    information: clamp(entropy / 8),
    sharpness: clamp(1 - Math.exp(-Math.max(0, laplacianVariance) / 400)),
  };
}

async function analyzeWithSharp(
  candidate: SequenceRepresentativeCandidate,
  analysisSize: number
): Promise<SequenceRepresentativeImageMetrics> {
  const input = candidate.thumbnailPath?.trim() || candidate.path;
  const { data, info } = await sharp(input, { failOn: "none" })
    .rotate()
    .resize(analysisSize, analysisSize, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return analyzeSequenceLuma(data, info.width, info.height);
}

function buildReasonKeys(
  candidate: SequenceRepresentativeCandidate,
  metrics: SequenceRepresentativeImageMetrics,
  resolution: number
): SequenceRepresentativeReasonKey[] {
  const reasonKeys: SequenceRepresentativeReasonKey[] = [];
  if (metrics.sharpness >= 0.55) {
    reasonKeys.push("sequence.representative.reason.sharp");
  }
  if (metrics.information >= 0.5) {
    reasonKeys.push("sequence.representative.reason.richDetail");
  }
  if (metrics.exposure >= 0.85) {
    reasonKeys.push("sequence.representative.reason.balancedExposure");
  }
  if (resolution >= 0.8) {
    reasonKeys.push("sequence.representative.reason.highResolution");
  }
  if (candidate.isFavorite) {
    reasonKeys.push("sequence.representative.reason.favorite");
  }
  if (clamp(finiteOrZero(candidate.rating) / 5) >= 0.8) {
    reasonKeys.push("sequence.representative.reason.highRating");
  }
  if (clamp(finiteOrZero(candidate.manualPreference)) > 0) {
    reasonKeys.push("sequence.representative.reason.manualPreference");
  }
  return reasonKeys;
}

function scoreCandidate(
  candidate: SequenceRepresentativeCandidate,
  metrics: SequenceRepresentativeImageMetrics
): SequenceRepresentativeScore {
  const resolution = normalizedResolution(candidate);
  const favorite = candidate.isFavorite ? 1 : 0;
  const rating = clamp(finiteOrZero(candidate.rating) / 5);
  const manualPreference = clamp(finiteOrZero(candidate.manualPreference));
  const score =
    metrics.sharpness * 0.34 +
    metrics.information * 0.18 +
    metrics.exposure * 0.18 +
    resolution * 0.08 +
    favorite * 0.12 +
    rating * 0.05 +
    manualPreference * 0.05;

  return {
    id: candidate.id,
    metrics,
    reasonKeys: buildReasonKeys(candidate, metrics, resolution),
    score: Math.round(score * 1_000_000) / 1_000_000,
  };
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(values.length, Math.max(1, concurrency));
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Recommends a representative without mutating the sequence or its photos.
 * Input order is the stable tie-breaker and the fallback when no image can be
 * decoded, making repeated runs deterministic.
 */
export async function recommendSequenceRepresentative(
  candidates: SequenceRepresentativeCandidate[],
  options: SequenceRepresentativeOptions = {}
): Promise<SequenceRepresentativeRecommendation | null> {
  if (candidates.length === 0) {
    return null;
  }

  const analysisSize = Math.max(
    32,
    Math.floor(options.analysisSize ?? DEFAULT_ANALYSIS_SIZE)
  );
  const analyzeCandidate =
    options.analyzeCandidate ??
    ((candidate) => analyzeWithSharp(candidate, analysisSize));
  const concurrency = Math.max(
    1,
    Math.floor(options.concurrency ?? DEFAULT_ANALYSIS_CONCURRENCY)
  );

  const scores = await mapWithConcurrency(
    candidates,
    concurrency,
    async (candidate) => {
      try {
        return scoreCandidate(candidate, await analyzeCandidate(candidate));
      } catch {
        return {
          id: candidate.id,
          metrics: null,
          reasonKeys: [
            "sequence.representative.reason.analysisFailed" as const,
          ],
          score: 0,
        };
      }
    }
  );

  const successfulScores = scores.filter((entry) => entry.metrics !== null);
  if (successfulScores.length === 0) {
    const fallback = scores[0];
    fallback.reasonKeys.push("sequence.representative.reason.stableFallback");
    return {
      candidates: scores,
      reasonKeys: ["sequence.representative.reason.stableFallback"],
      recommendedPhotoId: candidates[0].id,
    };
  }

  let best = successfulScores[0];
  for (const score of successfulScores.slice(1)) {
    if (score.score > best.score) {
      best = score;
    }
  }
  return {
    candidates: scores,
    reasonKeys:
      best.reasonKeys.length > 0
        ? [...best.reasonKeys]
        : ["sequence.representative.reason.stableFallback"],
    recommendedPhotoId: best.id,
  };
}
