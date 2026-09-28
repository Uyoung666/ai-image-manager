import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.1",
  date: "2026-09-28",
  title: {
    zh: "升级启动修复，更新提示更清晰。",
    en: "Reliable upgrade startup and clearer update errors.",
  },
  summary: {
    zh: "修复升级后首次启动的浏览会话异常，并为更新失败提供清晰的提示和重试入口。",
    en: "Fixes the browse-session error on the first launch after an upgrade and provides readable update errors with retry options.",
  },
  highlights: [
    {
      icon: "layers",
      title: { zh: "小窗口也能继续使用", en: "Continue in smaller windows" },
      description: {
        zh: "更新日志在小窗口中可滚动阅读，长文案不再遮挡底部的继续使用按钮。",
        en: "Release notes scroll in smaller windows without long text overlapping the Continue button.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "升级后正常进入首页",
        en: "Open the gallery after upgrading",
      },
      description: {
        zh: "更新欢迎页与普通页面共享浏览会话，避免切换期间出现缺失上下文的错误。",
        en: "The update welcome screen and regular pages share the browse session, preventing missing-context errors during navigation.",
      },
    },
    {
      icon: "zap",
      title: { zh: "看得懂的更新错误", en: "Readable update errors" },
      description: {
        zh: "网络、安全连接和更新包错误显示本地化说明，旧缓存中的乱码也会转换为可读提示；可重试或手动下载。",
        en: "Network, secure-connection and package failures show localized explanations. Old cached errors are also made readable, with retry and manual download options.",
      },
    },
  ],
};

export default changelog;
