// ── Color palette extraction service ──────────────────────────────────
// 3D RGB histogram binning → per-photo top-5 dominant colors → global aggregation
// into palette swatches, hue distribution, and saturation levels.

import fs from "node:fs";
import sharp from "sharp";

const SAMPLE_SIZE = 32; // resize thumbnail to 32×32 (1024 pixels)
const BINS = 16; // 4 bits per channel → 16×16×16 = 4096 histogram bins
const TOP_PER_PHOTO = 5;
const TOP_GLOBAL = 25;

const HUE_LABELS = [
  "红", "橙", "黄", "黄绿", "绿", "青绿",
  "青", "蓝", "紫蓝", "紫", "紫红", "粉",
] as const;

// ── RGB ↔ HSL ────────────────────────────────────────────────────────

function rgbToHsl(r: number, g: number, b: number) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta > 0) {
    if (max === rn) h = ((gn - bn) / delta + 6) % 6;
    else if (max === gn) h = (bn - rn) / delta + 2;
    else h = (rn - gn) / delta + 4;
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h: Math.round(h * 60), s, l };
}

export function hexFromHue(hueDeg: number): string {
  const sn = 0.7;
  const ln = 0.5;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hueDeg / 60) % 2) - 1));
  const m = ln - c / 2;
  let rn = 0, gn = 0, bn = 0;
  if (hueDeg < 60) { rn = c; gn = x; }
  else if (hueDeg < 120) { rn = x; gn = c; }
  else if (hueDeg < 180) { gn = c; bn = x; }
  else if (hueDeg < 240) { gn = x; bn = c; }
  else if (hueDeg < 300) { rn = x; bn = c; }
  else { rn = c; bn = x; }
  const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(rn)}${toHex(gn)}${toHex(bn)}`;
}

// ── Pixel filtering ───────────────────────────────────────────────────

function isNearBlack(r: number, g: number, b: number) {
  return Math.max(r, g, b) < 30;
}
function isNearWhite(r: number, g: number, b: number) {
  return Math.min(r, g, b) > 230;
}
function isNearGray(r: number, g: number, b: number) {
  return Math.max(r, g, b) - Math.min(r, g, b) < 15;
}
function isValidPixel(r: number, g: number, b: number) {
  return !isNearBlack(r, g, b) && !isNearWhite(r, g, b) && !isNearGray(r, g, b);
}

// ── Histogram binning ─────────────────────────────────────────────────

function binIndex(r: number, g: number, b: number) {
  return (r >> 4) * BINS * BINS + (g >> 4) * BINS + (b >> 4);
}

function binToRgb(idx: number): [number, number, number] {
  const bBin = idx % BINS;
  const gBin = Math.floor(idx / BINS) % BINS;
  const rBin = Math.floor(idx / (BINS * BINS));
  return [rBin * 16 + 8, gBin * 16 + 8, bBin * 16 + 8];
}

// ── Types ─────────────────────────────────────────────────────────────

export interface PaletteColor {
  hex: string;
  r: number;
  g: number;
  b: number;
  hue: number;
  saturation: number;
  lightness: number;
  weight: number;
}

interface PerPhotoPalette {
  colors: PaletteColor[];
  histogram: Uint32Array;
  validPixels: number;
}

interface GlobalPaletteColor {
  hex: string;
  r: number;
  g: number;
  b: number;
  hue: number;
  saturation: number;
  lightness: number;
  weight: number;
}

interface HueBucket {
  label: string;
  hueRange: [number, number];
  count: number;
  hex: string;
}

interface SaturationBucket {
  level: "vivid" | "moderate" | "muted";
  label: string;
  count: number;
}

export interface ColorDistributionResult {
  globalPalette: GlobalPaletteColor[];
  hueDistribution: HueBucket[];
  saturationDistribution: SaturationBucket[];
  sampled: number;
  totalPhotos: number;
}

// ── Per-photo palette extraction ──────────────────────────────────────

async function extractPerPhotoPalette(imagePath: string): Promise<PerPhotoPalette | null> {
  const { data, info } = await sharp(imagePath)
    .resize(SAMPLE_SIZE, SAMPLE_SIZE, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const channels = info.channels;
  const histogram = new Uint32Array(BINS * BINS * BINS);
  let validPixels = 0;

  for (let i = 0; i < data.length; i += channels) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (!isValidPixel(r, g, b)) continue;
    const idx = binIndex(r, g, b);
    histogram[idx]++;
    validPixels++;
  }

  if (validPixels < 10) return null;

  // Sort bins by count descending, take top N
  const bins: { idx: number; count: number }[] = [];
  for (let i = 0; i < histogram.length; i++) {
    if (histogram[i] > 0) bins.push({ idx: i, count: histogram[i] });
  }
  bins.sort((a, b) => b.count - a.count);
  const top = bins.slice(0, TOP_PER_PHOTO);

  // Merge near-identical colors (Euclidean distance < 40 in RGB)
  interface MergedBin { idx: number; count: number; r: number; g: number; b: number }
  const merged: MergedBin[] = [];
  for (const bin of top) {
    const [br, bg, bb] = binToRgb(bin.idx);
    let found = false;
    for (const m of merged) {
      const dr = m.r - br, dg = m.g - bg, db = m.b - bb;
      if (dr * dr + dg * dg + db * db < 1600) {
        m.count += bin.count;
        found = true;
        break;
      }
    }
    if (!found) merged.push({ idx: bin.idx, count: bin.count, r: br, g: bg, b: bb });
  }

  const colors: PaletteColor[] = merged.map((m) => {
    const { h, s, l } = rgbToHsl(m.r, m.g, m.b);
    return {
      hex: rgbToHex(m.r, m.g, m.b),
      r: m.r, g: m.g, b: m.b,
      hue: h, saturation: s, lightness: l,
      weight: m.count / validPixels,
    };
  });

  return { colors, histogram, validPixels };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

// ── Global aggregation ────────────────────────────────────────────────

function aggregateDistribution(
  palettes: PerPhotoPalette[],
  totalPhotos: number,
): ColorDistributionResult {
  // Merge all per-photo histograms into global
  const globalHist = new Uint32Array(BINS * BINS * BINS);
  for (const p of palettes) {
    for (let i = 0; i < globalHist.length; i++) {
      globalHist[i] += p.histogram[i];
    }
  }

  // Extract top global colors
  const globalBins: { idx: number; count: number }[] = [];
  for (let i = 0; i < globalHist.length; i++) {
    if (globalHist[i] > 0) globalBins.push({ idx: i, count: globalHist[i] });
  }
  globalBins.sort((a, b) => b.count - a.count);

  let totalValid = 0;
  const mergedBins: { idx: number; count: number; r: number; g: number; b: number }[] = [];
  for (const bin of globalBins) {
    totalValid += bin.count;
    const [br, bg, bb] = binToRgb(bin.idx);
    let found = false;
    for (const m of mergedBins) {
      const dr = m.r - br, dg = m.g - bg, db = m.b - bb;
      if (dr * dr + dg * dg + db * db < 1600) {
        m.count += bin.count;
        found = true;
        break;
      }
    }
    if (!found) mergedBins.push({ idx: bin.idx, count: bin.count, r: br, g: bg, b: bb });
  }
  const topGlobal = mergedBins.slice(0, TOP_GLOBAL);

  const globalPalette: GlobalPaletteColor[] = topGlobal.map((m) => {
    const { h, s, l } = rgbToHsl(m.r, m.g, m.b);
    return {
      hex: rgbToHex(m.r, m.g, m.b),
      r: m.r, g: m.g, b: m.b,
      hue: h, saturation: s, lightness: l,
      weight: totalValid > 0 ? m.count / totalValid : 0,
    };
  }).sort((a, b) => a.hue - b.hue);

  // Hue & saturation distribution — computed from FULL global histogram.
  // Bin centers on the gray diagonal (R≈G≈B) have hue=0 (red), so we skip
  // low-saturation bin centers for hue to avoid inflating the red bucket.
  const hueBuckets = new Array(12).fill(0);
  let vividCount = 0;
  let moderateCount = 0;
  let mutedCount = 0;

  for (let i = 0; i < globalHist.length; i++) {
    const count = globalHist[i];
    if (count === 0) continue;
    const [br, bg, bb] = binToRgb(i);
    const delta = Math.max(br, bg, bb) - Math.min(br, bg, bb);
    const { h, s } = rgbToHsl(br, bg, bb);

    // Only contribute to hue when bin center has meaningful chroma
    if (delta >= 20) {
      const bucket = Math.floor(h / 30) % 12;
      hueBuckets[bucket] += count;
    }

    if (s >= 0.6) vividCount += count;
    else if (s >= 0.25) moderateCount += count;
    else mutedCount += count;
  }

  const hueDistribution: HueBucket[] = hueBuckets.map((count, i) => ({
    label: HUE_LABELS[i],
    hueRange: [i * 30, (i + 1) * 30] as [number, number],
    count,
    hex: hexFromHue(i * 30 + 15),
  }));

  const saturationDistribution: SaturationBucket[] = [
    { level: "vivid", label: "高饱和", count: vividCount },
    { level: "moderate", label: "中等", count: moderateCount },
    { level: "muted", label: "低饱和", count: mutedCount },
  ];

  return {
    globalPalette,
    hueDistribution,
    saturationDistribution,
    sampled: palettes.length,
    totalPhotos,
  };
}

// ── Module-level cache ────────────────────────────────────────────────

interface ColorCacheEntry {
  result: ColorDistributionResult;
  totalPhotos: number;
  timestamp: number;
}

let colorCache: ColorCacheEntry | null = null;

export function invalidateColorCache(): void {
  colorCache = null;
}

// ── Public API ────────────────────────────────────────────────────────

export async function computeColorDistribution(
  samplePhotos: { path: string; thumbnailPath: string | null }[],
  totalPhotos: number,
): Promise<ColorDistributionResult> {
  // Return cached result if photo count hasn't changed significantly
  if (colorCache) {
    const delta = Math.abs(colorCache.totalPhotos - totalPhotos);
    if (delta / Math.max(totalPhotos, 1) < 0.05) {
      return colorCache.result;
    }
  }

  const palettes: PerPhotoPalette[] = [];
  let processed = 0;

  for (const p of samplePhotos) {
    try {
      const imgPath = p.thumbnailPath || p.path;
      if (!fs.existsSync(imgPath)) continue;
      const palette = await extractPerPhotoPalette(imgPath);
      if (palette) palettes.push(palette);
    } catch {
      /* skip bad files */
    }
    processed++;
    if (processed % 20 === 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
  }

  if (palettes.length < 10) {
    const emptyResult: ColorDistributionResult = {
      globalPalette: [],
      hueDistribution: [],
      saturationDistribution: [],
      sampled: palettes.length,
      totalPhotos,
    };
    colorCache = { result: emptyResult, totalPhotos, timestamp: Date.now() };
    return emptyResult;
  }

  const result = aggregateDistribution(palettes, totalPhotos);
  colorCache = { result, totalPhotos, timestamp: Date.now() };
  return result;
}
