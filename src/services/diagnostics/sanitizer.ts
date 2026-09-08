import path from "node:path";

const MEDIA_FILE_PATTERN =
  /\b[^\s<>:"/\\|?*]+\.(?:jpe?g|png|gif|webp|bmp|svg|avif|tiff?|heic|heif|cr2|cr3|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|rwl|3fr|raw)\b/gi;
const GENERIC_FILE_PATTERN =
  /\b[^\s<>:"/\\|?*]+\.(?:[a-z][a-z0-9._-]{0,11}|7z)\b/gi;
const WINDOWS_PATH_PATTERN =
  /\b[a-zA-Z]:[\\/](?:[^\r\n<>:"|?*]+[\\/])*[^\r\n<>:"|?*]*/g;
const UNC_PATH_PATTERN = /\\\\[^\s\\]+\\[^\r\n<>:"|?*]+/g;
const URL_PATTERN = /\b(?:https?|wss?|s3|webdav):\/\/[^\s"'<>]+/gi;
const LOCAL_URL_PATTERN = /\b(?:file|local-media):\/\/[^\s"'<>]+/gi;
const SENSITIVE_VALUE_PATTERN =
  /\b(token|access[_-]?key|secret|password|passwd|cookie|authorization|api[_-]?key|proxy|prompt|query|search(?:ByText|Term|Text|Query)?|keyword|host(?:name)?|computer[_-]?name|machine[_-]?name|device[_-]?name|user(?:name)?|account[_-]?name)\b((?:\s+called)?["']?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const TRAILING_STACK_PATH_CHARS_PATTERN = /[\s)]+$/;
const UNREDACTED_SECRET_PATTERN =
  /\b(?:password|passwd|authorization|api[_-]?key|access[_-]?key|secret|token|host(?:name)?|computer[_-]?name|machine[_-]?name|device[_-]?name|user(?:name)?|account[_-]?name)["']?\s*[:=]\s*(?!\s|["']?<redacted>)/i;
const DYNAMIC_ROUTE_SEGMENT_PATTERN = /^\/(albums|people|cull)\/[^/?#]+/i;
const UUID_ROUTE_SEGMENT_PATTERN = /\/[0-9a-f]{8}-[0-9a-f-]{27,}(?=\/|$)/gi;
const SOURCE_CONTEXT_PATTERN =
  /(?:^|[\s(])(?:src|scripts|\.vite\/build)\/[a-z0-9_./-]*$/i;
const ROUTE_SUFFIX_PATTERN = /[?#]/;
const POTENTIAL_WINDOWS_PATH_PATTERN = /\b[a-zA-Z]:[\\/][^\r\n]+/;
const POTENTIAL_UNC_PATH_PATTERN = /\\\\[^\s\\]+\\[^\r\n]+/;
const URL_SCAN_PATTERN =
  /\b(?:https?|wss?|s3|webdav):\/\/(?:<HOST_\d+>|[^\s"'<>])+/gi;
const REDACTED_URL_PATTERN = /^(?:https?|wss?|s3|webdav):\/\/<HOST_\d+>$/i;
const SENSITIVE_KEY_PATTERN =
  /^(?:token|access[_-]?key|secret|password|passwd|cookie|authorization|api[_-]?key|proxy|prompt|query|search(?:ByText|Term|Text|Query)?|keyword|host(?:name)?|computer[_-]?name|machine[_-]?name|device[_-]?name|user(?:name)?|account[_-]?name)$/i;

function replaceApplicationPath(value: string): string | null {
  const normalized = value.replaceAll("\\", "/");
  const sourceIndex = normalized.toLowerCase().lastIndexOf("/src/");
  if (sourceIndex >= 0) {
    return normalized
      .slice(sourceIndex + 1)
      .replace(TRAILING_STACK_PATH_CHARS_PATTERN, "");
  }
  const asarIndex = normalized.toLowerCase().lastIndexOf("/app.asar/");
  if (asarIndex >= 0) {
    return normalized
      .slice(asarIndex + "/app.asar/".length)
      .replace(TRAILING_STACK_PATH_CHARS_PATTERN, "");
  }
  return null;
}

export class DiagnosticSanitizer {
  private readonly replacements = new Map<string, string>();
  private pathIndex = 0;
  private fileIndex = 0;
  private hostIndex = 0;

  sanitize(value: string): string {
    let sanitized = value.replace(
      SENSITIVE_VALUE_PATTERN,
      (_match, key: string, separator: string, rawValue: string) => {
        let quote = "";
        if (rawValue.startsWith('"')) {
          quote = '"';
        } else if (rawValue.startsWith("'")) {
          quote = "'";
        }
        return `${key}${separator}${quote}<REDACTED>${quote}`;
      }
    );

    sanitized = sanitized.replace(LOCAL_URL_PATTERN, (match) => {
      try {
        return (
          replaceApplicationPath(decodeURIComponent(match)) ??
          this.tokenFor(match, "PATH")
        );
      } catch {
        return this.tokenFor(match, "PATH");
      }
    });
    sanitized = sanitized.replace(URL_PATTERN, (match) => {
      try {
        const parsed = new URL(match);
        if (parsed.hostname.toLowerCase() === "github.com") {
          return `${parsed.protocol}//github.com`;
        }
        return `${parsed.protocol}//${this.tokenFor(parsed.hostname, "HOST")}`;
      } catch {
        return this.tokenFor(match, "HOST");
      }
    });

    sanitized = sanitized.replace(WINDOWS_PATH_PATTERN, (match) => {
      const sourcePath = replaceApplicationPath(match);
      return sourcePath ?? this.tokenFor(match.trim(), "PATH");
    });
    sanitized = sanitized.replace(UNC_PATH_PATTERN, (match) =>
      this.tokenFor(match.trim(), "PATH")
    );
    sanitized = sanitized.replace(/([\\/]Users[\\/])[^\\/\s]+/gi, "$1<USER>");
    sanitized = sanitized.replace(MEDIA_FILE_PATTERN, (match) => {
      const extension = path.extname(match).toLowerCase();
      return `${this.tokenFor(match, "FILE")}${extension}`;
    });
    sanitized = sanitized.replace(
      GENERIC_FILE_PATTERN,
      (match, offset: number, source: string) => {
        const prefix = source
          .slice(Math.max(0, offset - 240), offset)
          .replaceAll("\\", "/");
        if (SOURCE_CONTEXT_PATTERN.test(prefix)) {
          return match;
        }
        const extension = path.extname(match).toLowerCase();
        return `${this.tokenFor(match, "FILE")}${extension}`;
      }
    );
    return sanitized;
  }

  sanitizeJson(value: unknown): string {
    try {
      return JSON.stringify(this.sanitizeValue(value), null, 2);
    } catch {
      return this.sanitize(String(value));
    }
  }

  // Work on decoded fields so escaped quotes and newlines in JSON cannot
  // truncate a stack trace or leave half of a credential in the output.
  sanitizeValue(value: unknown, forbiddenValues: string[] = []): unknown {
    if (typeof value === "string") {
      const sanitized = this.sanitize(value);
      return containsPotentialSensitiveData(sanitized, forbiddenValues)
        ? "<REDACTED>"
        : sanitized;
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item, forbiddenValues));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          this.sanitizeValue(key, forbiddenValues),
          SENSITIVE_KEY_PATTERN.test(key)
            ? "<REDACTED>"
            : this.sanitizeValue(item, forbiddenValues),
        ])
      );
    }
    return value;
  }

  private tokenFor(value: string, kind: "FILE" | "HOST" | "PATH"): string {
    const existing = this.replacements.get(`${kind}:${value}`);
    if (existing) {
      return existing;
    }
    let index: number;
    if (kind === "FILE") {
      index = ++this.fileIndex;
    } else if (kind === "HOST") {
      index = ++this.hostIndex;
    } else {
      index = ++this.pathIndex;
    }
    const token = `<${kind}_${index}>`;
    this.replacements.set(`${kind}:${value}`, token);
    return token;
  }
}

export function sanitizeRendererRoute(route: string): string {
  const withoutQuery = route.split(ROUTE_SUFFIX_PATTERN, 1)[0] || "/";
  return withoutQuery
    .replace(DYNAMIC_ROUTE_SEGMENT_PATTERN, "/$1/:id")
    .replace(UUID_ROUTE_SEGMENT_PATTERN, "/:id")
    .slice(0, 256);
}

export function containsPotentialSensitiveData(
  value: string,
  forbiddenValues: string[] = []
): boolean {
  const lower = value.toLowerCase();
  if (UNREDACTED_SECRET_PATTERN.test(value)) {
    return true;
  }
  if (
    POTENTIAL_WINDOWS_PATH_PATTERN.test(value) ||
    POTENTIAL_UNC_PATH_PATTERN.test(value)
  ) {
    return true;
  }
  for (const rawUrl of value.match(URL_SCAN_PATTERN) ?? []) {
    if (REDACTED_URL_PATTERN.test(rawUrl)) {
      continue;
    }
    try {
      const parsed = new URL(rawUrl);
      if (
        parsed.hostname.toLowerCase() !== "github.com" ||
        parsed.username ||
        parsed.password ||
        (parsed.pathname !== "/" && parsed.pathname !== "") ||
        parsed.search ||
        parsed.hash
      ) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return forbiddenValues.some((item) => {
    const normalized = item.trim().toLowerCase();
    return normalized.length >= 3 && lower.includes(normalized);
  });
}
