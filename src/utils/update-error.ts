import { UPDATE_ERROR_KEYS, type UpdateErrorCode } from "@/types/update";

const LOCK_ERROR_RE =
  /acquire.*lock|another.*instance|mutex|file.*(?:in use|locked)|process.*(?:running|busy)/i;
const PACKAGE_ERROR_RE =
  /checksum|checksummed file size|hash.*mismatch|size doesn't match/i;
const HTTP_STATUS_RE = /HTTP_STATUS_(\d{3})\b/i;
const HTTP_ERROR_RE =
  /(?:HTTP(?:\/\d(?:\.\d)?)?\s*(?:status(?:\s+code)?\s*[:=]?\s*)?|status(?:\s+code)?\s*[:=]?\s*|\()(?<status>\d{3})(?:\)|\b)/i;
// GitHub returns 403 as well as 429 for rate limiting. A bare 403 is an
// access-denied response; only an explicit limit signal is classified as a
// transient rate-limit error.
const RATE_LIMITED_RE =
  /rate[-_ ]?limit|too many requests|x[-_]?ratelimit|retry[-_]?after|secondary rate/i;
const INSTALL_INTERRUPTED_RE =
  /install(?:ation)? interrupted|installer.*(?:crash|exit)|Squirrel update exited|UPDATE_INSTALL_INTERRUPTED/i;
const INSTALL_PERMISSION_RE =
  /permission|access denied|UnauthorizedAccessException|EACCES|EPERM|拒绝访问|权限不足/i;
const INSTALL_DISK_RE =
  /disk full|not enough space|ENOSPC|0x80070070|磁盘空间不足|磁盘已满|没有足够的空间/i;
const TLS_ERROR_RE =
  /TlsStream|AuthenticationException|SecureChannelFailure|TrustFailure|\bTLS\b|\bSSL\b|ERR_CERT_|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY|certificate|身份验证失败|安全通道|证书/i;
const NETWORK_ERROR_RE =
  /ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONN(?:REFUSED|RESET|ABORTED)|EHOSTUNREACH|ENETUNREACH|net::ERR|System\.Net\.(?:WebException|Sockets\.SocketException)|NameResolutionFailure|ConnectFailure|connection.*(?:closed|reset|refused)|基础连接已经关闭/i;

export function updateErrorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return String(error ?? "");
}

/** Shared by the main process and renderer; never returns raw updater output. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: error mapping keeps updater failure precedence explicit
export function classifyUpdateError(error: unknown): UpdateErrorCode {
  const raw = updateErrorText(error);
  if (Object.hasOwn(UPDATE_ERROR_KEYS, raw)) {
    return raw as UpdateErrorCode;
  }
  if (LOCK_ERROR_RE.test(raw)) {
    return "UPDATE_BUSY";
  }
  if (PACKAGE_ERROR_RE.test(raw)) {
    return "UPDATE_PACKAGE_CORRUPT";
  }
  const statusMatch = raw.match(HTTP_STATUS_RE);
  const httpMatch = raw.match(HTTP_ERROR_RE);
  const status = Number(statusMatch?.[1] ?? httpMatch?.groups?.status ?? 0);
  if (status > 0) {
    if (status === 429 || (status === 403 && RATE_LIMITED_RE.test(raw))) {
      return "UPDATE_RATE_LIMITED";
    }
    if (status === 403) {
      return "UPDATE_ACCESS_DENIED";
    }
    if (status === 408) {
      return "NETWORK_ERROR";
    }
    if (status === 404 || status === 410) {
      return "UPDATE_NOT_FOUND";
    }
    if (status >= 500) {
      return "UPDATE_SERVICE_UNAVAILABLE";
    }
  }
  if (INSTALL_DISK_RE.test(raw)) {
    return "UPDATE_INSTALL_DISK_FULL";
  }
  if (INSTALL_PERMISSION_RE.test(raw)) {
    return "UPDATE_INSTALL_ACCESS_DENIED";
  }
  if (HTTP_ERROR_RE.test(raw) && RATE_LIMITED_RE.test(raw)) {
    return "UPDATE_RATE_LIMITED";
  }
  if (TLS_ERROR_RE.test(raw)) {
    return "UPDATE_TLS_ERROR";
  }
  if (NETWORK_ERROR_RE.test(raw)) {
    return "NETWORK_ERROR";
  }
  if (INSTALL_INTERRUPTED_RE.test(raw)) {
    return "UPDATE_INSTALL_INTERRUPTED";
  }
  return "UPDATE_UNKNOWN_ERROR";
}
