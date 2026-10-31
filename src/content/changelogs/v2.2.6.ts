import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.6",
  date: "2026-10-31",
  title: {
    zh: "修复应用内更新下载。",
    en: "Fix in-app update downloads.",
  },
  summary: {
    zh: "修复 GitHub 更新附件跳转失败。2.2.4 / 2.2.5 用户需手动覆盖安装一次本版，并保留原有数据目录。",
    en: "Fix failed GitHub update redirects. Users of 2.2.4 / 2.2.5 need one manual upgrade to this version, keeping their existing data directory.",
  },
  highlights: [
    {
      icon: "zap",
      title: { zh: "更新下载修复", en: "Update downloads fixed" },
      description: {
        zh: "修复下载更新包时的跳转取消错误，保留系统代理、断点续传与文件校验。",
        en: "Fix cancelled redirects while downloading updates, retaining system proxy support, resumable downloads and file verification.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "旧版手动升级一次",
        en: "One manual upgrade for affected versions",
      },
      description: {
        zh: "2.2.4 / 2.2.5 用户退出应用后，使用原安装类型覆盖安装 2.2.6；不要卸载并清除数据。",
        en: "Users of 2.2.4 / 2.2.5 should exit the app and install 2.2.6 using the same installation format. Do not uninstall with data removal.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "保留图库与选片记录",
        en: "Keep your library and culling records",
      },
      description: {
        zh: "相对 2.2.5 没有新增数据库迁移，无需重建 AI 索引。后续更新使用修复后的更新器。",
        en: "No new database migration or AI index rebuild is required compared with 2.2.5. Subsequent updates use the repaired updater.",
      },
    },
  ],
};

export default changelog;
