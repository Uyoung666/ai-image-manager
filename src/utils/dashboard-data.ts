export interface ApertureStatInput {
  aperture: number;
  count: number;
}

export interface FocalStatInput {
  count: number;
  focalLength: string;
}

const STANDARD_APERTURES = [
  1, 1.1, 1.2, 1.4, 1.6, 1.8, 2, 2.2, 2.5, 2.8, 3.2, 3.5, 4, 4.5, 5, 5.6, 6.3,
  7.1, 8, 9, 10, 11, 13, 14, 16, 18, 20, 22, 25, 29, 32,
];
const TRAILING_DECIMAL_ZERO = /\.0$/;

function snapToStandardAperture(raw: number): number {
  const tolerance = raw * 0.06;
  let best = raw;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const standard of STANDARD_APERTURES) {
    const distance = Math.abs(standard - raw);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = standard;
    }
  }
  return bestDistance <= tolerance ? best : raw;
}

function formatDecimal(value: number): string {
  return value.toFixed(1).replace(TRAILING_DECIMAL_ZERO, "");
}

export function buildFocalChartData(stats: FocalStatInput[], limit = 12) {
  return stats
    .map((item) => ({
      ...item,
      numericValue: Number.parseFloat(item.focalLength),
    }))
    .filter(
      (item) => Number.isFinite(item.numericValue) && item.numericValue > 0
    )
    .sort((a, b) => b.count - a.count || a.numericValue - b.numericValue)
    .slice(0, limit)
    .sort((a, b) => a.numericValue - b.numericValue)
    .map((item) => ({
      name: `${formatDecimal(item.numericValue)}mm`,
      count: item.count,
      focalMin: Math.max(0, item.numericValue - 0.5),
      focalMax: item.numericValue + 0.499_999,
    }));
}

export function buildApertureChartData(stats: ApertureStatInput[], limit = 10) {
  const buckets = new Map<
    number,
    { count: number; rawMax: number; rawMin: number }
  >();

  for (const item of stats) {
    if (!(Number.isFinite(item.aperture) && item.aperture > 0)) {
      continue;
    }
    const snapped = snapToStandardAperture(item.aperture);
    const existing = buckets.get(snapped);
    if (existing) {
      existing.count += item.count;
      existing.rawMin = Math.min(existing.rawMin, item.aperture);
      existing.rawMax = Math.max(existing.rawMax, item.aperture);
    } else {
      buckets.set(snapped, {
        count: item.count,
        rawMin: item.aperture,
        rawMax: item.aperture,
      });
    }
  }

  return [...buckets.entries()]
    .map(([aperture, bucket]) => ({ aperture, ...bucket }))
    .sort((a, b) => b.count - a.count || a.aperture - b.aperture)
    .slice(0, limit)
    .sort((a, b) => a.aperture - b.aperture)
    .map((bucket) => ({
      name: `f/${formatDecimal(bucket.aperture)}`,
      count: bucket.count,
      apertureMin: Math.max(0, bucket.rawMin - 0.05).toFixed(3),
      apertureMax: (bucket.rawMax + 0.049_999).toFixed(3),
    }));
}

export function buildRangeSearchParams(
  prefix: "iso" | "shutter",
  min?: number,
  max?: number
): Record<string, string> {
  const params: Record<string, string> = {};
  if (min !== undefined) {
    params[`${prefix}Min`] = String(min);
  }
  if (max !== undefined) {
    params[`${prefix}Max`] = String(max);
  }
  return params;
}
