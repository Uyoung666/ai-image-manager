// Adapted from pqoqubbw/icons/connect.tsx; see licenses/Lucide-Animated-MIT.txt.
import { createAnimatedIcon } from "./create-animated-icon";

const TOP_CABLE = "M19 5l3 -3";
const BOTTOM_CABLE = "m2 22 3-3";
const FIRST_PIN = "M7.5 13.5 l2.5 -2.5";
const SECOND_PIN = "M10.5 16.5 l2.5 -2.5";

export const ConnectIcon = /* @__PURE__ */ createAnimatedIcon(
  "connect",
  [
    ["path", { d: TOP_CABLE, key: "top-cable" }],
    ["path", { d: BOTTOM_CABLE, key: "bottom-cable" }],
    [
      "path",
      {
        d: "M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z",
        key: "socket",
      },
    ],
    ["path", { d: FIRST_PIN, key: "first-pin" }],
    ["path", { d: SECOND_PIN, key: "second-pin" }],
    [
      "path",
      {
        d: "m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z",
        key: "plug",
      },
    ],
  ],
  {
    duration: 0.45,
    motion: {},
    partVariants: {
      0: {
        normal: { d: TOP_CABLE },
        animate: { d: [TOP_CABLE, "M17 7l5 -5", TOP_CABLE] },
      },
      1: {
        normal: { d: BOTTOM_CABLE },
        animate: { d: [BOTTOM_CABLE, "m2 22 6-6", BOTTOM_CABLE] },
      },
      2: { normal: { x: 0, y: 0 }, animate: { x: [0, 3, 0], y: [0, -3, 0] } },
      3: {
        normal: { d: FIRST_PIN },
        animate: { d: [FIRST_PIN, "M10.43 10.57 l0.10 -0.10", FIRST_PIN] },
      },
      4: {
        normal: { d: SECOND_PIN },
        animate: { d: [SECOND_PIN, "M13.43 13.57 l0.10 -0.10", SECOND_PIN] },
      },
      5: { normal: { x: 0, y: 0 }, animate: { x: [0, -3, 0], y: [0, 3, 0] } },
    },
  }
);
