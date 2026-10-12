const OBJECTS = ["手表", "戒指", "玻璃瓶", "相机", "汽车", "杯子"];
const COLORS = ["金色", "银色", "黑色"];
const CONTEXTS = [
  "的特写",
  "摆在桌上",
  "放在窗边",
  "的产品照片",
  "在深色背景前",
];
const ENGLISH_OBJECTS = [
  "a dog",
  "a person",
  "a tree",
  "a building",
  "a meal",
  "a camera",
];
const ENGLISH_CONTEXTS = [
  "near a window",
  "under sunlight",
  "at night",
  "on a street",
  "on a table",
];

/** The same fixed mixed-language workload for both versions; no judgments. */
export function warmTimingQuery(round, index) {
  if (index % 2 === 0) {
    return `${COLORS[round]}${OBJECTS[index % 6]}${CONTEXTS[Math.floor(index / 6)]}`;
  }
  return `${["a photograph of", "a detailed image of", "an outdoor photo of"][round]} ${ENGLISH_OBJECTS[index % 6]} ${ENGLISH_CONTEXTS[Math.floor(index / 6)]}`;
}

export function switchTimingQueries(round, index) {
  return [
    `a landscape with buildings ${round}-${index}`,
    `${COLORS[round]}${OBJECTS[index % 6]}${CONTEXTS[Math.floor(index / 6)]}，侧面视角`,
  ];
}
