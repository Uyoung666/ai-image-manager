// Adapted from pqoqubbw/icons/folders.tsx; see licenses/Lucide-Animated-MIT.txt.
import { createAnimatedIcon } from "./create-animated-icon";

export const FoldersIcon = /* @__PURE__ */ createAnimatedIcon(
  "folders",
  [
    [
      "path",
      {
        d: "M20 17a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3.9a2 2 0 0 1-1.69-.9l-.81-1.2a2 2 0 0 0-1.67-.9H8a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2Z",
        key: "front-folder",
      },
    ],
    ["path", { d: "M2 8v11a2 2 0 0 0 2 2h14", key: "back-folder" }],
  ],
  {
    motion: {},
    partVariants: {
      0: { normal: { x: 0, y: 0 }, animate: { x: [0, -2, 0], y: [0, 2, 0] } },
      1: {
        normal: { x: 0, y: 0, opacity: 1, scale: 1 },
        animate: {
          x: [0, 2, 0],
          y: [0, -2, 0],
          opacity: [1, 0, 1],
          scale: [1, 0.9, 1],
        },
      },
    },
  }
);
