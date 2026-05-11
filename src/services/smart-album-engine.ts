import { and, eq, gte, inArray, like, lte, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  albums,
  exifData,
  photoTags,
  photos,
  tags,
} from "@/db/schema";

// --- Rule type definitions ---

interface DateRangeRule {
  type: "dateRange";
  preset?: "去年今日" | "最近7天" | "最近30天" | "今年";
  dateFrom?: number;
  dateTo?: number;
}

interface CameraRule {
  type: "cameraModel";
  operator: "等于" | "包含";
  value: string;
}

interface LensRule {
  type: "lensModel";
  operator: "等于" | "包含";
  value: string;
}

interface TagsRule {
  type: "tags";
  operator: "包含任一" | "包含全部";
  value: string[];
}

interface FocalLengthRule {
  type: "focalLength";
  operator: ">=" | "<=" | "范围";
  value: number;
  max?: number;
}

interface ApertureRule {
  type: "aperture";
  operator: ">=" | "<=" | "范围";
  value: number;
  max?: number;
}

interface ISORule {
  type: "iso";
  operator: ">=" | "<=" | "范围";
  value: number;
  max?: number;
}

interface FileFormatRule {
  type: "fileFormat";
  value: string;
}

type SmartRule =
  | DateRangeRule
  | CameraRule
  | LensRule
  | TagsRule
  | FocalLengthRule
  | ApertureRule
  | ISORule
  | FileFormatRule;

interface SmartAlbumRules {
  rules: SmartRule[];
}

// --- Date preset resolution ---

function resolveDateRange(rule: DateRangeRule): { from: number; to: number } | null {
  const now = Date.now();
  const d = new Date();

  if (rule.preset === "去年今日") {
    const lastYear = new Date(d);
    lastYear.setFullYear(d.getFullYear() - 1);
    const start = new Date(lastYear);
    start.setHours(0, 0, 0, 0);
    const end = new Date(lastYear);
    end.setHours(23, 59, 59, 999);
    return { from: start.getTime(), to: end.getTime() };
  }
  if (rule.preset === "最近7天") {
    const from = now - 7 * 24 * 3600_000;
    return { from, to: now };
  }
  if (rule.preset === "最近30天") {
    const from = now - 30 * 24 * 3600_000;
    return { from, to: now };
  }
  if (rule.preset === "今年") {
    const start = new Date(d.getFullYear(), 0, 1).getTime();
    return { from: start, to: now };
  }
  if (rule.dateFrom !== undefined || rule.dateTo !== undefined) {
    return {
      from: rule.dateFrom ?? 0,
      to: rule.dateTo ?? now,
    };
  }
  return null;
}

// --- Rule evaluation (returns photo IDs) ---

function evaluateRule(rule: SmartRule): number[] {
  const db = getDatabase();

  switch (rule.type) {
    case "dateRange": {
      const range = resolveDateRange(rule);
      if (!range) return [];
      const rows = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(
          and(
            gte(exifData.dateTaken, range.from),
            lte(exifData.dateTaken, range.to)
          )
        )
        .all();
      return rows.map((r) => r.photoId).filter(Boolean) as number[];
    }

    case "cameraModel": {
      if (rule.operator === "等于") {
        const rows = db
          .select({ photoId: exifData.photoId })
          .from(exifData)
          .where(eq(exifData.cameraModel, rule.value))
          .all();
        return rows.map((r) => r.photoId).filter(Boolean) as number[];
      }
      const rows = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(like(exifData.cameraModel, `%${rule.value}%`))
        .all();
      return rows.map((r) => r.photoId).filter(Boolean) as number[];
    }

    case "lensModel": {
      if (rule.operator === "等于") {
        const rows = db
          .select({ photoId: exifData.photoId })
          .from(exifData)
          .where(eq(exifData.lensModel, rule.value))
          .all();
        return rows.map((r) => r.photoId).filter(Boolean) as number[];
      }
      const rows = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(like(exifData.lensModel, `%${rule.value}%`))
        .all();
      return rows.map((r) => r.photoId).filter(Boolean) as number[];
    }

    case "tags": {
      if (!rule.value.length) return [];
      const tagRows = db
        .select({ id: tags.id })
        .from(tags)
        .where(inArray(tags.name, rule.value))
        .all();
      const tagIds = tagRows.map((t) => t.id);
      if (!tagIds.length) return [];

      const photoRows = db
        .select({ photoId: photoTags.photoId })
        .from(photoTags)
        .where(inArray(photoTags.tagId, tagIds))
        .all();

      const photoIdCounts = new Map<number, number>();
      for (const r of photoRows) {
        if (r.photoId === null) continue;
        photoIdCounts.set(r.photoId, (photoIdCounts.get(r.photoId) || 0) + 1);
      }

      if (rule.operator === "包含全部") {
        return [...photoIdCounts.entries()]
          .filter(([, count]) => count >= tagIds.length)
          .map(([id]) => id);
      }
      // 包含任一
      return [...photoIdCounts.keys()];
    }

    case "focalLength": {
      let cond;
      if (rule.operator === ">=") {
        cond = sql`CAST(${exifData.focalLength} AS REAL) >= ${rule.value}`;
      } else if (rule.operator === "<=") {
        cond = sql`CAST(${exifData.focalLength} AS REAL) <= ${rule.value}`;
      } else {
        cond = and(
          sql`CAST(${exifData.focalLength} AS REAL) >= ${rule.value}`,
          sql`CAST(${exifData.focalLength} AS REAL) <= ${rule.max ?? rule.value}`
        );
      }
      const rows = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(and(sql`${exifData.focalLength} IS NOT NULL`, cond))
        .all();
      return rows.map((r) => r.photoId).filter(Boolean) as number[];
    }

    case "aperture": {
      let cond;
      if (rule.operator === ">=") {
        cond = gte(exifData.aperture, rule.value);
      } else if (rule.operator === "<=") {
        cond = lte(exifData.aperture, rule.value);
      } else {
        cond = and(
          gte(exifData.aperture, rule.value),
          lte(exifData.aperture, rule.max ?? rule.value)
        );
      }
      const rows = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(and(sql`${exifData.aperture} IS NOT NULL`, cond))
        .all();
      return rows.map((r) => r.photoId).filter(Boolean) as number[];
    }

    case "iso": {
      let cond;
      if (rule.operator === ">=") {
        cond = gte(exifData.iso, rule.value);
      } else if (rule.operator === "<=") {
        cond = lte(exifData.iso, rule.value);
      } else {
        cond = and(
          gte(exifData.iso, rule.value),
          lte(exifData.iso, rule.max ?? rule.value)
        );
      }
      const rows = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(and(sql`${exifData.iso} IS NOT NULL`, cond))
        .all();
      return rows.map((r) => r.photoId).filter(Boolean) as number[];
    }

    case "fileFormat": {
      const rows = db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.format, rule.value))
        .all();
      return rows.map((r) => r.id);
    }

    default:
      return [];
  }
}

// --- Public API ---

function intersectIds(idSets: number[][]): number[] {
  if (!idSets.length) return [];
  let result = idSets[0];
  for (let i = 1; i < idSets.length; i++) {
    const set = new Set(idSets[i]);
    result = result.filter((id) => set.has(id));
  }
  return result;
}

export function evaluateSmartAlbum(rules: SmartAlbumRules): number[] {
  if (!rules.rules || !rules.rules.length) {
    return [];
  }

  const idSets = rules.rules.map(evaluateRule);
  return intersectIds(idSets);
}

export function validateSmartRules(
  rulesJson: string
): { valid: boolean; matchCount: number; error?: string } {
  try {
    const rules = JSON.parse(rulesJson) as SmartAlbumRules;
    if (!rules.rules || !Array.isArray(rules.rules)) {
      return { valid: false, matchCount: 0, error: "rules 字段必须是数组" };
    }
    const ids = evaluateSmartAlbum(rules);
    return { valid: true, matchCount: ids.length };
  } catch (e: any) {
    return { valid: false, matchCount: 0, error: e.message ?? "无效的 JSON" };
  }
}

export type { SmartAlbumRules, SmartRule };
