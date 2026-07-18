export interface ApertureStatInput {
  aperture: number;
  count: number;
}

export interface FocalStatInput {
  count: number;
  focalLength: string;
}

export type DashboardRangePreset = "all" | "year" | "last12" | "custom";

export interface DashboardTimeRange {
  from?: number;
  toExclusive?: number;
}

export interface DashboardChartPoint {
  count: number;
  name: string;
  [key: string]: unknown;
}

export type ShootingGuidanceKind =
  | "wideAngle"
  | "standardFocal"
  | "telephoto"
  | "wideAperture"
  | "deepFocus"
  | "highIso"
  | "lowMetadataCoverage";

export interface ShootingGuidance {
  kind: ShootingGuidanceKind;
  value: number;
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

export function getDashboardTimeRange(
  preset: DashboardRangePreset,
  now = new Date(),
  customFrom?: string,
  customTo?: string
): DashboardTimeRange {
  if (preset === "all") {
    return {};
  }

  if (preset === "custom") {
    const from = customFrom
      ? new Date(`${customFrom}T00:00:00`).getTime()
      : Number.NaN;
    const to = customTo ? new Date(`${customTo}T00:00:00`) : null;
    if (to) {
      to.setDate(to.getDate() + 1);
    }
    return {
      from: Number.isFinite(from) ? from : undefined,
      toExclusive:
        to && Number.isFinite(to.getTime()) ? to.getTime() : undefined,
    };
  }

  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from =
    preset === "year"
      ? new Date(now.getFullYear(), 0, 1)
      : new Date(now.getFullYear(), now.getMonth() - 11, 1);
  return { from: from.getTime(), toExclusive: to.getTime() };
}

export function fillYearlyChartData(
  stats: { count: number; year: string }[],
  range?: DashboardTimeRange
) {
  if (stats.length === 0) {
    return [];
  }
  const counts = new Map(stats.map((item) => [Number(item.year), item.count]));
  const dataYears = [...counts.keys()].filter(Number.isFinite);
  const first = range?.from
    ? new Date(range.from).getFullYear()
    : Math.min(...dataYears);
  const last = range?.toExclusive
    ? new Date(range.toExclusive - 1).getFullYear()
    : Math.max(...dataYears);
  return Array.from({ length: Math.max(0, last - first + 1) }, (_, index) => {
    const year = first + index;
    return { name: String(year), count: counts.get(year) ?? 0, year };
  });
}

export function buildMonthlyChartData(
  stats: { count: number; month: string }[],
  locale: string
): DashboardChartPoint[] {
  const formatter = new Intl.DateTimeFormat(locale, { month: "short" });
  const counts = new Map(stats.map((item) => [Number(item.month), item.count]));
  return Array.from({ length: 12 }, (_, index) => ({
    name: formatter.format(new Date(2000, index, 1)),
    count: counts.get(index + 1) ?? 0,
    month: index + 1,
  }));
}

function formatLocalDate(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildYearDrillParams(
  year: number,
  range: DashboardTimeRange
): Record<string, string> {
  const yearFrom = new Date(year, 0, 1).getTime();
  const yearToExclusive = new Date(year + 1, 0, 1).getTime();
  const from = Math.max(yearFrom, range.from ?? yearFrom);
  const toExclusive = Math.min(
    yearToExclusive,
    range.toExclusive ?? yearToExclusive
  );
  if (from >= toExclusive) {
    return {};
  }
  return {
    dateFrom: formatLocalDate(from),
    dateTo: formatLocalDate(toExclusive - 1),
  };
}

export function calculateCoverage(covered: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.round((Math.max(0, covered) / total) * 100);
}

export function buildShootingGuidance(input: {
  advancedExif: number;
  apertureStats: ApertureStatInput[];
  avgIso: number;
  focalStats: FocalStatInput[];
  totalPhotos: number;
}): ShootingGuidance[] {
  const guidance: ShootingGuidance[] = [];
  const topFocal = [...input.focalStats]
    .filter((item) => Number.isFinite(Number(item.focalLength)))
    .sort((a, b) => b.count - a.count)[0];
  if (topFocal) {
    const focal = Number(topFocal.focalLength);
    let kind: ShootingGuidanceKind = "standardFocal";
    if (focal <= 35) {
      kind = "wideAngle";
    } else if (focal >= 85) {
      kind = "telephoto";
    }
    guidance.push({ kind, value: focal });
  }

  const topAperture = [...input.apertureStats].sort(
    (a, b) => b.count - a.count
  )[0];
  if (topAperture?.aperture && topAperture.aperture <= 2.8) {
    guidance.push({ kind: "wideAperture", value: topAperture.aperture });
  } else if (topAperture?.aperture && topAperture.aperture >= 8) {
    guidance.push({ kind: "deepFocus", value: topAperture.aperture });
  }

  if (input.avgIso >= 1600) {
    guidance.push({ kind: "highIso", value: Math.round(input.avgIso) });
  }

  const advancedCoverage = calculateCoverage(
    input.advancedExif,
    input.totalPhotos
  );
  if (input.totalPhotos > 0 && advancedCoverage < 50) {
    guidance.push({
      kind: "lowMetadataCoverage",
      value: advancedCoverage,
    });
  }
  return guidance.slice(0, 4);
}

export function getTopItems<T extends { count: number }>(
  items: T[],
  limit = 8
) {
  return [...items].sort((a, b) => b.count - a.count).slice(0, limit);
}

export function mergeDashboardDrillParams(
  params: Record<string, string>,
  range: DashboardTimeRange
): Record<string, string> {
  const result = { ...params };
  if (range.from !== undefined && result.dateFrom === undefined) {
    result.dateFrom = formatLocalDate(range.from);
  }
  if (range.toExclusive !== undefined && result.dateTo === undefined) {
    result.dateTo = formatLocalDate(range.toExclusive - 1);
  }
  return result;
}
