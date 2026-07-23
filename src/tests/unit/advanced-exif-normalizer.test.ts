import { describe, expect, it } from "vitest";
import {
  normalizeAdvancedExif,
  normalizeCameraVendor,
  sanitizeVendorTags,
} from "@/services/advanced-exif-normalizer";

describe("advanced EXIF normalization", () => {
  it.each([
    ["Canon", "Canon"],
    ["NIKON CORPORATION", "Nikon"],
    ["SONY", "Sony"],
    ["FUJIFILM", "Fujifilm"],
    ["Panasonic", "Panasonic"],
    ["LEICA CAMERA AG", "Leica"],
    ["OM Digital Solutions", "OM System"],
    ["OLYMPUS IMAGING CORP.", "OM System"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeCameraVendor(input)).toBe(expected);
  });

  it("maps grouped Canon maker tags into shared semantics", () => {
    const result = normalizeAdvancedExif({
      "IFD0:Make": "Canon",
      "ExifIFD:ExposureProgram": "Manual",
      "Canon:MeteringMode": "Evaluative",
      "Canon:AFMode": "Servo AF",
      "Canon:DetectSubject": "Animals",
      "Canon:EyeDetection": "On",
      "Canon:DriveMode": "High-speed continuous +",
      "Canon:ImageStabilization": "On",
      "Canon:PictureStyle": "Fine Detail",
    });

    expect(result.vendor).toBe("Canon");
    expect(result.standard.exposureProgram).toBe("Manual");
    expect(result.standard.meteringMode).toBe("Evaluative");
    expect(result.autofocus.focusMode).toBe("Servo AF");
    expect(result.autofocus.subjectTarget).toBe("Animals");
    expect(result.autofocus.eyeDetection).toBe(true);
    expect(result.capture.driveMode).toBe("High-speed continuous +");
    expect(result.processing.stabilizationMode).toBe("On");
  });

  it.each([
    ["Nikon", "Nikon:PictureControlName", "Vivid"],
    ["Sony", "Sony:CreativeLook", "ST"],
    ["Fujifilm", "FujiFilm:FilmSimulation", "Classic Chrome"],
    ["Panasonic", "Panasonic:PhotoStyle", "Cinelike D2"],
    ["Leica", "Leica:ColorMode", "Leica Looks"],
    ["OM System", "Olympus:LiveND", "ND16"],
  ])("normalizes a representative %s tag", (vendor, key, value) => {
    const tags = { "IFD0:Make": vendor, [key]: value };
    const result = normalizeAdvancedExif(tags);
    expect(
      result.processing.inCameraLook ?? result.processing.computationalMode
    ).toBe(value);
  });

  it("reports C2PA structures without claiming validation", () => {
    const result = normalizeAdvancedExif({
      "IFD0:Make": "Leica",
      "JUMBF:C2PAClaim": "self#jumbf=c2pa.claim",
      "C2PA:ClaimGenerator": "Leica Camera",
    });
    expect(result.provenance).toEqual({
      issuer: "Leica Camera",
      status: "present_unverified",
    });
  });

  it("distinguishes no credential from an unsupported provenance check", () => {
    expect(normalizeAdvancedExif({ FileType: "JPEG" }).provenance.status).toBe(
      "not_detected"
    );
    expect(normalizeAdvancedExif({ FileType: "NEF" }).provenance.status).toBe(
      "unknown"
    );
  });

  it("removes sensitive identifiers from stored raw tags", () => {
    expect(
      sanitizeVendorTags({
        "Canon:CameraSerialNumber": "12345",
        "IFD0:Make": "Canon",
        SourceFile: "C:/private/photo.jpg",
      })
    ).toEqual({ "IFD0:Make": "Canon" });
  });

  it("only promotes an explicit burst group identifier to high-confidence evidence", () => {
    const result = normalizeAdvancedExif({
      DateTimeOriginal: "2026:07:23 12:00:01",
      SubSecTimeOriginal: "123",
      SequenceNumber: "42",
      BurstMode: "On",
      BurstUUID: "burst-abc",
    });

    expect(result.capture.burstSequence).toBe("42");
    expect(result.capture.burstGroupId).toBe("burst-abc");
    expect(result.capture.burstSignalSource).toBe("BurstUUID");
    expect(result.capture.burstSignalConfidence).toBe("high");
    expect(result.capture.captureTimestampMs).toBeTypeOf("number");
  });

  it("records continuous-drive frame numbers as corroborating, not group-id, evidence", () => {
    const result = normalizeAdvancedExif({
      DateTimeOriginal: "2026:07:23 12:00:01",
      SubSecTimeOriginal: "123",
      "Sony:ReleaseMode": "Continuous",
      "Sony:SequenceNumber": 2,
    });

    expect(result.capture.burstGroupId).toBeNull();
    expect(result.capture.burstFrameNumber).toBe(2);
    expect(result.capture.isContinuousDrive).toBe(true);
    expect(result.capture.burstSignalConfidence).toBe("medium");
  });

  it("does not infer a burst group or precise timestamp from weak or second-only tags", () => {
    const result = normalizeAdvancedExif({
      DateTimeOriginal: "2026:07:23 12:00:01",
      SequenceNumber: "42",
      BurstMode: "On",
      DriveMode: "Continuous",
    });

    expect(result.capture.burstGroupId).toBeNull();
    expect(result.capture.burstSignalConfidence).toBe("medium");
    expect(result.capture.captureTimestampMs).toBeNull();
  });
});
