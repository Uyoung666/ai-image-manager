import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ipc } from "@/ipc/manager";

interface RenameResult {
  error?: string;
  id: number;
  newName: string;
  oldName: string;
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

const TOKENS: Array<{
  token: string;
  descriptionKey: string;
  example: string;
}> = [
  { token: "{yyyy}", descriptionKey: "tokenYear", example: "2026" },
  { token: "{mm}", descriptionKey: "tokenMonth", example: "05" },
  { token: "{dd}", descriptionKey: "tokenDay", example: "11" },
  { token: "{camera}", descriptionKey: "tokenCamera", example: "SONY A7M4" },
  { token: "{iso}", descriptionKey: "tokenIso", example: "100" },
  { token: "{focal}", descriptionKey: "tokenFocal", example: "85mm" },
  { token: "{index}", descriptionKey: "tokenIndex", example: "1" },
  {
    token: "{index:N}",
    descriptionKey: "tokenIndexPadded",
    example: "{index:3} → 001",
  },
  { token: "{orig}", descriptionKey: "tokenOriginalName", example: "DSC0001" },
  { token: "{ext}", descriptionKey: "tokenExtension", example: ".JPG" },
];

const TEMPLATES = [
  {
    labelKey: "templateDateCameraIndex",
    value: "{yyyy}{mm}{dd}_{camera}_{index:3}",
  },
  { labelKey: "templateDateIndex", value: "{yyyy}{mm}{dd}_{index:4}" },
  { labelKey: "templateOriginalDate", value: "{orig}_{yyyy}{mm}{dd}" },
  { labelKey: "templateDateOriginal", value: "{yyyy}{mm}{dd}_{orig}" },
];

export function BatchRenameDialog({
  onClose,
  onRename,
  open,
  photoCount,
  sampleFilename,
  samplePhotoId,
}: BatchRenameDialogProps) {
  const { t } = useTranslation();
  const [pattern, setPattern] = useState("{yyyy}{mm}{dd}_{index:3}");
  const [executing, setExecuting] = useState(false);
  const [result, setResult] = useState<{
    renamed: number;
    errors: number;
    results: RenameResult[];
  } | null>(null);
  const [serverPreview, setServerPreview] = useState<string | null>(null);
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (open) {
      setPattern("{yyyy}{mm}{dd}_{index:3}");
      setResult(null);
      setServerPreview(null);
    }
  }, [open]);

  useEffect(() => {
    if (!(open && samplePhotoId && pattern.trim())) {
      setServerPreview(null);
      return;
    }
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
    }
    previewTimerRef.current = setTimeout(async () => {
      try {
        const res = await ipc.client.photos.previewRename({
          id: samplePhotoId,
          pattern,
        });
        setServerPreview((res as { preview: string }).preview || null);
      } catch {
        setServerPreview(null);
      }
    }, 200);
    return () => {
      if (previewTimerRef.current) {
        clearTimeout(previewTimerRef.current);
      }
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
    if (!pattern.trim()) {
      return;
    }
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

  const hasResult = result !== null;
  const errorResults = result?.results.filter((r) => r.error) ?? [];
  const successResults = result?.results.filter((r) => !r.error) ?? [];
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
        className="max-h-[85vh] overflow-y-auto"
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
        size="xl"
      >
        <DialogHeader>
          <DialogTitle>
            {t("batchRenameTitle", { count: photoCount })}
          </DialogTitle>
        </DialogHeader>

        {hasResult ? (
          <>
            <div className="flex items-center gap-4 text-[14px]">
              <span className="text-success">
                {t("batchRenameSuccess", { count: successResults.length })}
              </span>
              {errorResults.length > 0 && (
                <span className="text-destructive">
                  {t("batchRenameErrors", { count: errorResults.length })}
                </span>
              )}
            </div>
            {errorResults.length > 0 && (
              <div className="max-h-[200px] overflow-auto rounded-md border border-border">
                {errorResults.map((r) => (
                  <div
                    className="border-border border-b px-3 py-2 text-[12px] text-muted-foreground last:border-b-0"
                    key={r.id}
                  >
                    <span className="text-destructive">{r.oldName}</span>
                    {" → "}
                    {r.newName}
                    {r.error && (
                      <span className="ml-2 text-destructive">({r.error})</span>
                    )}
                  </div>
                ))}
              </div>
            )}
            <DialogFooter>
              <button
                className="rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90"
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
              <div className="mb-2 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-[0.01em]">
                {t("batchRenameTemplates")}
              </div>
              <div className="flex flex-wrap gap-2">
                {TEMPLATES.map((tpl) => (
                  <button
                    className="rounded-md border border-border px-3 py-1.5 text-[12px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    key={tpl.value}
                    onClick={() => setPattern(tpl.value)}
                    type="button"
                  >
                    {t(tpl.labelKey)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-[12px] text-muted-foreground">
                {t("batchRenamePattern")}
              </label>
              <input
                className="w-full rounded-md border border-border bg-secondary px-3 py-2 font-mono text-[14px] text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                onChange={(e) => setPattern(e.target.value)}
                placeholder={t("batchRenamePatternPlaceholder")}
                value={pattern}
              />
            </div>

            <div>
              <span className="text-[11px] text-muted-foreground/70">
                {t("preview")}{" "}
              </span>
              <span className="font-mono text-[13px] text-muted-foreground">
                {serverPreview || previewName()}
              </span>
            </div>

            <div>
              <div className="mb-2 font-medium text-[11px] text-muted-foreground/70 uppercase tracking-[0.01em]">
                {t("batchRenameTokens")}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {TOKENS.map((token) => (
                  <Tooltip key={token.token}>
                    <TooltipTrigger asChild>
                      <button
                        className="rounded-md border border-border bg-secondary px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                        onClick={() => insertToken(token.token)}
                        type="button"
                      >
                        {token.token}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t(token.descriptionKey)} — {t("examplePrefix")}:{" "}
                      {token.example}
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </div>

            {executing && (
              <div>
                <div className="mb-1.5 text-[11px] text-muted-foreground">
                  {t("batchRenaming", { count: photoCount })}
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-primary" />
                </div>
              </div>
            )}

            <DialogFooter className="items-center sm:justify-between">
              <span className="text-[12px] text-muted-foreground/70">
                {t("batchRenameNote")}
              </span>
              <div className="flex gap-2">
                <button
                  className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground hover:bg-foreground/5 disabled:opacity-40"
                  disabled={executing}
                  onClick={onClose}
                  type="button"
                >
                  {t("cancel")}
                </button>
                <button
                  className="rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground hover:opacity-90 disabled:opacity-40"
                  disabled={executing || !pattern.trim()}
                  onClick={handleRename}
                  type="button"
                >
                  {executing
                    ? t("executing")
                    : t("batchRenameAction", { count: photoCount })}
                </button>
              </div>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
