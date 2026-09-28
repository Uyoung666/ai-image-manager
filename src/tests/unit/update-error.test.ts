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
    ["HTTP/1.1 403 Forbidden", "UPDATE_NOT_FOUND"],
    ["status code: 404", "UPDATE_NOT_FOUND"],
    [
      "Checksummed file size doesn't match: file404.nupkg",
      "UPDATE_PACKAGE_CORRUPT",
    ],
    ["Could not acquire lock for update", "UPDATE_BUSY"],
    ["System.IO.IOException: disk full", "UPDATE_UNKNOWN_ERROR"],
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
