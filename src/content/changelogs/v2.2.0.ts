import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.0",
  date: "2026-09-26",
  title: {
    zh: "更稳地导入、搜索和整理重复图片。",
    en: "A more reliable way to import, search, and clean up duplicates.",
  },
  summary: {
    zh: "v2.2.0 重点提升图库导入、搜索和重复图片整理的可靠性：重复检测结果可以持久化审核，清理操作会先生成可恢复的计划；中断导入、文件监听、EXIF 分页、标签搜索和 AI 诊断也得到改进。",
    en: "v2.2.0 improves the reliability of importing, searching, and managing duplicate photos. Duplicate results now support persistent review and recoverable cleanup plans, while interrupted imports, file watching, EXIF pagination, tag search, and AI diagnostics are also more robust.",
  },
  highlights: [
    {
      icon: "search",
      title: {
        zh: "持久化重复检测与人工审核",
        en: "Persistent duplicate detection and review",
      },
      description: {
        zh: "重复扫描会保存文件指纹、扫描版本和分组结果，支持区分完全重复与视觉相似候选。你可以逐组选择保留或删除，并在重新扫描后继续已有审核进度。",
        en: "Duplicate scans now save file fingerprints, run versions, and group results. Exact duplicates and visually similar candidates are distinguished, and you can review groups while preserving decisions across rescans.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "带恢复能力的安全清理",
        en: "Safer cleanup with recovery",
      },
      description: {
        zh: "批量清理会先冻结审核证据并生成清理计划，执行后保留批次和审计记录。移入回收站的照片可以按批次恢复，文件发生变化或审核过期时会阻止过时操作。",
        en: "Batch cleanup freezes the reviewed evidence before execution and records each cleanup batch. Photos moved to the trash can be restored by batch, while changed files and stale reviews block outdated actions.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "中断导入与文件监听更可靠",
        en: "More reliable imports and file watching",
      },
      description: {
        zh: "应用重启后可以恢复未完成的导入，导入结果会分别说明已索引、跳过和失败的文件。文件监听异常会被隔离，不再轻易影响应用启动和其他目录。",
        en: "Unfinished imports can resume after a restart, with separate counts for indexed, skipped, and failed files. File-watcher failures are isolated so they do not take down startup or unrelated folders.",
      },
    },
    {
      icon: "search",
      title: {
        zh: "搜索、图库和桌面操作体验改进",
        en: "Smoother search, gallery, and desktop workflows",
      },
      description: {
        zh: "EXIF 搜索支持完整分页，标签变化会及时刷新搜索和建议；筛选预设、批量重命名、格式转换、灯箱、详情面板、相册和上下文菜单也补充了状态反馈、偏好保存与窗口边界处理。",
        en: "EXIF search now paginates complete results, while tag changes refresh searches and suggestions promptly. Filter presets, batch rename, format conversion, lightbox, details, albums, and context menus also gain clearer feedback, saved preferences, and safer window boundaries.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "更完整的 AI 诊断与发布更新保护",
        en: "Richer AI diagnostics and safer release updates",
      },
      description: {
        zh: "AI 失败会保留模型和错误上下文，并经过更严格的路径、URL 和敏感字段脱敏。Windows 发布流程继续支持 COS 增量更新，同时强化完整包、增量包和 GitHub 兼容 RELEASES 的校验。",
        en: "AI failures now retain model and error context with stronger redaction for paths, URLs, and sensitive fields. Windows releases continue to support COS delta updates with stricter validation for full packages, deltas, and the GitHub-compatible RELEASES feed.",
      },
    },
  ],
};

export default changelog;
