import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  descriptionKey: string;
}> = [
  { value: "webp", label: "WebP", descriptionKey: "convertWebpDescription" },
  { value: "avif", label: "AVIF", descriptionKey: "convertAvifDescription" },
  { value: "jpg", label: "JPEG", descriptionKey: "convertJpgDescription" },
  { value: "png", label: "PNG", descriptionKey: "convertPngDescription" },
];

export function FormatConvertDialog({
  onClose,
  onConvert,
  open,
  photoCount,
}: FormatConvertDialogProps) {
  const { t } = useTranslation();
  const [format, setFormat] = useState<"jpg" | "png" | "webp" | "avif">("webp");
  const [quality, setQuality] = useState(85);
  const [maxWidth, setMaxWidth] = useState("");
  const [outputDir, setOutputDir] = useState("");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<ConvertResult | null>(null);
  const [error, setError] = useState("");

  async function pickOutputDir() {
    const res = await ipc.client.shell.openFolderDialog({});
    const pickedPath = (res as { path?: string })?.path;
    if (pickedPath) {
      setOutputDir(pickedPath);
    }
  }

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
        outputDir,
      });
      setResult(res);
    } catch (e: any) {
      setError(e.message || t("convertFailed"));
    } finally {
      setExecuting(false);
    }
  };

  const hasResult = result !== null;
  const blockClose = executing || hasResult;

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || blockClose)) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (blockClose) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (blockClose) {
            e.preventDefault();
          }
        }}
        showCloseButton={!executing}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>{t("convertTitle", { count: photoCount })}</DialogTitle>
        </DialogHeader>

        {hasResult ? (
          <>
            <div className="flex items-center gap-2 text-[14px] text-success">
              {t("convertSuccessCount", { count: result.converted })}
            </div>
            <div className="text-[12px] text-muted-foreground">
              {t("outputDir")}:{" "}
              <span className="font-mono text-foreground">
                {result.outputDir}
              </span>
            </div>
            <DialogFooter>
              <button
                className="rounded-md bg-primary px-4 py-1.5 font-[510] text-[13px] text-primary-foreground transition-opacity hover:opacity-90"
                onClick={onClose}
                type="button"
              >
                {t("done")}
              </button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div>
              <label className="mb-2 block text-[12px] text-muted-foreground">
                {t("targetFormat")}
              </label>
              <div className="grid grid-cols-2 gap-2">
                {FORMATS.map((f) => (
                  <button
                    className={`rounded-md border px-3 py-2.5 text-left transition-colors ${
                      format === f.value
                        ? "border-primary bg-primary/10 text-foreground"
                        : "border-border text-muted-foreground hover:bg-foreground/5"
                    }`}
                    key={f.value}
                    onClick={() => setFormat(f.value)}
                    type="button"
                  >
                    <div className="font-[510] text-[13px]">{f.label}</div>
                    <div className="mt-0.5 text-[11px] opacity-60">
                      {t(f.descriptionKey)}
                    </div>
                  </button>
                ))}
              </div>
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="text-[12px] text-muted-foreground">{t("quality")}</label>
                <span className="font-mono text-[13px] text-foreground">
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
              <div className="mt-1 flex justify-between text-[10px] text-muted-foreground/70">
                <span>{t("smallestSize")}</span>
                <span>{t("bestQuality")}</span>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] text-muted-foreground">
                {t("maxWidthOptional")}
              </label>
              <input
                className="w-32 rounded-md border border-border bg-secondary px-3 py-2 font-mono text-[14px] text-foreground outline-none focus:border-primary"
                onChange={(e) => setMaxWidth(e.target.value.replace(/\D/g, ""))}
                placeholder={t("noLimit")}
                value={maxWidth}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] text-muted-foreground">
                {t("outputDir")}
              </label>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate rounded-md border border-border bg-secondary px-3 py-2 font-mono text-[12px] text-muted-foreground/70">
                  {outputDir || t("defaultTempDir")}
                </span>
                <button
                  className="flex-shrink-0 rounded-md border border-border px-3 py-2 text-[12px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  onClick={pickOutputDir}
                  type="button"
                >
                  {t("pickOutputDir")}
                </button>
              </div>
            </div>

            {error && (
              <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                {error}
              </div>
            )}

            {executing && (
              <div>
                <div className="mb-1.5 text-[11px] text-muted-foreground">
                  {t("convertingPhotos", { count: photoCount })}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-primary" />
                </div>
              </div>
            )}

            <DialogFooter>
              <button
                className="rounded-md border border-border px-4 py-1.5 font-[510] text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                disabled={executing}
                onClick={onClose}
                type="button"
              >
                {t("cancel")}
              </button>
              <button
                className="rounded-md bg-primary px-4 py-1.5 font-[510] text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={executing}
                onClick={handleConvert}
                type="button"
              >
                {executing
                  ? t("converting")
                  : t("convertActionCount", { count: photoCount })}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
