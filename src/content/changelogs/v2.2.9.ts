import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.9",
  date: "2026-11-16",
  title: {
    zh: "图库来源管理与照片恢复",
    en: "Library sources and photo recovery",
  },
  summary: {
    zh: "在设置中检查和重新关联原片。原片内容变化后，应用会保留人工整理信息并刷新预览、EXIF 和 AI 分析。",
    en: "Check and relink originals in Settings. When an original changes, the app keeps your manual organization and refreshes previews, EXIF, and AI analysis.",
  },
  highlights: [
    {
      icon: "layers",
      title: {
        zh: "集中管理图库来源",
        en: "Manage library sources",
      },
      description: {
        zh: "打开「设置 → 图库来源」，检查离线、缺失或不可访问的原片。为文件夹或单张照片选择新位置，并在保存前核对匹配结果。",
        en: "Open Settings → Library sources to check offline, missing, or inaccessible originals. Choose a new location for a folder or a photo and review the match before saving.",
      },
    },
    {
      icon: "image",
      title: {
        zh: "复核变更后的照片",
        en: "Review photos after changes",
      },
      description: {
        zh: "来源离线时可浏览已有缓存。图库选片结果提示内容变化时，可为已就绪的照片单独重新选片，原有决定继续保留。",
        en: "View cached previews when a source is offline. When library culling flags changed photos, start a separate review for photos that are ready and retain your earlier decisions.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "改善索引与更新可靠性",
        en: "Improve indexing and update reliability",
      },
      description: {
        zh: "恢复监视目录的自动发现与 AI 索引。Windows 短暂锁住更新元数据时，更新器会重试保存。",
        en: "Restore automatic discovery and AI indexing for watched folders. The updater retries saving metadata when Windows briefly locks the file.",
      },
    },
  ],
};

export default changelog;
