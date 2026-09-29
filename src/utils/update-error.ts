import { UPDATE_ERROR_KEYS, type UpdateErrorCode } from "@/types/update";

const LOCK_ERROR_RE = /acquire.*lock|another.*instance|mutex/i;
const PACKAGE_ERROR_RE =
  /checksum|checksummed file size|hash.*mismatch|size doesn't match/i;
const HTTP_ERROR_RE =
  /HTTP_STATUS_(?:403|404|429)\b|(?:HTTP(?:\/\d(?:\.\d)?)?\s*(?:status(?:\s+code)?\s*[:=]?\s*)?|status(?:\s+code)?\s*[:=]?\s*)(?:403|404|429)\b|\((?:403|404|429)\)\s*(?:forbidden|not found|too many requests)|\b(?:403\s+forbidden|404\s+not found|429\s+too many requests)\b/i;
const RATE_LIMITED_RE = /429|too many requests/i;
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
  if (HTTP_ERROR_RE.test(raw)) {
    if (RATE_LIMITED_RE.test(raw)) {
      return "UPDATE_RATE_LIMITED";
    }
    return "UPDATE_NOT_FOUND";
  }
  if (TLS_ERROR_RE.test(raw)) {
    return "UPDATE_TLS_ERROR";
  }
  if (NETWORK_ERROR_RE.test(raw)) {
    return "NETWORK_ERROR";
  }
  return "UPDATE_UNKNOWN_ERROR";
}
