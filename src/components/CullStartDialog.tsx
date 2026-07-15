import { Eye, Swords } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/ipc/manager";

interface CullStartDialogProps {
  defaultName?: string;
  onClose: () => void;
  onCreated: (sessionId: number) => void;
  open: boolean;
  photoIds: number[];
}

export function CullStartDialog({
  defaultName = "",
  onClose,
  onCreated,
  open,
  photoIds,
}: CullStartDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<"duel" | "curate">("duel");
  const [pkMode, setPkMode] = useState<"quick" | "standard" | "fine">(
    "standard"
  );
  const [sortStrategy, setSortStrategy] = useState<"time" | "similarity">(
    "time"
  );
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (open) {
      setName(defaultName);
    }
  }, [defaultName, open]);

  const estimatedActions = useMemo(() => {
    if (mode === "curate") {
      return photoIds.length;
    }
    const minComparisons = pkMode === "quick" ? 5 : pkMode === "fine" ? 12 : 8;
    const recompareFactor =
      pkMode === "quick" ? 0 : pkMode === "fine" ? 0.3 : 0.15;
    return (
      Math.ceil((photoIds.length * minComparisons) / 2) +
      Math.ceil(photoIds.length * recompareFactor)
    );
  }, [mode, photoIds.length, pkMode]);

  async function createSession() {
    if (creating || photoIds.length < 2) {
      return;
    }
    setCreating(true);
    try {
      const session = (await ipc.client.cull.createSession({
        mode,
        name: name.trim() || `${t("cullTitle")} · ${photoIds.length}`,
        photoIds,
        pkMode,
        sortStrategy,
      })) as { id: number };
      onCreated(session.id);
    } catch (error) {
      console.error("[CullStartDialog] create failed:", error);
      toast.error(t("cullCreateSessionFailed"));
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog onOpenChange={(value) => !value && onClose()} open={open}>
      <DialogContent className="max-w-[460px]">
        <DialogHeader>
          <DialogTitle>{t("cullNew")}</DialogTitle>
          <DialogDescription>
            {t("cullSelectedSource", { count: photoIds.length })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <input
            className="w-full rounded-[6px] border border-input bg-transparent px-3 py-2 text-[13px] outline-none focus:border-primary"
            onChange={(event) => setName(event.target.value)}
            placeholder={t("cullSessionNamePlaceholder")}
            value={name}
          />
          <div className="grid grid-cols-2 gap-2">
            {(["duel", "curate"] as const).map((value) => (
              <button
                className={`flex items-center justify-center gap-2 rounded-[6px] border px-3 py-2 text-[12px] ${
                  mode === value
                    ? "border-primary/40 bg-primary/10 text-primary"
                    : "border-border text-muted-foreground"
                }`}
                key={value}
                onClick={() => setMode(value)}
                type="button"
              >
                {value === "duel" ? (
                  <Swords className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
                {t(value === "duel" ? "cullModeDuel" : "cullModeCurate")}
              </button>
            ))}
          </div>
          {mode === "duel" ? (
            <div className="grid grid-cols-3 gap-2">
              {(["quick", "standard", "fine"] as const).map((value) => (
                <button
                  className={`rounded-[6px] px-2 py-2 text-[11px] ${
                    pkMode === value
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                  key={value}
                  onClick={() => setPkMode(value)}
                  type="button"
                >
                  {t(
                    value === "quick"
                      ? "cullPkModeQuick"
                      : value === "fine"
                        ? "cullPkModeFine"
                        : "cullPkModeStandard"
                  )}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {(["time", "similarity"] as const).map((value) => (
                <button
                  className={`rounded-[6px] px-3 py-2 text-[11px] ${
                    sortStrategy === value
                      ? "bg-primary/10 text-primary"
                      : "bg-muted text-muted-foreground"
                  }`}
                  key={value}
                  onClick={() => setSortStrategy(value)}
                  type="button"
                >
                  {t(
                    value === "time" ? "cullSortByTime" : "cullSortBySimilarity"
                  )}
                </button>
              ))}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {t("cullEstimatedActions", { count: estimatedActions })}
          </p>
        </div>
        <DialogFooter>
          <button
            className="rounded-[6px] px-4 py-2 text-[12px] text-muted-foreground"
            onClick={onClose}
            type="button"
          >
            {t("cancel")}
          </button>
          <button
            className="rounded-[6px] bg-primary px-4 py-2 text-[12px] text-primary-foreground disabled:opacity-50"
            disabled={creating || photoIds.length < 2}
            onClick={createSession}
            type="button"
          >
            {creating ? t("loading") : t("cullStart")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
