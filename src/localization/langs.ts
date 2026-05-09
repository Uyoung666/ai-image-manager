import type { Language } from "./language";

export default [
  {
    key: "zh",
    nativeName: "中文",
    prefix: "ZH-CN",
  },
  {
    key: "en",
    nativeName: "English",
    prefix: "EN-US",
  },
] as const satisfies Language[];
