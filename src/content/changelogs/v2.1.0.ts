import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.1.0",
  date: "2026-08-30",
  title: {
    zh: "让你的本地图库，更好看，也更容易扩展。",
    en: "A more expressive and extensible local photo library.",
  },
  summary: {
    zh: "v2.1.0 带来安全的声明式插件系统、签名语言包和全新的 Nebula Glass 主题，并改进以图搜图预览、标签建议与 Windows 安装更新体验。照片索引和 AI 推理仍默认在本机完成，公开插件也不能执行第三方代码或读取宿主数据。",
    en: "v2.1.0 introduces a secure declarative plugin system, signed locale packs, and the new Nebula Glass theme, alongside better image-search previews, tag suggestions, and Windows installation and update flows. Photo indexing and AI inference still run locally by default, and public plugins cannot execute third-party code or read host data.",
  },
  highlights: [
    {
      icon: "layers",
      title: {
        zh: "安全、可扩展的声明式插件系统",
        en: "A secure, extensible declarative plugin system",
      },
      description: {
        zh: "新增插件管理、导入预检、设置编辑、资源绑定、版本升级和失败回滚。公开插件只能提供受限的主题、语言和媒体声明，不能运行第三方 JavaScript、HTML 或任意 CSS，也不能读取照片、数据库、原始路径或主动联网。",
        en: "Plugin management now covers import preflight, settings, asset binding, upgrades, and rollback after failed activation. Public plugins are restricted to declarative themes, locales, and media: they cannot run third-party JavaScript, HTML, or arbitrary CSS, read photos, databases, or original paths, or initiate network access.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "Nebula Glass 主题与更灵活的外观定制",
        en: "Nebula Glass and more flexible appearance controls",
      },
      description: {
        zh: "新增内置 Nebula Glass 主题、声明式主题图层、材质与资源配置，并改善仪表盘卡片对比度。插件设置由宿主统一渲染和预览，更新主题时会保留已有设置、启用状态和用户选择的媒体资源。",
        en: "The built-in Nebula Glass theme adds declarative layers, materials, and configurable assets, with improved dashboard card contrast. Plugin settings and previews are rendered by the host, while theme updates preserve settings, enabled state, and user-selected media.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "签名语言包与运行时语言扩展",
        en: "Signed locale packs and runtime language extensions",
      },
      description: {
        zh: "语言包现在使用固定结构和签名校验，可扩展渲染进程与主进程文案，同时保持 HTML、可执行代码和未知键值在信任边界之外。语言切换、插件错误提示和本地化回退也得到统一处理。",
        en: "Locale packs now use a fixed layout and signature verification to extend renderer and main-process copy while keeping HTML, executable code, and unknown keys outside the trust boundary. Language switching, plugin errors, and localization fallback are handled consistently.",
      },
    },
    {
      icon: "search",
      title: {
        zh: "更直观的以图搜图和标签建议",
        en: "Clearer image search and tag suggestions",
      },
      description: {
        zh: "以图搜图会显示当前参考图片，搜索过程更容易确认和调整；照片详情中的 AI 标签建议也更清晰。相关语义检索继续由本地 SigLIP 索引提供，建议结果仍由用户决定是否采用。",
        en: "Image-to-image search now shows the active reference image, making searches easier to verify and refine, while AI tag suggestions in photo details are clearer. Semantic matching continues to use the local SigLIP index, and users remain in control of accepting suggestions.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "更可靠的 Windows 安装、退出与自动更新",
        en: "More reliable Windows installation, shutdown, and updates",
      },
      description: {
        zh: "新增可选安装目录的 MSI，并统一 Setup 与默认 MSI 的应用内更新通道；更新迁移到腾讯云 COS，支持完整包与有效增量包回退。重新安装后的图库恢复、应用退出、安装锁、更新并发下载和 MSI 卸载残留进程也得到修复。",
        en: "A new MSI supports choosing an install directory while Setup and the default MSI share one in-app update channel. Updates move to Tencent COS with safe fallback between full and valid delta packages. This release also fixes library restoration after reinstall, app shutdown, installer locks, concurrent update downloads, and lingering MSI uninstall processes.",
      },
    },
  ],
};

export default changelog;
