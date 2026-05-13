import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/ipc/manager";

interface RenameResult {
  id: number;
  oldName: string;
  newName: string;
  error?: string;
}

interface BatchRenameDialogProps {
  onClose: () => void;
  onRename: (pattern: string) => Promise<{
    renamed: number;
    errors: number;
    results: RenameResult[];
  }>;
  open: boolean;
  photoCount: number;
  sampleFilename: string;
  samplePhotoId?: number;
}

const TOKENS: Array<{ token: string; description: string; example: string }> =
  [
    { token: "{yyyy}", description: "年份 (4位)", example: "2026" },
    { token: "{mm}", description: "月份 (2位)", example: "05" },
    { token: "{dd}", description: "日期 (2位)", example: "11" },
    { token: "{camera}", description: "相机型号", example: "SONY A7M4" },
    { token: "{iso}", description: "ISO 感光度", example: "100" },
    { token: "{focal}", description: "焦段", example: "85mm" },
    { token: "{index}", description: "序号 (1开始)", example: "1" },
    { token: "{index:N}", description: "补零序号", example: "{index:3} → 001" },
    { token: "{orig}", description: "原始文件名", example: "DSC0001" },
    { token: "{ext}", description: "扩展名 (含.)", example: ".JPG" },
  ];

const TEMPLATES = [
  { label: "日期_相机_序号", value: "{yyyy}{mm}{dd}_{camera}_{index:3}" },
  { label: "日期_序号", value: "{yyyy}{mm}{dd}_{index:4}" },
  { label: "原始名_日期", value: "{orig}_{yyyy}{mm}{dd}" },
  { label: "日期_原始名", value: "{yyyy}{mm}{dd}_{orig}" },
];

export function BatchRenameDialog({
  onClose,
  onRename,
  open,
  photoCount,
  sampleFilename,
  samplePhotoId,
}: BatchRenameDialogProps) {
  const [pattern, setPattern] = useState("{yyyy}{mm}{dd}_{index:3}");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{
    renamed: number;
    errors: number;
    results: RenameResult[];
  } | null>(null);
  const [serverPreview, setServerPreview] = useState<string | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset state each time dialog opens
  useEffect(() => {
    if (open) {
      setPattern("{yyyy}{mm}{dd}_{index:3}");
      setResult(null);
      setServerPreview(null);
    }
  }, [open]);

  // Fetch server-side preview with debounce
  useEffect(() => {
    if (!open || !samplePhotoId || !pattern.trim()) {
      setServerPreview(null);
      return;
    }
    if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    previewTimerRef.current = setTimeout(async () => {
      try {
        const res = await ipc.client.photos.previewRename({ id: samplePhotoId, pattern });
        setServerPreview((res as { preview: string }).preview || null);
      } catch {
        setServerPreview(null);
      }
    }, 200);
    return () => {
      if (previewTimerRef.current) clearTimeout(previewTimerRef.current);
    };
  }, [open, samplePhotoId, pattern]);

  const previewName = useCallback(() => {
    let name = pattern;
    const now = new Date();
    const base = sampleFilename.replace(/\.[^.]+$/, "");
    const ext = sampleFilename.match(/\.[^.]+$/)?.[0] ?? ".jpg";
    name = name.replace(/\{yyyy\}/g, now.getFullYear().toString());
    name = name.replace(/\{mm\}/g, String(now.getMonth() + 1).padStart(2, "0"));
    name = name.replace(/\{dd\}/g, String(now.getDate()).padStart(2, "0"));
    name = name.replace(/\{camera\}/g, "CAMERA");
    name = name.replace(/\{iso\}/g, "400");
    name = name.replace(/\{focal\}/g, "50mm");
    name = name.replace(/\{index(:\d+)?\}/g, (_, pad) => {
      const width = pad ? Number.parseInt(pad.slice(1), 10) : 1;
      return String(1).padStart(width, "0");
    });
    name = name.replace(/\{orig\}/g, base || "photo");
    name = name.replace(/\{ext\}/g, ext);
    return name + ext;
  }, [pattern, sampleFilename]);

  const handleRename = async () => {
    if (!pattern.trim()) return;
    setExecuting(true);
    try {
      const res = await onRename(pattern);
      setResult(res);
    } finally {
      setExecuting(false);
    }
  };

  const insertToken = (token: string) => {
    setPattern((prev) => prev + token);
  };

  if (!open) return null;

  const hasResult = result !== null;
  const errorResults = result?.results.filter((r) => r.error) ?? [];
  const successResults = result?.results.filter((r) => !r.error) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/60"
        onClick={hasResult ? undefined : onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !hasResult) onClose();
        }}
      />
      {/* Dialog */}
      <div className="relative w-[560px] max-h-[85vh] overflow-auto rounded-xl border border-border bg-popover ring-1 ring-white/5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-[16px] font-[510] text-foreground">
            批量重命名 ({photoCount} 张)
          </h2>
          <button
            className="rounded-md px-2 py-1 text-[#a1a1aa] text-[20px] leading-none hover:bg-foreground/5"
            onClick={onClose}
            type="button"
          >
            &times;
          </button>
        </div>

        {hasResult ? (
          /* Result View */
          <div className="px-6 py-4">
            <div className="mb-4 flex items-center gap-4 text-[14px]">
              <span className="text-[#46a758]">
                重命名成功: {successResults.length}
              </span>
              {errorResults.length > 0 && (
                <span className="text-[#e5484d]">
                  失败/跳过: {errorResults.length}
                </span>
              )}
            </div>
            {errorResults.length > 0 && (
              <div className="mb-4 max-h-[200px] overflow-auto rounded-md border border-border">
                {errorResults.map((r) => (
                  <div
                    className="border-b border-border px-3 py-2 text-[12px] text-muted-foreground last:border-b-0"
                    key={r.id}
                  >
                    <span className="text-[#e5484d]">{r.oldName}</span>
                    {" → "}
                    {r.newName}
                    {r.error && (
                      <span className="ml-2 text-[#e5484d]">({r.error})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex justify-end">
              <button
                className="rounded-md bg-primary px-4 py-2 text-[13px] font-[510] text-primary-foreground hover:opacity-90"
                onClick={onClose}
                type="button"
              >
                完成
              </button>
            </div>
          </div>
        ) : (
          /* Edit View */
          <div className="px-6 py-4">
            {/* Presets */}
            <div className="mb-4">
              <div className="mb-2 text-[11px] font-[510] text-[#6b6b75] uppercase tracking-[0.01em]">
                模板预设
              </div>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map((tpl) => (
                  <button
                    className="rounded-md border border-border px-3 py-1.5 text-[12px] text-[#a1a1aa] hover:bg-foreground/5 hover:text-foreground"
                    key={tpl.value}
                    onClick={() => setPattern(tpl.value)}
                    type="button"
                  >
                    {tpl.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Pattern input */}
            <div className="mb-2">
              <label className="mb-1.5 block text-[12px] font-[400] text-[#a1a1aa]">
                命名模式
              </label>
              <input
                className="w-full rounded-md border border-border bg-secondary px-3 py-2 text-[14px] text-foreground font-mono outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                onChange={(e) => setPattern(e.target.value)}
                placeholder="输入命名模式..."
                value={pattern}
              />
            </div>

            {/* Preview */}
            <div className="mb-4">
              <span className="text-[11px] text-[#6b6b75]">预览: </span>
              <span className="text-[13px] font-mono text-[#a1a1aa]">
                {serverPreview || previewName()}
              </span>
            </div>

            {/* Token palette */}
            <div className="mb-4">
              <div className="mb-2 text-[11px] font-[510] text-[#6b6b75] uppercase tracking-[0.01em]">
                可用变量
              </div>
              <div className="flex flex-wrap gap-1.5">
                {TOKENS.map((t) => (
                  <button
                    className="rounded-md border border-border bg-secondary px-2.5 py-1.5 text-[11px] font-mono text-[#a1a1aa] hover:bg-foreground/5 hover:text-foreground"
                    key={t.token}
                    onClick={() => insertToken(t.token)}
                    title={`${t.description} — 例如: ${t.example}`}
                    type="button"
                  >
                    {t.token}
                  </button>
                ))}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between">
              <span className="text-[12px] text-[#6b6b75]">
                原始文件不会被删除，仅重命名
              </span>
              <div className="flex gap-2">
                <button
                  className="rounded-md border border-border px-4 py-2 text-[13px] font-[510] text-[#a1a1aa] hover:bg-foreground/5"
                  onClick={onClose}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="rounded-md bg-primary px-4 py-2 text-[13px] font-[510] text-primary-foreground hover:opacity-90 disabled:opacity-50"
                  disabled={executing || !pattern.trim()}
                  onClick={handleRename}
                  type="button"
                >
                  {executing ? "执行中..." : `重命名 ${photoCount} 张`}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
