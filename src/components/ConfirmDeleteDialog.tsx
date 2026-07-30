import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";

interface ConfirmDeleteDialogProps {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
  sequenceGroup?: boolean;
}

/**
 * 删除照片确认对话框 — 软删除（移到回收站）。
 * 永久删除请使用直接调用 ConfirmDialog。
 */
export function ConfirmDeleteDialog({
  count,
  onCancel,
  onConfirm,
  open,
  sequenceGroup = false,
}: ConfirmDeleteDialogProps) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      confirmText={t("confirmDeleteAction")}
      description={
        sequenceGroup
          ? t("confirmDeleteSequenceGroupDescription", { count })
          : t("confirmDeleteDescription", {
              target:
                count > 1
                  ? t("confirmDeleteTargetPhotos", { count })
                  : t("confirmDeleteTargetPhoto"),
            })
      }
      destructive
      onCancel={onCancel}
      onConfirm={onConfirm}
      open={open}
      title={t("confirmDeleteTitle")}
    />
  );
}
