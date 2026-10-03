import { describe, expect, it } from "vitest";
import { UPDATE_ERROR_KEYS } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

describe("update error classification", () => {
  it.each([
    [
      "Command failed: 4294967295 System.AggregateException: ���� ---> System.Net.WebException: ���� ---> System.IO.IOException: ���� at System.Net.TlsStream.EndWrite",
      "UPDATE_TLS_ERROR",
    ],
    [
      "System.IO.IOException: 由于远程方已关闭传输流，身份验证失败。",
      "UPDATE_TLS_ERROR",
    ],
    ["System.Net.WebException: ����", "NETWORK_ERROR"],
    ["ECONNRESET", "NETWORK_ERROR"],
    ["ETIMEDOUT", "NETWORK_ERROR"],
    [
      "System.Net.WebException: The remote server returned an error: (404) Not Found",
      "UPDATE_NOT_FOUND",
    ],
    ["HTTP/1.1 403 Forbidden", "UPDATE_ACCESS_DENIED"],
    ["HTTP_STATUS_403", "UPDATE_ACCESS_DENIED"],
    ["HTTP_STATUS_403 x-ratelimit-remaining=0", "UPDATE_RATE_LIMITED"],
    ["status code: 404", "UPDATE_NOT_FOUND"],
    ["HTTP_STATUS_408", "NETWORK_ERROR"],
    ["HTTP_STATUS_410", "UPDATE_NOT_FOUND"],
    ["HTTP_STATUS_429", "UPDATE_RATE_LIMITED"],
    ["HTTP_STATUS_503", "UPDATE_SERVICE_UNAVAILABLE"],
    ["HTTP/1.1 503 Service Unavailable", "UPDATE_SERVICE_UNAVAILABLE"],
    [
      "Checksummed file size doesn't match: file404.nupkg",
      "UPDATE_PACKAGE_CORRUPT",
    ],
    ["Could not acquire lock for update", "UPDATE_BUSY"],
    ["System.IO.IOException: disk full", "UPDATE_INSTALL_DISK_FULL"],
    [
      "Squirrel update exited with code 5: access denied",
      "UPDATE_INSTALL_ACCESS_DENIED",
    ],
    ["Command failed: 4294967295 ����", "UPDATE_UNKNOWN_ERROR"],
    ["failed at C:/403/404.txt", "UPDATE_UNKNOWN_ERROR"],
    [undefined, "UPDATE_UNKNOWN_ERROR"],
  ])("classifies %s as %s without exposing raw text", (input, expected) => {
    expect(classifyUpdateError(input)).toBe(expected);
    expect(classifyUpdateError(new Error(input))).toBe(expected);
  });

  it.each(
    Object.keys(UPDATE_ERROR_KEYS)
  )("preserves the known code %s", (code) => {
    expect(classifyUpdateError(code)).toBe(code);
  });
});
