import { CheckCircle2, MinusCircle, XCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/ipc/manager";

// ── Types ────────────────────────────────────────────────────────────

type DetectPhase =
  | "idle"
  | "checking"
  | "detected-ok"
  | "detected-unsupported"
  | "detected-error";

interface GpuDetectedInfo {
  dmlAvailable: boolean;
  embeddingDmlAvailable?: boolean;
  embeddingError?: string;
  embeddingProbeTimeMs?: number;
  error?: string;
  gpuName?: string;
  probeTimeMs: number;
  timestamp?: number;
}

interface GpuSettingsResponse {
  detected: GpuDetectedInfo | null;
  enabled: boolean;
  promptShown: boolean;
}

type GpuCapabilityResponse = GpuDetectedInfo;

// ── Sub-components ───────────────────────────────────────────────────

function FeatureStatusRow({
  active,
  label,
  statusKey,
}: {
  active: boolean;
  label: string;
  statusKey?: string;
}) {
  const { t } = useTranslation();
  const resolvedStatusKey =
    statusKey ?? (active ? "gpuStatusActive" : "gpuStatusInactive");
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px]">
      {active ? (
        <CheckCircle2 className="h-3 w-3 text-green-600 dark:text-green-400" />
      ) : (
        <MinusCircle className="h-3 w-3 text-muted-foreground/45" />
      )}
      <span className="text-muted-foreground/70">{label}</span>
      <span className="text-muted-foreground/40">{t(resolvedStatusKey)}</span>
    </div>
  );
}

function DetectionStatusLine({
  detectError,
  detectPhase,
  probeTimeMs,
}: {
  detectError: string;
  detectPhase: DetectPhase;
  probeTimeMs?: number;
}) {
  const { t } = useTranslation();

  if (detectPhase === "idle") {
    return (
      <p className="text-[11px] text-muted-foreground/50">
        {t("gpuNotDetected")}
      </p>
    );
  }

  if (detectPhase === "checking") {
    return (
      <div className="flex items-center gap-2">
        <LoadingSpinner size="sm" variant="secondary" />
        <span className="text-[12px] text-muted-foreground">
          {t("gpuDetecting")}
        </span>
      </div>
    );
  }

  if (detectPhase === "detected-ok") {
    return (
      <div>
        <div className="flex items-center gap-2">
          <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400" />
          <span className="text-[12px] text-muted-foreground">
            {t("gpuDetectedOk")}
          </span>
          {probeTimeMs !== undefined && (
            <span className="text-[11px] text-muted-foreground/40">
              {probeTimeMs}ms
            </span>
          )}
        </div>
      </div>
    );
  }

  if (detectPhase === "detected-unsupported") {
    return (
      <div>
        <div className="flex items-center gap-2">
          <MinusCircle className="h-3.5 w-3.5 text-muted-foreground/50" />
          <span className="text-[12px] text-muted-foreground">
            {t("gpuDetectedUnsupported")}
          </span>
        </div>
        {detectError && (
          <p className="mt-1 text-[11px] text-muted-foreground/50 [overflow-wrap:anywhere]">
            {detectError}
          </p>
        )}
      </div>
    );
  }

  // detected-error
  return (
    <div>
      <div className="flex items-center gap-2">
        <XCircle className="h-3.5 w-3.5 text-destructive" />
        <span className="text-[12px] text-destructive">
          {t("gpuDetectedError")}
        </span>
      </div>
      {detectError && (
        <p className="mt-1 text-[11px] text-destructive/70 [overflow-wrap:anywhere]">
          {detectError}
        </p>
      )}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────

function getDetectButtonLabel(
  detectPhase: DetectPhase,
  t: (key: string) => string
): string {
  if (detectPhase === "checking") {
    return t("gpuDetecting");
  }
  if (
    detectPhase === "detected-error" ||
    detectPhase === "detected-unsupported"
  ) {
    return t("gpuRetryDetect");
  }
  return t("gpuDetect");
}

// ── Main component ───────────────────────────────────────────────────

export function GpuSettingsCard({
  hideTitle = false,
  hideSaveButton = false,
  onBusyChange,
  onEnabledChange,
  onLoaded,
}: {
  hideTitle?: boolean;
  hideSaveButton?: boolean;
  onBusyChange?: (busy: boolean) => void;
  onEnabledChange?: (enabled: boolean) => void;
  onLoaded?: () => void;
}) {
  const { t } = useTranslation();

  const [enabled, setEnabled] = useState(false);
  const [detectPhase, setDetectPhase] = useState<DetectPhase>("idle");
  const [detectedInfo, setDetectedInfo] = useState<GpuDetectedInfo | null>(
    null
  );
  const [detectError, setDetectError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [saving, setSaving] = useState(false);

  // ── Load saved state on mount ──────────────────────────────────────

  useEffect(() => {
    ipc.client.settings
      .getGpuSettings({})
      .then((value) => {
        const r = value as unknown as GpuSettingsResponse;
        setEnabled(r.enabled);
        onEnabledChange?.(r.enabled);
        if (r.detected) {
          setDetectedInfo(r.detected);
          setDetectPhase(
            r.detected.dmlAvailable || r.detected.embeddingDmlAvailable
              ? "detected-ok"
              : "detected-unsupported"
          );
          if (r.detected.error) {
            setDetectError(r.detected.error);
          }
        } else {
          setDetectPhase("idle");
        }
      })
      .catch((err: unknown) => {
        setDetectPhase("detected-error");
        setDetectError(
          (err as { message?: string })?.message || t("gpuDetectedError")
        );
      })
      .finally(() => onLoaded?.());
  }, [onEnabledChange, onLoaded, t]);

  // ── GPU detection ──────────────────────────────────────────────────

  const handleDetect = useCallback(async () => {
    setDetectPhase("checking");
    setDetectError("");
    onBusyChange?.(true);
    try {
      const result = (await ipc.client.settings.checkGpuCapability(
        {}
      )) as GpuCapabilityResponse;
      setDetectedInfo(result);
      if (result.dmlAvailable || result.embeddingDmlAvailable) {
        setDetectPhase("detected-ok");
        if (!enabled) {
          setEnabled(true);
          onEnabledChange?.(true);
        }
      } else {
        setDetectPhase("detected-unsupported");
        if (result.error) {
          setDetectError(result.error);
        }
      }
    } catch (err: unknown) {
      setDetectPhase("detected-error");
      setDetectError(
        (err as { message?: string })?.message || t("gpuDetectedError")
      );
    } finally {
      onBusyChange?.(false);
    }
  }, [enabled, onBusyChange, onEnabledChange, t]);

  // ── Save ───────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus(t("saving"));
    onBusyChange?.(true);
    try {
      await ipc.client.settings.setGpuSettings({ enabled });
      setSaveStatus(t("gpuSaved"));
      setTimeout(() => setSaveStatus(""), 3000);
    } catch {
      setSaveStatus(t("saveFailed"));
      setEnabled(!enabled);
      onEnabledChange?.(!enabled);
      setTimeout(() => setSaveStatus(""), 3000);
    } finally {
      setSaving(false);
      onBusyChange?.(false);
    }
  }, [enabled, onBusyChange, onEnabledChange, t]);

  const handleEnabledChange = useCallback(
    (nextEnabled: boolean) => {
      setEnabled(nextEnabled);
      onEnabledChange?.(nextEnabled);
    },
    [onEnabledChange]
  );

  const faceGpuActive = enabled && detectedInfo?.dmlAvailable === true;
  const embeddingGpuActive =
    enabled && detectedInfo?.embeddingDmlAvailable === true;
  let embeddingStatusKey = "gpuStatusNotEnabled";
  if (enabled) {
    if (detectPhase === "detected-error" || detectedInfo?.embeddingError) {
      embeddingStatusKey = "gpuStatusProbeFailed";
    } else if (detectedInfo?.embeddingDmlAvailable === true) {
      embeddingStatusKey = "gpuStatusActive";
    } else {
      embeddingStatusKey = "gpuStatusCpuFallback";
    }
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <section className="min-w-0 space-y-3">
      {!hideTitle && (
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("gpuAcceleration")}
        </h2>
      )}

      <div className="min-w-0 space-y-3 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        {/* Toggle row */}
        <div className="flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[13px] text-muted-foreground">
              {t("gpuEnableAcceleration")}
            </span>
            {detectedInfo?.gpuName && (
              <p className="mt-0.5 break-all font-medium text-[11px] text-foreground/80">
                {detectedInfo.gpuName}
              </p>
            )}
          </div>
          <Switch
            ariaLabel={t("gpuEnableAcceleration")}
            checked={enabled}
            disabled={detectPhase === "checking"}
            onCheckedChange={handleEnabledChange}
          />
        </div>

        {/* Feature status */}
        <div className="space-y-1.5 border-border border-t pt-3">
          <FeatureStatusRow active={faceGpuActive} label={t("gpuStatusFace")} />
          <FeatureStatusRow
            active={embeddingGpuActive}
            label={t("gpuStatusEmbed")}
            statusKey={embeddingStatusKey}
          />
        </div>

        {/* Detection status */}
        <div className="border-border border-t pt-3">
          <DetectionStatusLine
            detectError={detectError}
            detectPhase={detectPhase}
            probeTimeMs={detectedInfo?.probeTimeMs}
          />
        </div>

        {/* Action buttons + hint */}
        <div className="flex min-w-0 flex-col items-stretch gap-3 border-border border-t pt-3 min-[900px]:flex-row min-[900px]:items-start min-[900px]:justify-between">
          <p className="min-w-0 pt-1 text-[11px] text-muted-foreground/60 leading-relaxed [overflow-wrap:anywhere]">
            {t("gpuRestartHint")}
          </p>
          <div className="flex max-w-full flex-wrap justify-end gap-2 min-[900px]:shrink-0">
            <button
              className="rounded-[6px] border border-input bg-background px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
              disabled={detectPhase === "checking"}
              onClick={handleDetect}
              type="button"
            >
              {getDetectButtonLabel(detectPhase, t)}
            </button>
            {!hideSaveButton && (
              <button
                className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                disabled={saving}
                onClick={handleSave}
                type="button"
              >
                {saveStatus || t("save")}
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
