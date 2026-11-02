import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.7",
  date: "2026-11-02",
  title: {
    zh: "完善 HEIC 离线解码，优化导入与 AI 处理。",
    en: "Improve offline HEIC decoding, imports and AI processing.",
  },
  summary: {
    zh: "内置 HEIC / HEIF 解码，改善照片导入、预览与 AI 分析。相对 2.2.6 无新增数据库迁移，无需全量重建 AI 索引。",
    en: "Built-in HEIC / HEIF decoding improves photo imports, previews and AI analysis. No new database migration or full AI index rebuild is required compared with 2.2.6.",
  },
  highlights: [
    {
      icon: "image",
      title: { zh: "HEIC 离线解码", en: "Offline HEIC decoding" },
      description: {
        zh: "无需额外安装系统解码扩展，支持 HEIC / HEIF 导入、缩略图、预览及 AI 分析，改善方向与色彩处理。",
        en: "Import, thumbnail, preview and analyze HEIC / HEIF photos without extra system codecs, with improved orientation and color handling.",
      },
    },
    {
      icon: "zap",
      title: { zh: "减少重复处理", en: "Reduce repeated processing" },
      description: {
        zh: "复用模型输入缓存，优化批量任务分配并逐张更新进度；分类显示解码、模型及推理失败，改善后台进程回收。",
        en: "Reuse model input caches, balance batches and update progress per photo. Report decoding, model and inference failures separately and improve worker cleanup.",
      },
    },
    {
      icon: "layers",
      title: { zh: "保留原有数据升级", en: "Upgrade with existing data" },
      description: {
        zh: "2.2.6 安装版可应用内更新；2.2.4 / 2.2.5 请退出后沿用原安装类型手动覆盖安装，保留应用数据目录。",
        en: "Installed 2.2.6 copies can update in the app. For 2.2.4 / 2.2.5, exit and manually upgrade using the same installer format, keeping the app data directory.",
      },
    },
  ],
};

export default changelog;
