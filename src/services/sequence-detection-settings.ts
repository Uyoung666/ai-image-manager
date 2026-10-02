import { getSetting } from "@/services/settings-manager";
import {
  defaultSequenceDetectionSettings,
  normalizeSequenceDetectionSettings,
} from "@/types/sequence-detection-settings";

export function getSequenceDetectionSettings() {
  try {
    return normalizeSequenceDetectionSettings(
      JSON.parse(getSetting("sequence.detection.settings") ?? "null")
    );
  } catch {
    return { ...defaultSequenceDetectionSettings };
  }
}
