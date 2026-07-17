export type AdvancedExifFilterField =
  | "vendor"
  | "captureMode"
  | "exposureProgram"
  | "meteringMode"
  | "whiteBalance"
  | "focusMode"
  | "subjectTarget"
  | "driveMode"
  | "stabilizationMode"
  | "computationalMode"
  | "inCameraLook"
  | "provenanceStatus";

export interface ExifFilters {
  advancedField?: AdvancedExifFilterField;
  advancedValue?: string;
  apertureMax?: string;
  apertureMin?: string;
  cameraModel?: string;
  dateFrom?: string;
  dateTo?: string;
  focalMax?: string;
  focalMin?: string;
  isoMax?: string;
  isoMin?: string;
  lensModel?: string;
  shutterMax?: string;
  shutterMin?: string;
}

export type SearchMode = "text" | "image" | "exif" | "color";

export interface SearchCriteria {
  colorHex?: string;
  filters: ExifFilters;
  mode: SearchMode;
  query: string;
}
