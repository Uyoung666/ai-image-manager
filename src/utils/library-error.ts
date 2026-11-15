const KNOWN_ERRORS = new Set([
  "RELINK_EXPIRED",
  "RELINK_STALE",
  "RELINK_CONFLICT",
  "RELINK_BUSY",
  "LIBRARY_TASK_BUSY",
  "RELINK_CONFIRMATION_REQUIRED",
  "LIBRARY_FOLDER_NOT_FOUND",
  "RELINK_NOT_FOUND",
  "LIBRARY_REMOVAL_STALE",
  "LIBRARY_REMOVAL_EXPIRED",
  "RELINK_UNSUPPORTED_FILE",
  "EACCES",
  "EPERM",
  "ENOENT",
  "ETIMEDOUT",
]);
export function libraryErrorKey(error: unknown): string {
  let code = "";
  if (typeof error === "string") {
    code = error;
  }
  if (error instanceof Error) {
    code = error.message;
  }
  return KNOWN_ERRORS.has(code)
    ? `libraryReliability.errors.${code}`
    : "libraryReliability.error";
}
