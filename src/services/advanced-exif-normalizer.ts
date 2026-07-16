import type { PhotoMetadata, ProvenanceStatus } from "@/types/photo-metadata";

type RawTags = Record<string, unknown>;

const SENSITIVE_TAG = /serial|ownername|ownerid|deviceid/i;
const TRUE_VALUE = /^(true|yes|on|enabled|active|1)$/;
const FALSE_VALUE = /^(false|no|off|disabled|inactive|0|none)$/;
const DISABLED_MODE = /^(off|none|no|0)$/i;
const PROVENANCE_TAG = /c2pa|jumbf|content.?credential|claim.?generator/i;
const PROVENANCE_CAPABLE_FILE =
  /^(jpeg|jpg|png|webp|heic|heif|avif|tiff|dng)$/i;

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
      driveMode: pick(index, "DriveMode", "ContinuousDrive", "ReleaseMode"),
      burstSequence: pick(index, "SequenceNumber", "BurstMode", "PreCapture"),
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
