import { useEffect, useState } from "react";
import { ipc } from "@/ipc/manager";

interface ConvertResult {
  converted: number;
  outputDir: string;
}

interface FormatConvertDialogProps {
  onClose: () => void;
  onConvert: (options: {
    format: "jpg" | "png" | "webp" | "avif";
    quality: number;
    maxWidth: number;
    outputDir: string;
  }) => Promise<ConvertResult>;
  open: boolean;
  photoCount: number;
}

const FORMATS: Array<{
  value: "jpg" | "png" | "webp" | "avif";
  label: string;
  description: string;
}> = [
  { value: "webp", label: "WebP", description: "最佳压缩比，适合网络使用" },
  { value: "avif", label: "AVIF", description: "最新格式，比WebP更小" },
  { value: "jpg", label: "JPEG", description: "兼容性最好" },
  { value: "png", label: "PNG", description: "无损格式，适合文字截图" },
];

export function FormatConvertDialog({
  onClose,
  onConvert,
  open,
  photoCount,
}: FormatConvertDialogProps) {
  const [format, setFormat] = useState<"jpg" | "png" | "webp" | "avif">(
    "webp"
  );
  const [quality, setQuality] = useState(85);
  const [maxWidth, setMaxWidth] = useState(""); // empty = no resize
  const [outputDir, setOutputDir] = useState("");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [error, setError] = useState("");

  async function pickOutputDir() {
    const result = await ipc.client.shell.openFolderDialog({});
    const pickedPath = (result as { path?: string })?.path;
    if (pickedPath) setOutputDir(pickedPath);
  }

  // Reset state each time dialog opens
  useEffect(() => {
    if (open) {
      setFormat("webp");
      setQuality(85);
      setMaxWidth("");
      setOutputDir("");
      setResult(null);
      setError("");
    }
  }, [open]);

  const handleConvert = async () => {
    setExecuting(true);
    setError("");
    try {
      const res = await onConvert({
        format,
        quality,
        maxWidth: Number.parseInt(maxWidth, 10) || 0,
        outputDir, // User-selected or empty (backend falls back to temp)
      });
      setResult(res);
    } catch (e: any) {
      setError(e.message || "转换失败");
    } finally {
      setExecuting(false);
    }
  };

  if (!open) return null;

  const hasResult = result !== null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div
        className="absolute inset-0 bg-black/60"
        onClick={hasResult ? undefined : onClose}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !hasResult) onClose();
        }}
      />
      <div className="relative w-[480px] max-h-[85vh] overflow-auto rounded-xl border border-border bg-popover ring-1 ring-white/5">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-[16px] font-[510] text-foreground">
            格式转换 ({photoCount} 张)
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
          /* Result */
          <div className="px-6 py-4">
            <div className="mb-4 flex items-center gap-2 text-[14px] text-[#46a758]">
              成功转换: {result.converted} 张
            </div>
            <div className="mb-4 text-[12px] text-[#a1a1aa]">
              输出目录:{" "}
              <span className="font-mono text-foreground">{result.outputDir}</span>
            </div>
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
          /* Options */
          <div className="px-6 py-4">
            {/* Format selection */}
            <div className="mb-5">
              <label className="mb-2 block text-[12px] font-[400] text-[#a1a1aa]">
                目标格式
              </label>
              <div className="grid grid-cols-2 gap-2">
                {FORMATS.map((f) => (
                  <button
                    className={`rounded-md border px-3 py-2.5 text-left transition-colors ${
                      format === f.value
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-[#a1a1aa] hover:bg-foreground/5"
                    }`}
                    key={f.value}
                    onClick={() => setFormat(f.value)}
                    type="button"
                  >
                    <div className="text-[13px] font-[510]">{f.label}</div>
                    <div className="mt-0.5 text-[11px] opacity-60">
                      {f.description}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Quality slider */}
            <div className="mb-5">
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[12px] font-[400] text-[#a1a1aa]">
                  画质
                </label>
                <span className="text-[13px] font-mono text-foreground">
                  {quality}%
                </span>
              </div>
              <input
                className="w-full"
                max={100}
                min={10}
                onChange={(e) => setQuality(Number(e.target.value))}
                style={{ accentColor: "var(--primary)" }}
                type="range"
                value={quality}
              />
              <div className="mt-1 flex justify-between text-[10px] text-[#6b6b75]">
                <span>最小体积</span>
                <span>最佳画质</span>
              </div>
            </div>

            {/* Max width */}
            <div className="mb-5">
              <label className="mb-1.5 block text-[12px] font-[400] text-[#a1a1aa]">
                最大宽度 (px，留空不缩放)
              </label>
              <input
                className="w-32 rounded-md border border-border bg-secondary px-3 py-2 text-[14px] text-foreground font-mono outline-none focus:border-primary"
                onChange={(e) => setMaxWidth(e.target.value.replace(/\D/g, ""))}
                placeholder="不限制"
                value={maxWidth}
              />
            </div>

            {/* Output directory */}
            <div className="mb-5">
              <label className="mb-1.5 block text-[12px] font-[400] text-[#a1a1aa]">
                输出目录
              </label>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-secondary px-3 py-2 text-[12px] text-[#6b6b75] font-mono">
                  {outputDir || "默认临时目录"}
                </span>
                <button
                  className="flex-shrink-0 rounded-md border border-border px-3 py-2 text-[12px] text-[#a1a1aa] hover:bg-foreground/5 hover:text-foreground"
                  onClick={pickOutputDir}
                  type="button"
                >
                  选择...
                </button>
              </div>
            </div>

            {/* Error */}
            {error && (
              <div className="mb-4 rounded-md border border-[#e5484d]/20 bg-[#e5484d]/10 px-3 py-2 text-[12px] text-[#e5484d]">
                {error}
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2">
              <button
                className="rounded-md border border-border px-4 py-2 text-[13px] font-[510] text-[#a1a1aa] hover:bg-foreground/5"
                onClick={onClose}
                type="button"
              >
                取消
              </button>
              <button
                className="rounded-md bg-primary px-4 py-2 text-[13px] font-[510] text-primary-foreground hover:opacity-90 disabled:opacity-50"
                disabled={executing}
                onClick={handleConvert}
                type="button"
              >
                {executing ? "转换中..." : `转换 ${photoCount} 张`}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
