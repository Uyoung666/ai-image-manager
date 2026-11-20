import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.12",
  date: "2026-11-20",
  title: {
    zh: "大图沉浸浏览与搜索交互改进",
    en: "Immersive photo viewing and search improvements",
  },
  summary: {
    zh: "在大图中进入沉浸全屏，体验更流畅的缩放、平移和 HEIC 预览，以及改进后的搜索和字符海洋主题交互。",
    en: "View photos in immersive fullscreen, with smoother zooming, panning, and HEIC previews, plus refinements to search and the ASCII Ocean theme.",
  },
  highlights: [
    {
      icon: "image",
      title: { zh: "沉浸浏览大图", en: "View photos in immersive fullscreen" },
      description: {
        zh: "从大图工具栏进入沉浸全屏，按 Esc 退出。缩放和加载高清图时保留当前查看位置，HEIC 照片可优先显示已有预览。",
        en: "Enter immersive fullscreen from the lightbox toolbar and press Esc to exit. Keep your viewing position while zooming or loading a sharper image, and view cached HEIC previews while the full image loads.",
      },
    },
    {
      icon: "search",
      title: { zh: "优化搜索和筛选", en: "Refine search and filtering" },
      description: {
        zh: "改善搜索预设的布局与滚动，鼠标移出搜索历史后清除悬停高亮，点击工具栏空白处即可收起 EXIF 筛选。",
        en: "Search presets have an improved layout and scrolling. Hover highlighting clears when the pointer leaves search history, and clicking empty toolbar space closes the EXIF filters.",
      },
    },
    {
      icon: "sparkles",
      title: { zh: "修复字符海洋主题交互", en: "Refine the ASCII Ocean theme" },
      description: {
        zh: "修正工具栏对齐。鼠标移过露出海洋背景的留白时产生水纹，点击时产生更大的水波。",
        en: "Toolbars align correctly. Moving the pointer over exposed ocean backgrounds creates ripples, and clicking creates larger waves.",
      },
    },
  ],
};

export default changelog;
