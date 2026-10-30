import exifr from "exifr";

/** Lightweight photographic metadata shared by offline preparation and the viewer. */
export async function parseProjectExif(
  source: string,
  fallbackDate: number | null = null
) {
  const tags = await exifr
    .parse(source, {
      pick: [
        "Make",
        "Model",
        "LensModel",
        "FNumber",
        "ExposureTime",
        "ISO",
        "FocalLength",
        "DateTimeOriginal",
        "CreateDate",
      ],
    })
    .catch(() => null);
  const capture = tags?.DateTimeOriginal ?? tags?.CreateDate;
  const exposure = tags?.ExposureTime;
  let shutterSpeed: string | null = null;
  if (typeof exposure === "number") {
    shutterSpeed =
      exposure > 0 && exposure < 1
        ? `1/${Math.round(1 / exposure)}`
        : String(exposure);
  }
  return {
    cameraMake: tags?.Make ?? null,
    cameraModel: tags?.Model ?? null,
    lensModel: tags?.LensModel ?? null,
    aperture: tags?.FNumber ?? null,
    shutterSpeed,
    iso: tags?.ISO ?? null,
    focalLength: tags?.FocalLength == null ? null : String(tags.FocalLength),
    dateTaken:
      capture instanceof Date && Number.isFinite(capture.getTime())
        ? capture.getTime()
        : fallbackDate,
    advanced: null,
  };
}
