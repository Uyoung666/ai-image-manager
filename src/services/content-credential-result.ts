import type {
  ContentCredentialVerification,
  CredentialCheck,
} from "@/types/photo-metadata";

interface ValidationCode {
  code?: string;
}

interface ToolResponse {
  active_manifest?: string;
  validation_results?: {
    activeManifest?: {
      success?: ValidationCode[];
      failure?: ValidationCode[];
    };
  };
}

const BINDING_MATCH =
  /^assertion\.(?:dataHash|boxesHash|bmffHash|collectionHash)\.match$/;
const BINDING_MISMATCH =
  /^assertion\.(?:dataHash|boxesHash|bmffHash|collectionHash)\.mismatch$/;
const SIGNATURE_MISMATCH = /^claimSignature\.(?:mismatch|missing)$/;
const SIGNATURE_VALIDATED = /^claimSignature\.validated$/;
const SIGNER_UNTRUSTED = /^signingCredential\.(?:untrusted|revoked|invalid)$/;
const SIGNER_TRUSTED = /^signingCredential\.trusted$/;

export function parseContentCredentialResult(
  stdout: string
): ContentCredentialVerification {
  const result = JSON.parse(stdout) as ToolResponse | null;
  const active = result?.validation_results?.activeManifest;
  if (!(result?.active_manifest && active)) {
    return { status: "error" };
  }
  const check = (passed: RegExp, failed: RegExp): CredentialCheck => {
    if (active.failure?.some(({ code }) => failed.test(code ?? ""))) {
      return "failed";
    }
    return active.success?.some(({ code }) => passed.test(code ?? ""))
      ? "passed"
      : "unknown";
  };
  return {
    status: "checked",
    binding: check(BINDING_MATCH, BINDING_MISMATCH),
    signature: check(SIGNATURE_VALIDATED, SIGNATURE_MISMATCH),
    trust: check(SIGNER_TRUSTED, SIGNER_UNTRUSTED),
  };
}

export function contentCredentialToolFailure(
  stderr: string
): ContentCredentialVerification {
  const message = stderr.trim();
  if (message === "Error: No claim found") {
    return { status: "no_credential" };
  }
  if (message.startsWith("Error: must fetch remote manifests from url ")) {
    return { status: "remote" };
  }
  if (message === "Error: Unsupported file type") {
    return { status: "unsupported" };
  }
  return { status: "error" };
}
