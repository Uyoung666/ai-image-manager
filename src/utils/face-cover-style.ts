import type { CSSProperties } from "react";

export interface FaceCoverBbox {
  height: number;
  width: number;
  x: number;
  y: number;
}

export type FaceCoverImageStyle = CSSProperties;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function isFinitePositive(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Focus an object-cover image on a detected face while safely falling back to
 * the regular square crop for malformed or missing face coordinates.
 */
export function getFaceFocusedCoverStyle(
  bbox: FaceCoverBbox | null,
  photoWidth: number | null,
  photoHeight: number | null
): FaceCoverImageStyle {
  const baseStyle: FaceCoverImageStyle = { objectFit: "cover" };
  if (!bbox) {
    return baseStyle;
  }
  if (!(isFinitePositive(photoWidth) && isFinitePositive(photoHeight))) {
    return baseStyle;
  }
  if (!(Number.isFinite(bbox.x) && Number.isFinite(bbox.y))) {
    return baseStyle;
  }
  if (!(Number.isFinite(bbox.width) && Number.isFinite(bbox.height))) {
    return baseStyle;
  }

  const left = clamp(bbox.x, 0, photoWidth);
  const top = clamp(bbox.y, 0, photoHeight);
  const right = clamp(bbox.x + bbox.width, 0, photoWidth);
  const bottom = clamp(bbox.y + bbox.height, 0, photoHeight);
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0 && height > 0)) {
    return baseStyle;
  }

  const centerX = ((left + width / 2) / photoWidth) * 100;
  const centerY = ((top + height / 2) / photoHeight) * 100;
  const faceRatio = Math.max(width / photoWidth, height / photoHeight);
  const zoom = clamp(1 / (faceRatio * 2.2), 1.2, 4);
  const position = `${centerX}% ${centerY}%`;

  return {
    objectFit: "cover",
    objectPosition: position,
    transform: `scale(${zoom})`,
    transformOrigin: position,
  };
}
