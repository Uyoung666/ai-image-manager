import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.10",
  date: "2026-11-17",
  title: {
    zh: "修复 Windows MSI 应用内更新",
    en: "Fix in-app updates for Windows MSI installations",
  },
  summary: {
    zh: "修复部分 MSI 安装无法应用增量更新的问题。旧版本升级到本版会下载全量包。",
    en: "This release fixes a failure applying incremental updates on some MSI installations. Upgrading from an older version downloads the full package.",
  },
  highlights: [
    {
      icon: "zap",
      title: {
        zh: "使用可写的更新临时目录",
        en: "Use a writable update temporary directory",
      },
      description: {
        zh: "安装更新时使用当前用户可写的临时目录。安装前会检查目录权限和可用空间。",
        en: "The updater uses a temporary directory writable by the current user. It checks access and free space before installing.",
      },
    },
  ],
};

export default changelog;
