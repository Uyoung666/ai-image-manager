import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.9",
  date: "2026-11-03",
  title: {
    zh: "改善更新恢复与新版本启动确认。",
    en: "Improve update recovery and new-version startup confirmation.",
  },
  summary: {
    zh: "过期更新任务不再安装或重启旧版本；新版本完成关键服务启动与页面显示后才确认升级。升级保留图库和设置，无需重建 AI 索引。",
    en: "Outdated update tasks no longer install or restart an older version. Confirm an upgrade only after critical services and the page are ready, keeping your library and settings without rebuilding the AI index.",
  },
  highlights: [
    {
      icon: "layers",
      title: { zh: "安全恢复更新任务", en: "Recover update tasks safely" },
      description: {
        zh: "识别过期任务和真实安装进程，避免同版本重复安装。安装进程状态不明时可重新核验，也可正常退出应用。",
        en: "Identify outdated tasks and the actual installer process to avoid reinstalling the same version. Recheck an uncertain installer state or exit the app normally.",
      },
    },
    {
      icon: "sparkles",
      title: { zh: "确认新版真正就绪", en: "Confirm the new version is ready" },
      description: {
        zh: "等待关键服务和实际页面就绪，再观察启动状态。确认失败时保留诊断，并提供重启验证；AI 模型加载不阻塞确认。",
        en: "Wait for critical services and the rendered page, then observe startup stability. Keep diagnostics and offer restart verification on failure; AI model loading does not block confirmation.",
      },
    },
    {
      icon: "zap",
      title: { zh: "明确处理更新失败", en: "Make update failures actionable" },
      description: {
        zh: "保留断点续传、完整包重试与缓存修复。保存更新状态失败时停止后续安装或重启，并在标题栏和设置中提供一致的操作提示。",
        en: "Retain resumable downloads, full-package retries and cache repair. Stop installation or restart if update state cannot be saved, with consistent actions in the title bar and settings.",
      },
    },
  ],
};

export default changelog;
