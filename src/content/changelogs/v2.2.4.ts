import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.4",
  date: "2026-10-20",
  title: {
    zh: "搜索、浏览与更新体验改进。",
    en: "Improvements to search, browsing and updates.",
  },
  summary: {
    zh: "改进搜索结果刷新、照片定位与序列导航，完善更新续传及恢复，并提供配套的官方日语语言包。旧版 AI 索引需要确认重建。",
    en: "Improves search refresh, photo positioning and sequence navigation, adds update download recovery, and provides a matching official Japanese pack. Older AI indexes require a confirmed rebuild.",
  },
  highlights: [
    {
      icon: "search",
      title: {
        zh: "搜索与相册刷新",
        en: "Search and album refresh",
      },
      description: {
        zh: "改进组合查询、筛选和分页，修复数据变化、AI 初始化等待与旧请求响应导致的结果丢失；标签变化后及时刷新智能相册及封面。",
        en: "Improves composed queries, filters and pagination; fixes stale or missing results after data changes, AI initialization and delayed requests, and refreshes Smart Albums and covers after tag changes.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "照片与序列浏览",
        en: "Photo and sequence navigation",
      },
      description: {
        zh: "改善点选定位、详情返回、序列成员可见性与组内方向键导航；暂停序列时保留当前帧。",
        en: "Improves selection positioning, return navigation, sequence-member visibility and arrow-key navigation within a sequence. Paused playback keeps the current frame.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "更新续传与恢复",
        en: "Resumable updates and recovery",
      },
      description: {
        zh: "支持下载续传与任务恢复，完善空间检查、缓存修复、重试和安装重启反馈；顶部入口可跨页面查看任务状态。",
        en: "Supports resumable downloads and task recovery, with disk-space checks, cache repair, retries and clearer installation feedback. The header control shows update status across pages.",
      },
    },
    {
      icon: "image",
      title: {
        zh: "旧 AI 索引升级",
        en: "Upgrading older AI indexes",
      },
      description: {
        zh: "首次启动更新数据库结构。旧 AI 索引不兼容时，请在设置 → AI 索引中确认重建；保留原图、手动标签和收藏，无需重新导入照片。",
        en: "The database schema is updated on first launch. If an older AI index is incompatible, confirm a rebuild under Settings → AI Index. Original images, manual tags and favorites are preserved; no reimport is needed.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "官方日语语言包",
        en: "Official Japanese language pack",
      },
      description: {
        zh: "从正式 Release 独立下载匹配的官方签名语言包，在设置 → 插件中导入，确认安装后选择日本語。",
        en: "Download the matching official signed language pack from the formal Release, import it under Settings → Plugins, confirm installation and select 日本語.",
      },
    },
  ],
};

export default changelog;
