import { os } from "@orpc/server";
import {
  getAdvancedExifProgress,
  pauseAdvancedExifEnrichment,
  resumeAdvancedExifEnrichment,
  retryAdvancedExifFailures,
  scheduleAdvancedExifEnrichment,
} from "@/services/advanced-exif";

export const getAdvancedExifStatus = os.handler(() =>
  getAdvancedExifProgress()
);
export const pauseAdvancedExif = os.handler(() =>
  pauseAdvancedExifEnrichment()
);
export const resumeAdvancedExif = os.handler(() =>
  resumeAdvancedExifEnrichment()
);
export const retryAdvancedExif = os.handler(() => retryAdvancedExifFailures());
export const startAdvancedExif = os.handler(() => {
  scheduleAdvancedExifEnrichment(0);
  return getAdvancedExifProgress();
});
