import { Cpu, Zap } from "lucide-react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ipc } from "@/ipc/manager";

interface GpuDetectionDialogProps {
  gpuName?: string;
  onClose: () => void;
  open: boolean;
}

/**
 * One-time onboarding dialog shown when DirectML GPU support is detected
 * for the first time and the user hasn't yet chosen a GPU preference.
 */
export function GpuDetectionDialog({
  gpuName,
  onClose,
  open,
}: GpuDetectionDialogProps) {
  const { t } = useTranslation();

  const handleEnable = useCallback(async () => {
    try {
      await ipc.client.settings.setGpuSettings({ enabled: true });
      await ipc.client.settings.markGpuPromptShown({});
    } catch {
      /* dismiss even on error */
    }
    onClose();
  }, [onClose]);

  const handleSkip = useCallback(async () => {
    try {
      await ipc.client.settings.markGpuPromptShown({});
    } catch {
      /* best-effort */
    }
    onClose();
  }, [onClose]);

  const gpuNameStr =
    typeof gpuName === "string" && gpuName.trim().length > 0
      ? gpuName.trim()
      : undefined;

  return (
    <ConfirmDialog
      cancelText={t("gpuDetectionSkip")}
      confirmText={t("gpuDetectionEnable")}
      description={
        <div className="space-y-2.5 text-left">
          <p className="text-[13px] text-foreground/85 leading-relaxed">
            {gpuNameStr
              ? t("gpuDetectionDescription", { gpuName: gpuNameStr })
              : t("gpuDetectionDescriptionGeneric")}
          </p>
          {/* benefit row */}
          <div className="flex items-center gap-2 rounded-md bg-green-50 px-2.5 py-1.5 text-[12px] dark:bg-green-950/30">
            <Zap className="h-3.5 w-3.5 shrink-0 text-green-600 dark:text-green-400" />
            <span className="text-green-700 dark:text-green-300">
              {t("gpuDetectionFaceSpeed")}
            </span>
          </div>
          {/* limitation note */}
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground/60">
            <Cpu className="h-3 w-3 shrink-0" />
            <span>{t("gpuDetectionEmbedNote")}</span>
          </div>
        </div>
      }
      onCancel={handleSkip}
      onConfirm={handleEnable}
      open={open}
      title={t("gpuDetectionTitle")}
    />
  );
}
