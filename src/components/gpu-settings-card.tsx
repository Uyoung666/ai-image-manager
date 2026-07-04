import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  check,
  label,
}: {
  active: boolean;
  check: string;
  label: string;
}) {
  const { t } = useTranslation();
  const statusKey = active ? "gpuStatusActive" : "gpuStatusInactive";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span
        className={
          active
            ? "text-green-600 dark:text-green-400"
            : "text-muted-foreground/50"
        }
      >
        {check}
      </span>
      <span className="text-muted-foreground/70">{label}</span>
      <span className="text-muted-foreground/40">{t(statusKey)}</span>
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
        <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
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
          <span className="text-[12px] text-green-600 dark:text-green-400">
            ✓
          </span>
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
          <span className="text-[12px] text-muted-foreground/50">✗</span>
          <span className="text-[12px] text-muted-foreground">
            {t("gpuDetectedUnsupported")}
          </span>
        </div>
        {detectError && (
          <p className="mt-1 text-[11px] text-muted-foreground/50">
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
        <span className="text-[12px] text-destructive">✗</span>
        <span className="text-[12px] text-destructive">
          {t("gpuDetectedError")}
        </span>
      </div>
      {detectError && (
        <p className="mt-1 text-[11px] text-destructive/70">{detectError}</p>
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
}: {
  hideTitle?: boolean;
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
    ipc.client.settings.getGpuSettings({}).then((r: GpuSettingsResponse) => {
      setEnabled(r.enabled);
      if (r.detected) {
        setDetectedInfo(r.detected);
        setDetectPhase(
          r.detected.dmlAvailable ? "detected-ok" : "detected-unsupported"
        );
        if (r.detected.error) {
          setDetectError(r.detected.error);
        }
      } else {
        setDetectPhase("idle");
      }
    });
  }, []);

  // ── GPU detection ──────────────────────────────────────────────────

  const handleDetect = useCallback(async () => {
    setDetectPhase("checking");
    setDetectError("");
    try {
      const result = (await ipc.client.settings.checkGpuCapability(
        {}
      )) as GpuCapabilityResponse;
      setDetectedInfo(result);
      if (result.dmlAvailable) {
        setDetectPhase("detected-ok");
        if (!enabled) {
          setEnabled(true);
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
    }
  }, [enabled, t]);

  // ── Save ───────────────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    setSaving(true);
    setSaveStatus(t("saving"));
    try {
      await ipc.client.settings.setGpuSettings({ enabled });
      setSaveStatus(t("gpuSaved"));
      setTimeout(() => setSaveStatus(""), 3000);
    } catch {
      setSaveStatus(t("saveFailed"));
      setEnabled(!enabled);
      setTimeout(() => setSaveStatus(""), 3000);
    } finally {
      setSaving(false);
    }
  }, [enabled, t]);

  const gpuActive = enabled && detectPhase === "detected-ok";

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <section className="space-y-3">
      {!hideTitle && (
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("gpuAcceleration")}
        </h2>
      )}

      <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
        {/* Toggle row */}
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[13px] text-muted-foreground">
              {t("gpuEnableAcceleration")}
            </span>
            {detectedInfo?.gpuName && (
              <p className="mt-0.5 font-medium text-[11px] text-foreground/80">
                {detectedInfo.gpuName}
              </p>
            )}
          </div>
          <Switch
            checked={enabled}
            disabled={detectPhase === "checking"}
            onCheckedChange={setEnabled}
          />
        </div>

        {/* Feature status */}
        <div className="space-y-1.5 border-border border-t pt-3">
          <FeatureStatusRow
            active={gpuActive}
            check={gpuActive ? "✓" : "—"}
            label={t("gpuStatusFace")}
          />
          <div className="flex items-center gap-2 text-[11px]">
            <span className="text-muted-foreground/50">—</span>
            <span className="text-muted-foreground/70">
              {t("gpuStatusEmbed")}
            </span>
            <span className="text-muted-foreground/40">
              {t("gpuStatusUnsupported")}
            </span>
          </div>
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
        <div className="flex items-start justify-between gap-3 border-border border-t pt-3">
          <p className="pt-1 text-[11px] text-muted-foreground/60 leading-relaxed">
            {t("gpuRestartHint")}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              className="rounded-[6px] border border-input bg-background px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:bg-accent disabled:opacity-50"
              disabled={detectPhase === "checking"}
              onClick={handleDetect}
              type="button"
            >
              {getDetectButtonLabel(detectPhase, t)}
            </button>
            <button
              className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              disabled={saving}
              onClick={handleSave}
              type="button"
            >
              {saveStatus || t("save")}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
