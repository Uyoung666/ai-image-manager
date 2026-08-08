import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "1.4.0",
  date: "2026-08-08",
  title: {
    zh: "让每一次浏览，都更顺手。",
    en: "A smoother way to explore every photo.",
  },
  summary: {
    zh: "这一版继续打磨照片浏览、智能搜索和本地 AI 工作流，让你的图库保持安静、有序，也更容易被重新发现。",
    en: "This release refines browsing, intelligent search, and the local AI workflow so your library stays calm, organized, and easier to rediscover.",
  },
  highlights: [
    {
      icon: "search",
      title: {
        zh: "更自然地找到照片",
        en: "Find photos more naturally",
      },
      description: {
        zh: "用接近日常表达的方式搜索你的图库，少一点筛选，多一点发现。",
        en: "Search your library in everyday language, with less filtering and more discovery.",
      },
    },
    {
      icon: "layers",
      title: {
        zh: "更专注的照片工作区",
        en: "A more focused photo workspace",
      },
      description: {
        zh: "浏览、筛选和查看详情之间的切换更连贯，让整理照片保持在同一条节奏里。",
        en: "Move between browsing, culling, and details with a more continuous rhythm.",
      },
    },
    {
      icon: "sparkles",
      title: {
        zh: "AI 在本地安静工作",
        en: "AI that works quietly on your device",
      },
      description: {
        zh: "索引、识别和整理都围绕本地图库运行，照片始终掌握在你手里。",
        en: "Indexing, recognition, and organization stay close to your local library and under your control.",
      },
    },
  ],
};

export default changelog;
