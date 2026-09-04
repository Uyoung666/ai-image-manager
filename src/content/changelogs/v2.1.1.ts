import type { ChangelogEntry } from "./types";

const changelog: ChangelogEntry = {
  version: "2.1.1",
  date: "2026-09-04",
  title: {
    zh: "日语界面，按需安装。",
    en: "Japanese UI, available as an optional language pack.",
  },
  summary: {
    zh: "v2.1.1 加入官方语言包签名公钥，让用户可以安全导入独立发布的日语语言包；应用、照片索引和 AI 推理仍保持本地运行。",
    en: "v2.1.1 adds the official language-pack signing key so users can safely import the separately distributed Japanese locale pack. The app, photo index, and AI inference remain local.",
  },
  highlights: [
    {
      icon: "layers",
      title: {
        zh: "官方签名的日语语言包",
        en: "Officially signed Japanese locale pack",
      },
      description: {
        zh: "日语翻译作为独立的声明式插件提供，可从 GitHub Release 下载并在插件设置中导入。包内只有 JSON 翻译资源与 Ed25519 签名，不包含可执行代码、HTML、CSS 或联网能力。",
        en: "Japanese translations are provided as a separate declarative plugin that can be downloaded from GitHub Releases and imported from plugin settings. The package contains only JSON locale resources and an Ed25519 signature, with no executable code, HTML, CSS, or network access.",
      },
    },
    {
      icon: "zap",
      title: {
        zh: "继续使用 COS 增量更新",
        en: "Continued COS delta updates",
      },
      description: {
        zh: "已安装 v2.1.0 的用户继续通过腾讯云 COS stable 通道获取本补丁；存在有效且更小的增量包时优先使用增量更新，否则安全回退完整包。",
        en: "Existing v2.1.0 installations continue to receive this patch from the Tencent COS stable channel. A valid smaller delta is preferred, with a safe fallback to the full package.",
      },
    },
  ],
};

export default changelog;
