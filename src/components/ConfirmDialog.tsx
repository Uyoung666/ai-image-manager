import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * 通用确认对话框。不显示右上角 X，仅"取消 + 操作"两按钮。
 * destructive=true 时操作按钮使用红色 variant。
 */
interface ConfirmDialogProps {
  /** 操作按钮文案，必填，使用动词。例：删除、永久删除、创建 */
  confirmText: string;
  /** 取消按钮文案，默认"取消" */
  cancelText?: string;
  /** 描述文本（可选），支持 ReactNode */
  description?: React.ReactNode;
  /** 是否为危险操作 — 操作按钮显示为红色 */
  destructive?: boolean;
  /** 是否禁用操作按钮（loading 等场景） */
  disabled?: boolean;
  /** 关闭对话框（点击取消、按 ESC、点击遮罩） */
  onCancel?: () => void;
  /** 点击操作按钮 */
  onConfirm: () => void;
  /** 受控开关 */
  open: boolean;
  /** 标题（必填） */
  title: string;
}

export function ConfirmDialog({
  confirmText,
  cancelText,
  description,
  destructive = false,
  disabled = false,
  onCancel,
  onConfirm,
  open,
  title,
}: ConfirmDialogProps) {
  const { t } = useTranslation();

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onCancel?.();
        }
      }}
      open={open}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && (
            <AlertDialogDescription>{description}</AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={disabled}>
            {cancelText ?? t("cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            className={
              destructive
                ? "bg-destructive text-white hover:bg-destructive/90 focus-visible:ring-destructive/30"
                : undefined
            }
            disabled={disabled}
            onClick={onConfirm}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
