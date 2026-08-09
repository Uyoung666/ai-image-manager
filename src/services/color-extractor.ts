// ── Color palette extraction service ──────────────────────────────────
// 3D RGB histogram binning → per-photo top-5 dominant colors → global aggregation
// into palette swatches, hue distribution, and saturation levels.

import fs from "node:fs";
import sharp from "sharp";

const SAMPLE_SIZE = 128; // resize thumbnail to 128×128 (16384 pixels)
const BINS = 32; // 5 bits per channel → 32×32×32 = 32768 histogram bins
const BIN_SIZE = 256 / BINS; // pixel value range per bin (8 for BINS=32)
const SHIFT = Math.log2(BIN_SIZE); // right-shift to map 8-bit channel → bin index
const TOP_PER_PHOTO = 5;
const TOP_GLOBAL = 25;

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
    if (max === rn) {
      h = ((gn - bn) / delta + 6) % 6;
    } else if (max === gn) {
      h = (bn - rn) / delta + 2;
    } else {
      h = (rn - gn) / delta + 4;
    }
  }

  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  return { h: Math.round(h * 60), s, l };
}

export function hexFromHue(hueDeg: number): string {
  const { r, g, b } = rgbFromHue(hueDeg);
  const toHex = (v: number) => v.toString(16).padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/** Same HSL→RGB as hexFromHue but returns integer channel values (0–255). */
export function rgbFromHue(hueDeg: number): {
  r: number;
  g: number;
  b: number;
} {
  const sn = 0.7;
  const ln = 0.5;
  const c = (1 - Math.abs(2 * ln - 1)) * sn;
  const x = c * (1 - Math.abs(((hueDeg / 60) % 2) - 1));
  const m = ln - c / 2;
  let rn = 0,
    gn = 0,
    bn = 0;
  if (hueDeg < 60) {
    rn = c;
    gn = x;
  } else if (hueDeg < 120) {
    rn = x;
    gn = c;
  } else if (hueDeg < 180) {
    gn = c;
    bn = x;
  } else if (hueDeg < 240) {
    gn = x;
    bn = c;
  } else if (hueDeg < 300) {
    rn = x;
    bn = c;
  } else {
    rn = c;
    bn = x;
  }
  return {
    r: Math.round((rn + m) * 255),
    g: Math.round((gn + m) * 255),
    b: Math.round((bn + m) * 255),
  };
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
  return !(isNearBlack(r, g, b) || isNearWhite(r, g, b) || isNearGray(r, g, b));
}

// ── Histogram binning ─────────────────────────────────────────────────

function binIndex(r: number, g: number, b: number) {
  return (
    Math.floor(r / 2 ** SHIFT) * BINS * BINS +
    Math.floor(g / 2 ** SHIFT) * BINS +
    Math.floor(b / 2 ** SHIFT)
  );
}

function binToRgb(idx: number): [number, number, number] {
  const bBin = idx % BINS;
  const gBin = Math.floor(idx / BINS) % BINS;
  const rBin = Math.floor(idx / (BINS * BINS));
  const halfBin = BIN_SIZE / 2;
  return [
    rBin * BIN_SIZE + halfBin,
    gBin * BIN_SIZE + halfBin,
    bBin * BIN_SIZE + halfBin,
  ];
}

// ── Types ─────────────────────────────────────────────────────────────

export interface PaletteColor {
  b: number;
  g: number;
  hex: string;
  hue: number;
  lightness: number;
  r: number;
  saturation: number;
  weight: number;
}

export interface PerPhotoPalette {
  colors: PaletteColor[];
  histogram: Uint32Array;
  validPixels: number;
}

interface GlobalPaletteColor {
  b: number;
  g: number;
  hex: string;
  hue: number;
  lightness: number;
  r: number;
  saturation: number;
  weight: number;
}

interface HueBucket {
  count: number;
  hex: string;
  hueRange: [number, number];
}

interface SaturationBucket {
  count: number;
  level: "vivid" | "moderate" | "muted";
}

export interface ColorDistributionResult {
  globalPalette: GlobalPaletteColor[];
  hueDistribution: HueBucket[];
  sampled: number;
  saturationDistribution: SaturationBucket[];
  totalPhotos: number;
}

// ── Per-photo palette extraction ──────────────────────────────────────

export async function extractPerPhotoPalette(
  imageInput: string | Buffer
): Promise<PerPhotoPalette | null> {
  const { data, info } = await sharp(imageInput)
    .rotate()
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
    if (!isValidPixel(r, g, b)) {
      continue;
    }
    const idx = binIndex(r, g, b);
    histogram[idx]++;
    validPixels++;
  }

  if (validPixels < 10) {
    return null;
  }

  // Sort bins by chroma-weighted score (count × (1 + saturation)).
  // This prevents large areas of near-gray (sky, concrete) from dominating
  // the palette and lets vivid subject colors rise to the top.
  const bins: { idx: number; count: number; score: number }[] = [];
  for (let i = 0; i < histogram.length; i++) {
    if (histogram[i] > 0) {
      const [br, bg, bb] = binToRgb(i);
      const { s } = rgbToHsl(br, bg, bb);
      bins.push({ idx: i, count: histogram[i], score: histogram[i] * (1 + s) });
    }
  }
  bins.sort((a, b) => b.score - a.score);
  const top = bins.slice(0, TOP_PER_PHOTO);

  // Merge near-identical colors (Euclidean distance < 40 in RGB)
  interface MergedBin {
    b: number;
    count: number;
    g: number;
    idx: number;
    r: number;
  }
  const merged: MergedBin[] = [];
  for (const bin of top) {
    const [br, bg, bb] = binToRgb(bin.idx);
    let found = false;
    for (const m of merged) {
      const dr = m.r - br,
        dg = m.g - bg,
        db = m.b - bb;
      if (dr * dr + dg * dg + db * db < 1600) {
        m.count += bin.count;
        found = true;
        break;
      }
    }
    if (!found) {
      merged.push({ idx: bin.idx, count: bin.count, r: br, g: bg, b: bb });
    }
  }

  const colors: PaletteColor[] = merged.map((m) => {
    const { h, s, l } = rgbToHsl(m.r, m.g, m.b);
    return {
      hex: rgbToHex(m.r, m.g, m.b),
      r: m.r,
      g: m.g,
      b: m.b,
      hue: h,
      saturation: s,
      lightness: l,
      weight: m.count / validPixels,
    };
  });

  return { colors, histogram, validPixels };
}

export async function extractDominantColors(
  imageInput: string | Buffer
): Promise<string | null> {
  const palette = await extractPerPhotoPalette(imageInput);
  if (!palette?.colors || palette.colors.length === 0) {
    return null;
  }
  return JSON.stringify(palette.colors);
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b]
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

// ── Global aggregation ────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Palette aggregation keeps histogram, hue, and saturation calculations consistent in one pass.
function aggregateDistribution(
  palettes: PerPhotoPalette[],
  totalPhotos: number
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
    if (globalHist[i] > 0) {
      globalBins.push({ idx: i, count: globalHist[i] });
    }
  }
  globalBins.sort((a, b) => b.count - a.count);

  let totalValid = 0;
  const mergedBins: {
    idx: number;
    count: number;
    r: number;
    g: number;
    b: number;
  }[] = [];
  for (const bin of globalBins) {
    totalValid += bin.count;
    const [br, bg, bb] = binToRgb(bin.idx);
    let found = false;
    for (const m of mergedBins) {
      const dr = m.r - br,
        dg = m.g - bg,
        db = m.b - bb;
      if (dr * dr + dg * dg + db * db < 1600) {
        m.count += bin.count;
        found = true;
        break;
      }
    }
    if (!found) {
      mergedBins.push({ idx: bin.idx, count: bin.count, r: br, g: bg, b: bb });
    }
  }
  const topGlobal = mergedBins.slice(0, TOP_GLOBAL);

  const globalPalette: GlobalPaletteColor[] = topGlobal
    .map((m) => {
      const { h, s, l } = rgbToHsl(m.r, m.g, m.b);
      return {
        hex: rgbToHex(m.r, m.g, m.b),
        r: m.r,
        g: m.g,
        b: m.b,
        hue: h,
        saturation: s,
        lightness: l,
        weight: totalValid > 0 ? m.count / totalValid : 0,
      };
    })
    .sort((a, b) => a.hue - b.hue);

  // Hue & saturation distribution.
  // Hue buckets use the same RGB distance matching as search
  // (closest_color_dist < 10000), ensuring dashboard counts
  // match drill-down search results exactly.
  const hueBuckets = new Array(12).fill(0);
  const MAX_DIST = 10_000;
  let vividCount = 0;
  let moderateCount = 0;
  let mutedCount = 0;

  for (const p of palettes) {
    for (let b = 0; b < 12; b++) {
      const target = rgbFromHue(b * 30 + 15);
      let minDist = Number.POSITIVE_INFINITY;
      for (const c of p.colors) {
        const dr = c.r - target.r;
        const dg = c.g - target.g;
        const db = c.b - target.b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < minDist) {
          minDist = dist;
        }
      }
      if (minDist < MAX_DIST) {
        hueBuckets[b]++;
      }
    }

    let hasVivid = false,
      hasModerate = false,
      hasMuted = false;
    for (const c of p.colors) {
      if (c.saturation >= 0.6) {
        hasVivid = true;
      } else if (c.saturation >= 0.25) {
        hasModerate = true;
      } else {
        hasMuted = true;
      }
    }
    if (hasVivid) {
      vividCount++;
    }
    if (hasModerate) {
      moderateCount++;
    }
    if (hasMuted) {
      mutedCount++;
    }
  }

  const hueDistribution: HueBucket[] = hueBuckets.map((count, i) => ({
    hueRange: [i * 30, (i + 1) * 30] as [number, number],
    count,
    hex: hexFromHue(i * 30 + 15),
  }));

  const saturationDistribution: SaturationBucket[] = [
    { level: "vivid", count: vividCount },
    { level: "moderate", count: moderateCount },
    { level: "muted", count: mutedCount },
  ];

  return {
    globalPalette,
    hueDistribution,
    saturationDistribution,
    sampled: palettes.length,
    totalPhotos,
  };
}

// ── Aggregation from stored dominant_colors ────────────────────────────

/**
 * 从已存储的 dominant_colors JSON 数据中聚合全局色彩分布。
 * 与 aggregateDistribution 不同，此函数不依赖 histogram。
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Stored-color aggregation preserves the same matching and weighting semantics as histogram aggregation.
export function aggregateFromStoredColors(allColors: PaletteColor[][]): {
  palette: PaletteColor[];
  hueDistribution: Array<{
    hueRange: [number, number];
    count: number;
    hex: string;
  }>;
  saturationCounts: { vivid: number; moderate: number; muted: number };
  totalPhotos: number;
} {
  // 收集所有颜色，带 weight
  const weightedColors: PaletteColor[] = [];
  for (const photoColors of allColors) {
    for (const c of photoColors) {
      weightedColors.push(c);
    }
  }

  // 统计每种颜色出现在多少张不同照片中（按 hex 去重），
  // 按全局照片级频率排序而非单张照片内的像素占比，避免
  // 人像等常见题材共享的米色/奶油色变体占据全部调色板位置。
  const freqMap = new Map<string, number>();
  for (const c of weightedColors) {
    freqMap.set(c.hex, (freqMap.get(c.hex) || 0) + 1);
  }
  const uniqueColors = new Map<string, PaletteColor & { globalFreq: number }>();
  for (const c of weightedColors) {
    if (!uniqueColors.has(c.hex)) {
      uniqueColors.set(c.hex, {
        ...c,
        globalFreq: freqMap.get(c.hex) || 0,
      });
    }
  }
  const sorted = Array.from(uniqueColors.values()).sort(
    (a, b) => b.globalFreq - a.globalFreq
  );

  // 全局调色板：按全局频率排序，取 top-25，合并近色（欧几里得距离 < 25）
  const palette: PaletteColor[] = [];
  const totalPhotos = allColors.length;
  for (const c of sorted) {
    const isNear = palette.some((p) => {
      const dr = p.r - c.r,
        dg = p.g - c.g,
        db = p.b - c.b;
      return dr * dr + dg * dg + db * db < 625; // 25^2
    });
    if (!isNear) {
      palette.push({
        ...c,
        weight: totalPhotos > 0 ? c.globalFreq / totalPhotos : 0,
      });
    }
    if (palette.length >= 25) {
      break;
    }
  }

  // 归一化权重使总和为 100%，让调色板显示正确的比例分布
  const totalWeight = palette.reduce((sum, c) => sum + c.weight, 0);
  if (totalWeight > 0) {
    for (const c of palette) {
      c.weight /= totalWeight;
    }
  }

  // 色相分布：使用与搜索完全相同的 RGB 距离匹配逻辑。
  // 对每个桶的中心色相生成代表色，计算每张照片 dominant_colors
  // 到该色的最小平方欧氏距离，阈值 10000（= SQL closest_color_dist 阈值）。
  const HUE_BUCKETS = 12;
  const MAX_DIST = 10_000;
  const hueCounts = new Array(HUE_BUCKETS).fill(0);

  for (const palette of allColors) {
    for (let b = 0; b < HUE_BUCKETS; b++) {
      const target = rgbFromHue(b * 30 + 15);
      let minDist = Number.POSITIVE_INFINITY;
      for (const c of palette) {
        const dr = c.r - target.r;
        const dg = c.g - target.g;
        const db = c.b - target.b;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < minDist) {
          minDist = dist;
        }
      }
      if (minDist < MAX_DIST) {
        hueCounts[b]++;
      }
    }
  }

  // 饱和度分布：按唯一照片计数
  let vivid = 0,
    moderate = 0,
    muted = 0;
  for (const palette of allColors) {
    let hasVivid = false,
      hasModerate = false,
      hasMuted = false;
    for (const c of palette) {
      if (c.saturation >= 0.6) {
        hasVivid = true;
      } else if (c.saturation >= 0.25) {
        hasModerate = true;
      } else {
        hasMuted = true;
      }
    }
    if (hasVivid) {
      vivid++;
    }
    if (hasModerate) {
      moderate++;
    }
    if (hasMuted) {
      muted++;
    }
  }

  return {
    palette: palette.slice(0, 25),
    hueDistribution: hueCounts.map((count, i) => ({
      hueRange: [i * 30, (i + 1) * 30] as [number, number],
      count,
      hex: hexFromHue(i * 30 + 15),
    })),
    saturationCounts: { vivid, moderate, muted },
    totalPhotos: allColors.length,
  };
}

// ── Module-level cache ────────────────────────────────────────────────

interface ColorCacheEntry {
  result: ColorDistributionResult;
  timestamp: number;
  totalPhotos: number;
}

let colorCache: ColorCacheEntry | null = null;

export function invalidateColorCache(): void {
  colorCache = null;
}

// ── Public API ────────────────────────────────────────────────────────

const COLOR_CACHE_TTL = 60 * 60 * 1000; // 1 hour

export async function computeColorDistribution(
  samplePhotos: { path: string; thumbnailPath: string | null }[],
  totalPhotos: number
): Promise<ColorDistributionResult> {
  // Return cached result if photo count hasn't changed significantly
  if (colorCache) {
    const age = Date.now() - colorCache.timestamp;
    const delta = Math.abs(colorCache.totalPhotos - totalPhotos);
    if (age < COLOR_CACHE_TTL && delta / Math.max(totalPhotos, 1) < 0.05) {
      return colorCache.result;
    }
  }

  const palettes: PerPhotoPalette[] = [];
  let processed = 0;
  let failed = 0;

  for (const p of samplePhotos) {
    try {
      const imgPath = p.thumbnailPath || p.path;
      if (fs.existsSync(imgPath)) {
        const palette = await extractPerPhotoPalette(imgPath);
        if (palette) {
          palettes.push(palette);
        } else {
          failed++;
        }
      } else {
        failed++;
      }
    } catch {
      failed++;
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
    if (failed === 0) {
      colorCache = { result: emptyResult, totalPhotos, timestamp: Date.now() };
    }
    return emptyResult;
  }

  const result = aggregateDistribution(palettes, totalPhotos);
  if (failed === 0) {
    colorCache = { result, totalPhotos, timestamp: Date.now() };
  }
  return result;
}
