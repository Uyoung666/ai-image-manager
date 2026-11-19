import { describe, expect, it } from "vitest";
import {
  contentCredentialToolFailure,
  parseContentCredentialResult,
} from "@/services/content-credential-result";

describe("C2PA tool result", () => {
  it("keeps the active manifest signature, binding, and trust independent", () => {
    expect(
      parseContentCredentialResult(
        JSON.stringify({
          active_manifest: "urn:c2pa:active",
          validation_results: {
            activeManifest: {
              failure: [
                { code: "signingCredential.untrusted" },
                { code: "assertion.dataHash.mismatch" },
              ],
              success: [{ code: "claimSignature.validated" }],
            },
            ingredientDeltas: [
              {
                validationDeltas: {
                  success: [{ code: "assertion.dataHash.match" }],
                },
              },
            ],
          },
        })
      )
    ).toEqual({
      status: "checked",
      signature: "passed",
      binding: "failed",
      trust: "failed",
    });
  });

  it("requires explicit evidence for each successful check", () => {
    expect(
      parseContentCredentialResult(
        '{"active_manifest":"urn:c2pa:active","validation_results":{"activeManifest":{"success":[]}},"validation_state":"Trusted"}'
      )
    ).toEqual({
      status: "checked",
      signature: "unknown",
      binding: "unknown",
      trust: "unknown",
    });
  });

  it("distinguishes an offline remote reference from a missing credential", () => {
    expect(
      contentCredentialToolFailure(
        "Error: must fetch remote manifests from url https://example.invalid/remote.c2pa\r\n"
      )
    ).toEqual({ status: "remote" });
    expect(contentCredentialToolFailure("Error: No claim found")).toEqual({
      status: "no_credential",
    });
  });
});
