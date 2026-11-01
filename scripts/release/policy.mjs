export function validationOnly(env = process.env) {
  const value = env.VALIDATE_ONLY ?? "false";
  if (!["true", "false"].includes(value)) {
    throw new Error("VALIDATE_ONLY must be true or false");
  }
  return value === "true";
}

export function assertBuildAllowed({
  validateOnly,
  sourceRunId,
  existingRelease,
}) {
  if (validateOnly && sourceRunId) {
    throw new Error(
      "Validation-only runs must build from the tag, not recover artifacts"
    );
  }
  if (!(validateOnly || sourceRunId) && existingRelease) {
    throw new Error(
      "This version already has release assets; resume its source run instead of rebuilding"
    );
  }
}

// A validation bundle is never a publication or recovery candidate, even when
// somebody later invokes the CLI directly without the workflow's job guard.
export function assertPublishable(metadata) {
  if (metadata.validateOnly !== undefined && metadata.validateOnly !== false) {
    throw new Error(
      "Validation-only artifacts cannot be published or recovered"
    );
  }
}
