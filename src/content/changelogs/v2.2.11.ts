import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.11",
  date: "2026-11-18",
  title: {
    zh: "图库目录管理与更新反馈改进",
    en: "Library directory management and clearer update feedback",
  },
  summary: {
    zh: "集中管理图库目录，查看后台图库检查状态和更清晰的更新反馈。",
    en: "Manage library directories in one place, see background checks, and get clearer update feedback.",
  },
  highlights: [
    {
      icon: "layers",
      title: { zh: "管理图库目录", en: "Manage library directories" },
      description: {
        zh: "在设置中查看当前图库和其他图库目录，并按需切换或迁移。",
        en: "View the active library and other library directories in Settings, then switch or move your library when needed.",
      },
    },
    {
      icon: "zap",
      title: { zh: "查看检查进度", en: "See check progress" },
      description: {
        zh: "标题栏显示后台图库检查状态。更新设置分别显示最近尝试与最近成功检查，历史更新说明支持分批展开。",
        en: "The title bar shows background library checks. Update settings show the last attempt and last successful check separately, and reveal older release notes in batches.",
      },
    },
    {
      icon: "zap",
      title: { zh: "改善更新检查的可靠性", en: "Improve update checks" },
      description: {
        zh: "GitHub API 限流时尝试通过官方下载入口获取更新清单。已选定版本的清单要求等待时，显示倒计时并在到期后重试同一版本。",
        en: "Try the official download endpoint for the update manifest when the GitHub API rate-limits requests. If the selected release asks you to wait, a countdown shows when you can retry that same release.",
      },
    },
  ],
};

export default changelog;
