import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.3",
  date: "2026-10-03",
  title: {
    zh: "浏览更稳定，漫游与界面焕新。",
    en: "Steadier browsing, refreshed Wander and interface.",
  },
  summary: {
    zh: "改进照片与序列视图、返回定位和续段建议，新增视差漫游与设置预览，并更新主题切换、输入体验、关于页和应用内更新反馈。",
    en: "Improves photo and sequence views, return navigation and continuation suggestions, adds parallax Wander with a settings preview, and refreshes theme transitions, text inputs, the About page and update feedback.",
  },
  highlights: [
    {
      icon: "layers",
      title: {
        zh: "照片与序列浏览更稳定",
        en: "More stable photo and sequence browsing",
      },
      description: {
        zh: "分离照片与序列视图，改善切换文件夹、打开详情和返回列表时的瀑布流布局与滚动恢复；保持搜索、选中状态和相册收藏一致。",
        en: "Separates photo and sequence views, improves masonry layout and scroll restoration when switching folders or opening and leaving details, and keeps search, selections and album favorites consistent.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "延时序列续段建议",
        en: "Timelapse continuation suggestions",
      },
      description: {
        zh: "根据设备、拍摄节奏和边界画面提供续段建议，可预览前后段并确认合并。合并后的序列手动锁定，自动识别不会覆盖它。",
        en: "Suggests continuations using device information, capture rhythm and boundary images. Preview both segments before confirming a merge; merged sequences are manually locked and preserved during automatic detection.",
      },
    },
    {
      icon: "image",
      title: {
        zh: "视差漫游与实时预览",
        en: "Parallax Wander and live preview",
      },
      description: {
        zh: "漫游新增视差照片墙，可选择流动速度，也可继续使用幻灯片。设置页提供展示方式预览，便于调整后再开始漫游。",
        en: "Adds a parallax photo wall with adjustable flow speed alongside the slideshow. Preview the presentation in settings before starting Wander.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "主题与输入交互更流畅",
        en: "Smoother theme and input interactions",
      },
      description: {
        zh: "主题切换新增从按钮位置展开的圆形过渡，搜索与命名输入加入平滑光标效果，并尊重减少动态效果的系统偏好。",
        en: "Theme changes expand in a circular transition from the toggle. Search and naming inputs gain smooth caret motion, respecting the system preference for reduced motion.",
      },
    },
    {
      icon: "image",
      title: { zh: "关于页焕新", en: "A refreshed About page" },
      description: {
        zh: "关于页加入作品画廊、作者介绍和互动人群动画，支持小窗口浏览与键盘操作。",
        en: "The About page adds a photo gallery, an author introduction and an interactive crowd animation, with support for smaller windows and keyboard interaction.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "更新反馈与历史日志补齐",
        en: "Clearer updates and complete release history",
      },
      description: {
        zh: "改进更新检查、下载、安装与重启反馈及异常恢复；补齐 2.2.2 和本版本的中英文内置日志，可在更新设置中离线查看。",
        en: "Improves feedback and recovery for update checks, downloads, installation and restart. Bundles Chinese and English release notes for both 2.2.2 and this version, available offline in update settings.",
      },
    },
  ],
};

export default changelog;
