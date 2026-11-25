import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.2.13",
  date: "2026-11-25",
  title: {
    zh: "拍摄项目交接与照片导出",
    en: "Project handoffs and photo delivery",
  },
  summary: {
    zh: "交接拍摄项目时可以携带编辑记录，导出和分享照片时可以选择公开哪些资料。",
    en: "Include editing sidecars in a project handoff and choose which details to disclose when exporting or sharing photos.",
  },
  highlights: [
    {
      icon: "layers",
      title: {
        zh: "随原片复制编辑记录",
        en: "Copy editing sidecars with originals",
      },
      description: {
        zh: "复制前可预览 XMP 和 ACR 文件，并决定是否带上由入选和未入选照片共用的伴随文件。",
        en: "Preview XMP and ACR files before copying and choose whether to include sidecars shared by selected and unselected photos.",
      },
    },
    {
      icon: "image",
      title: { zh: "选择交付内容", en: "Choose what to deliver" },
      description: {
        zh: "原片保留完整元数据。JPEG 副本可设置尺寸和水印，导出图册与分享页可选择附带文件名、拍摄资料和已确认的标签。",
        en: "Originals retain embedded metadata. Set the dimensions and watermark for JPEG copies, and choose which filenames, capture details, and reviewed tags appear in a gallery or share page.",
      },
    },
  ],
};

export default changelog;
