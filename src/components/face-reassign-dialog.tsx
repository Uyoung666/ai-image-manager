import { User } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toLocalMediaUrl } from "@/utils/local-media-url";

export interface FaceReassignIdentity {
  coverBbox: { x: number; y: number; width: number; height: number } | null;
  coverPhotoHeight: number | null;
  coverPhotoPath: string | null;
  coverPhotoWidth: number | null;
  coverThumbnailPath: string | null;
  id: number;
  name: string | null;
}

interface FaceReassignDialogProps {
  currentIdentityId: number;
  identities: FaceReassignIdentity[];
  loading?: boolean;
  onAssign: (identityId: number) => Promise<void>;
  onCreate: (name: string) => Promise<void>;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  photoName: string;
}

export function FaceReassignDialog({
  currentIdentityId,
  identities,
  loading = false,
  onAssign,
  onCreate,
  onOpenChange,
  open,
  photoName,
}: FaceReassignDialogProps) {
  const { t } = useTranslation();
  const [newName, setNewName] = useState("");
  const [assigningId, setAssigningId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const composingRef = useRef(false);
  const busy = assigningId !== null || creating;

  useEffect(() => {
    if (open) {
      setNewName("");
      setAssigningId(null);
      setCreating(false);
      composingRef.current = false;
    }
  }, [open]);

  async function assign(identityId: number) {
    setAssigningId(identityId);
    try {
      await onAssign(identityId);
    } finally {
      setAssigningId(null);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) {
      return;
    }
    setCreating(true);
    try {
      await onCreate(name);
    } finally {
      setCreating(false);
    }
  }

  const availableIdentities = identities.filter(
    (identity) => identity.id !== currentIdentityId && identity.name?.trim()
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{t("faceReassignTitle")}</DialogTitle>
          <DialogDescription className="truncate">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block truncate">{photoName}</span>
              </TooltipTrigger>
              <TooltipContent>{photoName}</TooltipContent>
            </Tooltip>
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 max-h-[300px] overflow-y-auto">
          {availableIdentities.length === 0 ? (
            <p className="px-3 py-6 text-center text-[13px] text-muted-foreground/70">
              {t("faceReassignNoIdentities")}
            </p>
          ) : (
            availableIdentities.map((identity) => (
              <button
                className="flex w-full items-center gap-3 rounded-[6px] px-3 py-2 text-left text-[13px] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-50"
                disabled={busy || loading}
                key={identity.id}
                onClick={() => assign(identity.id)}
                type="button"
              >
                {identity.coverThumbnailPath || identity.coverPhotoPath ? (
                  <img
                    alt=""
                    className="h-8 w-8 rounded-[6px] object-cover"
                    height={32}
                    src={toLocalMediaUrl(
                      identity.coverThumbnailPath ||
                        identity.coverPhotoPath ||
                        ""
                    )}
                    width={32}
                  />
                ) : (
                  <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-white/5 text-muted-foreground">
                    <User className="h-4 w-4" />
                  </div>
                )}
                <span className="flex-1 truncate">{identity.name}</span>
                {assigningId === identity.id && <LoadingSpinner size="sm" />}
              </button>
            ))
          )}
        </div>

        <div className="border-border border-t pt-3">
          <label className="block text-[12px] text-muted-foreground">
            <span className="mb-1.5 block">{t("faceReassignCreateNew")}</span>
            <input
              autoFocus
              className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus:border-primary"
              disabled={busy || loading}
              onChange={(event) => setNewName(event.target.value)}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onKeyDown={(event) => {
                if (composingRef.current) {
                  return;
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  create();
                }
              }}
              placeholder={t("faceReassignNamePlaceholder")}
              value={newName}
            />
          </label>
        </div>

        <DialogFooter>
          <button
            className="rounded-md border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-foreground/5 disabled:opacity-40"
            disabled={busy || loading || !newName.trim()}
            onClick={create}
            type="button"
          >
            {creating ? (
              <LoadingSpinner size="sm" />
            ) : (
              t("faceReassignCreateAndAssign")
            )}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
