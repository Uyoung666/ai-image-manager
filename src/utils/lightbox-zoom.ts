import type { ImageArea } from "./browse-image";

interface Point {
  x: number;
  y: number;
}

export function rotatedPoint(point: Point, degrees: number): Point {
  switch (((degrees % 360) + 360) % 360) {
    case 90:
      return { x: -point.y, y: point.x };
    case 180:
      return { x: -point.x, y: -point.y };
    case 270:
      return { x: point.y, y: -point.x };
    default:
      return point;
  }
}

export function limitLightboxPan(
  point: Point,
  fitted: ImageArea,
  area: ImageArea,
  zoom: number,
  quarterTurn = false
): Point {
  const width = quarterTurn ? fitted.height : fitted.width;
  const height = quarterTurn ? fitted.width : fitted.height;
  const x = Math.max(0, (width * zoom - area.width) / 2);
  const y = Math.max(0, (height * zoom - area.height) / 2);
  return {
    x: Math.max(-x, Math.min(x, point.x)),
    y: Math.max(-y, Math.min(y, point.y)),
  };
}
