import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.2",
  date: "2026-09-30",
  title: {
    zh: "GitHub 更新分发，图片管理更顺手。",
    en: "GitHub updates and smoother photo management.",
  },
  summary: {
    zh: "发布流程与新版客户端更新统一使用 GitHub Releases，并改进文件夹浏览、返回定位、自动标签和界面兼容性。",
    en: "Release delivery and updates for newer clients use GitHub Releases, with improvements to folder browsing, return navigation, automatic tags and interface compatibility.",
  },
  highlights: [
    {
      icon: "zap",
      title: {
        zh: "统一由 GitHub 分发更新",
        en: "Updates delivered by GitHub",
      },
      description: {
        zh: "安装包、更新清单、增量包和全量包统一由 GitHub Releases 分发。支持自动更新的安装方式优先尝试增量包，失败后回退全量包，并校验下载内容。",
        en: "Installers, update manifests, delta and full packages are distributed through GitHub Releases. Supported installations try delta updates first, fall back to a full package on failure and verify downloaded content.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "浏览与返回更连贯",
        en: "More consistent browsing and returns",
      },
      description: {
        zh: "优化固定文件夹树的层级与操作；从图片详情返回图库或相册时定位最近浏览的图片，并统一下钻筛选交互。",
        en: "Improves pinned folder hierarchy and actions, locates recently viewed photos when returning to a gallery or album and makes drill-down filters more consistent.",
      },
    },
    {
      icon: "sparkles",
      title: { zh: "改进自动标签", en: "Improved automatic tags" },
      description: {
        zh: "扩展自动标签覆盖范围，改进标签评分与刷新逻辑，让照片整理更方便。",
        en: "Expands automatic tag coverage and improves scoring and refresh behavior for easier photo organization.",
      },
    },
    {
      icon: "image",
      title: {
        zh: "界面与设备兼容性修复",
        en: "Interface and device compatibility fixes",
      },
      description: {
        zh: "统一按钮与加载动画，修复筛片深色主题、首次引导默认设置和语言菜单层级；DirectML 检测忽略虚拟显卡，原生模块按 Electron ABI 重建。",
        en: "Unifies button and loading animations and fixes dark culling themes, onboarding defaults and language menu stacking. DirectML detection ignores virtual adapters, and native modules are rebuilt for the Electron ABI.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "更新提示与日志返回",
        en: "Update feedback and release-note navigation",
      },
      description: {
        zh: "改进 GitHub 403 限流错误的说明；从更新设置查看日志后可返回原页面。ZIP 和禁用更新器的 MSI 仍需手动升级。",
        en: "Improves explanations for GitHub 403 rate-limit errors and returns to update settings after viewing release notes. ZIP builds and MSI installations with the updater disabled still require manual upgrades.",
      },
    },
  ],
};

export default changelog;
