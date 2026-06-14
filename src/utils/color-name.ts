// HSL type
interface HSL {
  h: number;
  l: number;
  s: number;
}

// Hue → [zhName, enName] mapping table (sorted by hue midpoint)
const HUE_MAP: [number, string, string][] = [
  [0, "红色", "Red"],
  [15, "橙红色", "Orange-Red"],
  [30, "橙色", "Orange"],
  [45, "橙黄色", "Yellow-Orange"],
  [60, "黄色", "Yellow"],
  [90, "黄绿色", "Yellow-Green"],
  [120, "绿色", "Green"],
  [150, "青绿色", "Spring-Green"],
  [180, "青色", "Cyan"],
  [210, "蓝青色", "Blue-Cyan"],
  [240, "蓝色", "Blue"],
  [270, "蓝紫色", "Blue-Purple"],
  [300, "紫色", "Purple"],
  [330, "品红色", "Magenta"],
];

// Saturation descriptors
function describeSaturation(s: number, lang: "zh" | "en"): string {
  if (lang === "zh") {
    if (s < 20) {
      return "灰淡的";
    }
    if (s < 50) {
      return "柔和的";
    }
    if (s < 80) {
      return "鲜艳的";
    }
    return "浓烈的";
  }
  if (s < 20) {
    return "muted grayish";
  }
  if (s < 50) {
    return "soft";
  }
  if (s < 80) {
    return "vivid";
  }
  return "intense";
}

// Lightness descriptors
function describeLightness(l: number, lang: "zh" | "en"): string {
  if (lang === "zh") {
    if (l < 20) {
      return "深暗的";
    }
    if (l < 45) {
      return "暗色调";
    }
    if (l < 65) {
      return "";
    }
    if (l < 85) {
      return "明亮的";
    }
    return "非常明亮的";
  }
  if (l < 20) {
    return "very dark";
  }
  if (l < 45) {
    return "dark";
  }
  if (l < 65) {
    return "";
  }
  if (l < 85) {
    return "bright";
  }
  return "very bright";
}

// hex → HSL (internal, not exported)
function hexToHsl(hex: string): HSL {
  const cleaned = hex.replace("#", "");

  let r: number;
  let g: number;
  let b: number;

  if (cleaned.length === 3) {
    r = Number.parseInt(cleaned[0] + cleaned[0], 16);
    g = Number.parseInt(cleaned[1] + cleaned[1], 16);
    b = Number.parseInt(cleaned[2] + cleaned[2], 16);
  } else if (cleaned.length === 6) {
    r = Number.parseInt(cleaned.slice(0, 2), 16);
    g = Number.parseInt(cleaned.slice(2, 4), 16);
    b = Number.parseInt(cleaned.slice(4, 6), 16);
  } else {
    return { h: 0, s: 0, l: 0 };
  }

  const rNorm = r / 255;
  const gNorm = g / 255;
  const bNorm = b / 255;

  const max = Math.max(rNorm, gNorm, bNorm);
  const min = Math.min(rNorm, gNorm, bNorm);
  const delta = max - min;

  let h = 0;
  let s = 0;
  const l = (max + min) / 2;

  if (delta !== 0) {
    s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);

    if (max === rNorm) {
      h = ((gNorm - bNorm) / delta + (gNorm < bNorm ? 6 : 0)) * 60;
    } else if (max === gNorm) {
      h = ((bNorm - rNorm) / delta + 2) * 60;
    } else {
      h = ((rNorm - gNorm) / delta + 4) * 60;
    }
  }

  return { h: Math.round(h), s: Math.round(s * 100), l: Math.round(l * 100) };
}

// Find the closest hue name
function findHueName(h: number): [string, string] {
  // Wrap around at 360
  const normalized = ((h % 360) + 360) % 360;
  let best = HUE_MAP[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const entry of HUE_MAP) {
    let dist = Math.abs(normalized - entry[0]);
    // Handle wrap-around near 0/360
    if (dist > 180) {
      dist = 360 - dist;
    }
    if (dist < bestDist) {
      bestDist = dist;
      best = entry;
    }
  }
  return [best[1], best[2]];
}

// hex → CLIP-friendly search prompt (for AI fallback)
export function hexToSearchPrompt(hex: string): string {
  const hsl = hexToHsl(hex);
  const [zhHue, enHue] = findHueName(hsl.h);
  const satDesc = describeSaturation(hsl.s, "en");
  const lightDesc = describeLightness(hsl.l, "en");

  const parts = ["a photo with dominant"];
  if (satDesc) {
    parts.push(satDesc);
  }
  if (lightDesc) {
    parts.push(lightDesc);
  }
  parts.push(enHue.toLowerCase());
  parts.push("colors");
  return parts.filter(Boolean).join(" ");
}

// hex → human-readable color name
export function hexToColorName(hex: string, lang: "zh" | "en" = "zh"): string {
  const hsl = hexToHsl(hex);
  const [zhHue, enHue] = findHueName(hsl.h);

  if (lang === "zh") {
    return zhHue;
  }
  return enHue;
}

// Validate and normalize hex string
// "#F53" → "FF5533", "FF5733" → "FF5733", "xyz" → null
export function normalizeHex(input: string): string | null {
  const cleaned = input.replace(/^#/, "").trim().toUpperCase();
  if (!/^[0-9A-F]{3}$|^[0-9A-F]{6}$/.test(cleaned)) {
    return null;
  }
  if (cleaned.length === 3) {
    return (
      cleaned[0] +
      cleaned[0] +
      cleaned[1] +
      cleaned[1] +
      cleaned[2] +
      cleaned[2]
    );
  }
  return cleaned;
}
