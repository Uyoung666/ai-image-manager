// Adapted from pqoqubbw/icons/chart-line.tsx; see licenses/Lucide-Animated-MIT.txt.
import { createAnimatedIcon } from "./create-animated-icon";

export const ChartLineIcon = /* @__PURE__ */ createAnimatedIcon(
  "chart-line",
  [
    ["path", { d: "M3 3v16a2 2 0 0 0 2 2h16", key: "axes" }],
    ["path", { d: "m7 13 3-3 4 4 5-5", key: "chart" }],
  ],
  {
    motion: {},
    parts: [],
    partVariants: {
      1: {
        normal: { pathLength: 1, opacity: 1 },
        animate: {
          pathLength: [0, 1],
          opacity: [0, 1],
          transition: {
            delay: 0.15,
            duration: 0.3,
            opacity: { delay: 0.1 },
          },
        },
      },
    },
  }
);
