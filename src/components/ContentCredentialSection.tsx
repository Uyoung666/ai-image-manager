import { CheckCircle2, ChevronRight, CircleAlert } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { contentCredentialActions } from "@/actions/content-credentials";
import { Button } from "@/components/ui/button";
import {
  type ContentCredentialVerification,
  type PhotoProvenance,
  supportsContentCredentialVerification,
} from "@/types/photo-metadata";

interface ContentCredentialSectionProps {
  photo: { format?: string; id: number; path: string };
  provenance?: PhotoProvenance;
}

type CheckedCredential = Extract<
  ContentCredentialVerification,
  { status: "checked" }
>;

const CHECKS = ["signature", "binding", "trust"] as const;
const VERIFICATION_UPDATED = "content-credential-verification-updated";

function shouldOpenDetails(result: ContentCredentialVerification | null) {
  return (
    result?.status === "checked" &&
    CHECKS.some((check) => result[check] !== "passed")
  );
}

function credentialSummary(result: CheckedCredential) {
  if (CHECKS.every((check) => result[check] === "passed")) {
    return "metadataCredentialSummary_passed";
  }
  if (
    result.signature === "passed" &&
    result.binding === "passed" &&
    result.trust === "failed"
  ) {
    return "metadataCredentialSummary_untrusted";
  }
  if (CHECKS.some((check) => result[check] === "failed")) {
    return "metadataCredentialSummary_failed";
  }
  return "metadataCredentialSummary_undetermined";
}

function CredentialSummary({ result }: { result: CheckedCredential }) {
  const { t } = useTranslation();
  const summary = credentialSummary(result);
  const passed = summary === "metadataCredentialSummary_passed";
  const Icon = passed ? CheckCircle2 : CircleAlert;
  return (
    <p
      className={`flex items-start gap-1.5 font-medium ${passed ? "text-success" : "text-warning"}`}
    >
      <Icon aria-hidden="true" className="mt-px size-4 shrink-0" />
      <span className="min-w-0">{t(summary)}</span>
    </p>
  );
}

export function ContentCredentialSection({
  photo,
  provenance,
}: ContentCredentialSectionProps) {
  const { t } = useTranslation();
  const [available, setAvailable] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<
    (ContentCredentialVerification & { stamp?: string }) | undefined
  >();
  const requestVersion = useRef(0);
  const format = photo.format || photo.path.split(".").at(-1) || "";
  const supported = supportsContentCredentialVerification(format);
  const { id } = photo;

  useEffect(() => {
    if (supported) {
      contentCredentialActions
        .available()
        .then(setAvailable, () => setAvailable(false));
    }
  }, [supported]);

  useEffect(() => {
    if (!available) {
      return;
    }
    let active = true;
    const load = () => {
      const version = ++requestVersion.current;
      contentCredentialActions.saved(id).then(
        (saved) => {
          if (active && requestVersion.current === version) {
            setResult(saved ?? undefined);
            setDetailsOpen(shouldOpenDetails(saved));
          }
        },
        () => undefined
      );
    };
    const onUpdate = (event: Event) => {
      const { detail } = event as CustomEvent<{ id: number; origin: object }>;
      if (detail.id === id && detail.origin !== requestVersion) {
        load();
      }
    };
    load();
    window.addEventListener(VERIFICATION_UPDATED, onUpdate);
    return () => {
      active = false;
      window.removeEventListener(VERIFICATION_UPDATED, onUpdate);
    };
  }, [available, id]);

  useEffect(() => {
    if (!result?.stamp) {
      return;
    }
    const stamp = result.stamp;
    const refresh = () => {
      const invalidate = () =>
        setResult((previous) =>
          previous?.stamp === stamp ? { status: "file_changed" } : previous
        );
      contentCredentialActions.current(id, stamp).then((current) => {
        if (!current) {
          invalidate();
        }
      }, invalidate);
    };
    const timer = window.setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [result?.stamp, id]);

  if (!(provenance || (supported && available))) {
    return null;
  }
  const found = provenance?.status === "present_unverified";
  const checked = result?.status === "checked" ? result : undefined;
  const retry = Boolean(result);
  const actionLabel = retry
    ? "metadataCredentialVerifyAgain"
    : "metadataCredentialVerify";
  const verify = async () => {
    requestVersion.current++;
    setRunning(true);
    setResult(undefined);
    setDetailsOpen(false);
    try {
      const nextResult = await contentCredentialActions.verify(id);
      setResult(nextResult);
      setDetailsOpen(shouldOpenDetails(nextResult));
      if (nextResult.stamp) {
        window.dispatchEvent(
          new CustomEvent(VERIFICATION_UPDATED, {
            detail: { id, origin: requestVersion },
          })
        );
      }
    } catch {
      setResult({ status: "error" });
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="min-w-0 space-y-1.5">
      <h4 className="font-medium text-[11px] uppercase tracking-wider opacity-70">
        {t("metadataProvenance")}
      </h4>
      <div aria-live="polite" className="text-xs">
        {checked && <CredentialSummary result={checked} />}
        {result && result.status !== "checked" && (
          <p>{t(`metadataCredentialResult_${result.status}`)}</p>
        )}
        {provenance && !(result || running) && (
          <p>{t(`metadataProvenance_${provenance.status}`)}</p>
        )}
      </div>
      {provenance?.generator && (
        <p className="text-xs [overflow-wrap:anywhere]">
          <span className="opacity-75">{t("metadataCredentialGenerator")}</span>
          {" · "}
          {provenance.generator}
        </p>
      )}
      {found && !(result || running) && (
        <p className="text-[11px] opacity-75">
          {t(
            provenance.legacy
              ? "metadataProvenanceLegacy"
              : "metadataProvenanceDisclaimer"
          )}
        </p>
      )}
      <Collapsible.Root onOpenChange={setDetailsOpen} open={detailsOpen}>
        <div className="flex flex-wrap items-center gap-1">
          {checked && (
            <Collapsible.Trigger asChild>
              <Button
                className="group h-auto min-h-7 max-w-full whitespace-normal"
                type="button"
                variant="ghost"
              >
                <ChevronRight
                  aria-hidden="true"
                  className="group-data-[state=open]:rotate-90"
                />
                {t("metadataCredentialDetails")}
              </Button>
            </Collapsible.Trigger>
          )}
          {supported && available && (
            <Button
              className="h-auto min-h-7 max-w-full whitespace-normal"
              disabled={running}
              onClick={verify}
              type="button"
              variant={retry ? "ghost" : "outline"}
            >
              <span aria-live="polite">
                {t(running ? "metadataCredentialVerifying" : actionLabel)}
              </span>
            </Button>
          )}
        </div>
        {checked && (
          <Collapsible.Content asChild>
            <dl className="mt-1.5 space-y-1 text-xs">
              {CHECKS.map((check) => (
                <div
                  className="flex flex-wrap justify-between gap-x-2"
                  key={check}
                >
                  <dt>{t(`metadataCredentialCheck_${check}`)}</dt>
                  <dd>{t(`metadataCredentialCheck_${checked[check]}`)}</dd>
                </div>
              ))}
            </dl>
          </Collapsible.Content>
        )}
      </Collapsible.Root>
    </section>
  );
}
