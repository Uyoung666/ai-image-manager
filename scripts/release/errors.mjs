/** Error type used by the release CLI so callers can present actionable text. */
export class ReleaseError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "ReleaseError";
    this.code = options.code ?? "RELEASE_ERROR";
  }
}

export function invariant(condition, message, code = "RELEASE_ERROR") {
  if (!condition) {
    throw new ReleaseError(message, { code });
  }
}
