import { useEffect, useRef } from "react";

interface ConfirmDeleteDialogProps {
  count: number;
  onCancel: () => void;
  onConfirm: () => void;
  open: boolean;
}

export function ConfirmDeleteDialog({
  count,
  onCancel,
  onConfirm,
  open,
}: ConfirmDeleteDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) cancelRef.current?.focus();
  }, [open]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60"
      onClick={onCancel}
    >
      <div
        className="w-[360px] rounded-[12px] border border-border bg-[#1c1c1e] p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="mb-2 text-[15px] font-medium text-[#f7f8f8]">
          确认删除
        </h3>
        <p className="mb-5 text-[13px] text-[#a0a0ab]">
          将{count > 1 ? ` ${count} 张照片` : "该照片"}移到系统回收站，此操作可从回收站恢复。
        </p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            className="rounded-[6px] border border-border px-3 py-1.5 text-[13px] text-[#a0a0ab] hover:bg-foreground/10"
            onClick={onCancel}
          >
            取消
          </button>
          <button
            className="rounded-[6px] bg-[#e5484d] px-3 py-1.5 text-[13px] text-white hover:bg-[#d13438]"
            onClick={onConfirm}
          >
            删除
          </button>
        </div>
      </div>
    </div>
  );
}
