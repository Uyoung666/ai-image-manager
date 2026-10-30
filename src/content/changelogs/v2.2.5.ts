import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.5",
  date: "2026-10-30",
  title: {
    zh: "免导入选片与图库体验升级。",
    en: "Import-free culling and gallery improvements.",
  },
  summary: {
    zh: "从拍摄目录直接甄选和 PK，保存离线预览并复制保留原片；改善搜索历史、预设、图库浏览与批量整理。",
    en: "Cull directly from shooting folders, review offline previews and copy kept originals. Improve search history, presets, gallery browsing and batch organization.",
  },
  highlights: [
    {
      icon: "image",
      title: { zh: "免导入选片", en: "Import-free culling" },
      description: {
        zh: "无需先加入图库，支持甄选、PK 和组合流程，离线预览、核验原片复制与明确加入图库。",
        en: "Start without importing, using Curate, PK or a combined workflow, offline previews, verified original copying and explicit library import.",
      },
    },
    {
      icon: "layers",
      title: { zh: "统一选片归档", en: "Unified task archives" },
      description: {
        zh: "目录项目与图库会话统一管理，归档与恢复支持撤销，清空归档前确认范围并保留原片。",
        en: "Manage folder projects and library sessions together. Archive and restore with undo; confirmed cleanup preserves originals.",
      },
    },
    {
      icon: "search",
      title: { zh: "搜索历史与探索", en: "Search history and exploration" },
      description: {
        zh: "重用文字与图片历史，自定义保留数量，保存组合预设并浏览主题推荐；AI 结果可能存在偏差。",
        en: "Reuse text and image history, configure its limit, save combined presets and explore themes. AI results may be biased or incomplete.",
      },
    },
    {
      icon: "zap",
      title: { zh: "浏览与批量整理", en: "Browsing and batch organization" },
      description: {
        zh: "改善瀑布流、分页和缩略图稳定性，批量编辑标签并撤销，记住相册与导出偏好。",
        en: "Improve masonry loading, pagination and thumbnails; batch-edit tags with undo and remember album and export preferences.",
      },
    },
    {
      icon: "sparkles",
      title: { zh: "界面与升级", en: "Interface and upgrade" },
      description: {
        zh: "统一应用图标、动效和关于页。从 2.2.4 升级自动迁移数据库，无需例行重建 AI 索引。",
        en: "Refresh icons, animations and About. Upgrading from 2.2.4 migrates the database without a routine AI index rebuild.",
      },
    },
  ],
};

export default changelog;
