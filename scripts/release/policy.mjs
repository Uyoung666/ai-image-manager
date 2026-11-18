const RUN_ID_PATTERN = /^[1-9]\d*$/;

export function validationOnly(env = process.env) {
  const value = env.VALIDATE_ONLY ?? "false";
  if (!["true", "false"].includes(value)) {
    throw new Error("VALIDATE_ONLY must be true or false");
  }
  return value === "true";
}

export function assertBuildAllowed({
  validateOnly,
  prepareCandidate,
  publishRelease = false,
  sourceRunId,
  existingRelease,
}) {
  if (prepareCandidate && (validateOnly || sourceRunId)) {
    throw new Error(
      "Candidate preparation, validation and recovery are mutually exclusive"
    );
  }
  if (validateOnly && sourceRunId) {
    throw new Error(
      "Validation-only runs must build from the tag, not recover artifacts"
    );
  }
  if (publishRelease || sourceRunId) {
    assertPublicationRequested({ publishRelease, sourceRunId });
  }
  if (!(validateOnly || sourceRunId) && existingRelease) {
    throw new Error(
      "This version already has release assets; resume its source run instead of rebuilding"
    );
  }
}

export function assertPublicationRequested({ publishRelease, sourceRunId }) {
  if (publishRelease !== true || !RUN_ID_PATTERN.test(sourceRunId ?? "")) {
    throw new Error(
      "Publication requires publish_release and an accepted candidate source_run_id"
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
