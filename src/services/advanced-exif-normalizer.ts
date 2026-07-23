import type { PhotoMetadata, ProvenanceStatus } from "@/types/photo-metadata";

type RawTags = Record<string, unknown>;

const SENSITIVE_TAG = /serial|ownername|ownerid|deviceid/i;
const TRUE_VALUE = /^(true|yes|on|enabled|active|1)$/;
const FALSE_VALUE = /^(false|no|off|disabled|inactive|0|none)$/;
const DISABLED_MODE = /^(off|none|no|0)$/i;
const PROVENANCE_TAG = /c2pa|jumbf|content.?credential|claim.?generator/i;
const PROVENANCE_CAPABLE_FILE =
  /^(jpeg|jpg|png|webp|heic|heif|avif|tiff|dng)$/i;
const EXIF_DATE_TIME_PATTERN =
  /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const NUMERIC_FRACTION_PATTERN = /^\d+$/;
const POSITIVE_INTEGER_PATTERN = /^\d+$/;
const CONTINUOUS_DRIVE_PATTERN = /continuous|burst|high[ -]?speed/i;
const TRUSTED_BURST_GROUP_TAGS = [
  "BurstUUID",
  "BurstIdentifier",
  "BurstGroupID",
  "BurstGroupId",
] as const;

function normalizedKey(key: string): string {
  return (key.split(":").at(-1) ?? key)
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function tagIndex(tags: RawTags): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, value] of Object.entries(tags)) {
    const normalized = normalizedKey(key);
    if (!result.has(normalized) && value !== undefined && value !== "") {
      result.set(normalized, value);
    }
  }
  return result;
}

function asDisplay(value: unknown): string | null {
  if (value == null || value === "") {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(String).join(", ");
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value).trim() || null;
}

function pick(index: Map<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = asDisplay(index.get(normalizedKey(key)));
    if (value) {
      return value;
    }
  }
  return null;
}

function parseCaptureTimestampMs(index: Map<string, unknown>): number | null {
  const dateTime = pick(index, "DateTimeOriginal");
  const subSeconds = pick(index, "SubSecTimeOriginal");
  if (!dateTime) {
    return null;
  }
  const match = dateTime.match(EXIF_DATE_TIME_PATTERN);
  if (!match) {
    return null;
  }
  const fraction = match[7] ?? subSeconds;
  if (!(fraction && NUMERIC_FRACTION_PATTERN.test(fraction))) {
    return null;
  }
  const milliseconds = Number(`${fraction}000`.slice(0, 3));
  const timestamp = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    milliseconds
  ).getTime();
  return Number.isNaN(timestamp) ? null : timestamp;
}

function parseBurstFrameNumber(index: Map<string, unknown>): number | null {
  const value = pick(
    index,
    "SequenceNumber",
    "SequenceImageNumber",
    "SequenceFileNumber"
  );
  if (!(value && POSITIVE_INTEGER_PATTERN.test(value))) {
    return null;
  }
  const frameNumber = Number(value);
  return Number.isSafeInteger(frameNumber) && frameNumber > 0
    ? frameNumber
    : null;
}

function trustedBurstGroup(index: Map<string, unknown>) {
  for (const key of TRUSTED_BURST_GROUP_TAGS) {
    const value = pick(index, key);
    if (value) {
      return { burstGroupId: value, burstSignalSource: key };
    }
  }
  return { burstGroupId: null, burstSignalSource: null };
}

function asBoolean(value: string | null): boolean | null {
  if (!value) {
    return null;
  }
  const normalized = value.toLowerCase();
  if (TRUE_VALUE.test(normalized)) {
    return true;
  }
  if (FALSE_VALUE.test(normalized)) {
    return false;
  }
  return null;
}

export function normalizeCameraVendor(make: string | null): string | null {
  if (!make) {
    return null;
  }
  const value = make.toLowerCase();
  if (value.includes("canon")) {
    return "Canon";
  }
  if (value.includes("nikon")) {
    return "Nikon";
  }
  if (value.includes("sony")) {
    return "Sony";
  }
  if (value.includes("fujifilm") || value.includes("fuji")) {
    return "Fujifilm";
  }
  if (value.includes("panasonic") || value.includes("lumix")) {
    return "Panasonic";
  }
  if (value.includes("leica")) {
    return "Leica";
  }
  if (value.includes("olympus") || value.includes("om digital")) {
    return "OM System";
  }
  return make.trim();
}

function detectComputationalMode(index: Map<string, unknown>): string | null {
  const explicit = pick(
    index,
    "ComputationalMode",
    "HighResShot",
    "PixelShift",
    "FocusStacking",
    "LiveND",
    "MultipleExposureMode",
    "HDR"
  );
  if (!explicit || DISABLED_MODE.test(explicit)) {
    return null;
  }
  return explicit;
}

function detectProvenance(tags: RawTags, index: Map<string, unknown>) {
  const keys = Object.keys(tags).join(" ");
  const hasManifestKey = PROVENANCE_TAG.test(keys);
  const issuer = pick(
    index,
    "ClaimGenerator",
    "C2PAIssuer",
    "Signer",
    "CertificateSubject"
  );
  const fileType = pick(index, "FileType");
  let status: ProvenanceStatus = "unknown";
  if (hasManifestKey) {
    status = "present_unverified";
  } else if (fileType && PROVENANCE_CAPABLE_FILE.test(fileType)) {
    status = "not_detected";
  }
  return { issuer, status };
}

export function sanitizeVendorTags(tags: RawTags): RawTags {
  return Object.fromEntries(
    Object.entries(tags).filter(
      ([key, value]) =>
        !SENSITIVE_TAG.test(key) && key !== "SourceFile" && value !== undefined
    )
  );
}

export function normalizeAdvancedExif(tags: RawTags): PhotoMetadata {
  const index = tagIndex(tags);
  const make = pick(index, "Make", "CameraMake");
  const provenance = detectProvenance(tags, index);
  const eyeDetection = asBoolean(
    pick(index, "EyeDetection", "EyeAF", "EyeDetect", "EyeDetectionMode")
  );
  const tracking = asBoolean(
    pick(index, "Tracking", "AFTracking", "SubjectTracking")
  );
  const burstGroup = trustedBurstGroup(index);
  const driveMode = pick(index, "DriveMode", "ContinuousDrive", "ReleaseMode");
  const burstFrameNumber = parseBurstFrameNumber(index);
  const isContinuousDrive = Boolean(
    driveMode && CONTINUOUS_DRIVE_PATTERN.test(driveMode)
  );
  let burstSignalConfidence: "high" | "medium" | null = null;
  if (burstGroup.burstGroupId) {
    burstSignalConfidence = "high";
  } else if (isContinuousDrive && burstFrameNumber !== null) {
    burstSignalConfidence = "medium";
  }

  return {
    vendor: normalizeCameraVendor(make),
    standard: {
      exposureProgram: pick(index, "ExposureProgram", "ExposureMode"),
      meteringMode: pick(index, "MeteringMode", "MeteringMode2"),
      whiteBalance: pick(index, "WhiteBalance", "WhiteBalanceMode"),
      flashMode: pick(index, "Flash", "FlashMode"),
      colorSpace: pick(index, "ColorSpace", "ProfileDescription"),
    },
    capture: {
      captureMode: pick(
        index,
        "SceneCaptureType",
        "ShootingMode",
        "CaptureMode"
      ),
      driveMode,
      // This remains display-only. Values such as SequenceNumber and BurstMode
      // are not reliable evidence that frames belong to one burst.
      burstSequence: pick(index, "SequenceNumber", "BurstMode", "PreCapture"),
      burstGroupId: burstGroup.burstGroupId,
      burstSignalSource: burstGroup.burstSignalSource,
      burstSignalConfidence,
      burstFrameNumber,
      isContinuousDrive,
      captureTimestampMs: parseCaptureTimestampMs(index),
    },
    autofocus: {
      focusMode: pick(index, "FocusMode", "AFMode", "FocusMode2"),
      focusArea: pick(index, "FocusArea", "AFAreaMode", "FocusAreaMode"),
      subjectTarget: pick(
        index,
        "SubjectDetection",
        "SubjectRecognition",
        "DetectSubject",
        "RecognitionTarget"
      ),
      eyeDetection,
      tracking,
    },
    processing: {
      inCameraLook: pick(
        index,
        "FilmMode",
        "FilmSimulation",
        "CreativeLook",
        "PictureControlName",
        "PictureStyle",
        "PhotoStyle",
        "LUTName",
        "ColorMode"
      ),
      stabilizationMode: pick(
        index,
        "ImageStabilization",
        "VibrationReduction",
        "Stabilization",
        "IBIS"
      ),
      computationalMode: detectComputationalMode(index),
      lensCorrection: pick(
        index,
        "LensCorrection",
        "DistortionCorrection",
        "PeripheralIlluminationCorrection"
      ),
    },
    workflow: {
      rating: pick(index, "Rating", "RatingPercent"),
      protection: pick(index, "Protected", "ImageProtection"),
      software: pick(index, "Software", "CreatorTool"),
      artist: pick(index, "Artist", "Creator"),
      copyright: pick(index, "Copyright", "Rights"),
    },
    provenance,
    vendorRaw: sanitizeVendorTags(tags),
  };
}
