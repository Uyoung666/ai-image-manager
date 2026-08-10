import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.0.0",
  date: "2026-08-10",
  title: {
    zh: "全新人脸识别引擎，向 2.0 出发。",
    en: "A brand-new face recognition engine, built for 2.0.",
  },
  summary: {
    zh: "这一版把本地人脸识别升级到更准确、更开放的新一代引擎，同时继续打磨浏览、搜索与序列整理体验。",
    en: "This release upgrades on-device face recognition to a more accurate, more open next-generation engine, and keeps refining browsing, search, and sequence workflows.",
  },
  highlights: [
    {
      icon: "sparkles",
      title: {
        zh: "全新人脸引擎",
        en: "A brand-new face engine",
      },
      description: {
        zh: "以 YuNet 检测 + SFace 识别替换旧引擎，支持五点关键点对齐与 128 维嵌入，人物聚类更稳定。",
        en: "Replaced the legacy pipeline with YuNet detection + SFace recognition, adding 5-point landmark alignment and 128-d embeddings for more reliable clustering.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "更开放的模型许可",
        en: "More open model licensing",
      },
      description: {
        zh: "人脸模型全部迁移到 Apache-2.0 / MIT 许可，随包附带完整许可证文本，可安心分发与商用。",
        en: "Face models now ship under Apache-2.0 / MIT licenses with full license texts bundled, safe to distribute and use commercially.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "浏览体验持续打磨",
        en: "A smoother browsing experience",
      },
      description: {
        zh: "修复图库加载闪烁、序列详情重排与相册人像校验等细节，让整理更连贯。",
        en: "Fixed gallery loading flicker, sequence reordering, and album face review details for a more coherent workflow.",
      },
    },
  ],
};

export default changelog;
