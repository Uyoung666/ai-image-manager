import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface FaceReassignIdentity {
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
  const [selectedIdentity, setSelectedIdentity] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setSelectedIdentity("");
      setNewName("");
    }
  }, [open]);

  async function assign() {
    const identityId = Number(selectedIdentity);
    if (!identityId) {
      return;
    }
    setBusy(true);
    try {
      await onAssign(identityId);
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    const name = newName.trim();
    if (!name) {
      return;
    }
    setBusy(true);
    try {
      await onCreate(name);
    } finally {
      setBusy(false);
    }
  }

  const availableIdentities = identities.filter(
    (identity) => identity.id !== currentIdentityId && identity.name?.trim()
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>为这张照片中的人脸命名</DialogTitle>
          <DialogDescription className="truncate" title={photoName}>
            {photoName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <label className="block text-[12px] text-muted-foreground">
            <span className="mb-1.5 block">归入已有人物</span>
            <select
              className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus:border-primary"
              disabled={busy || loading || availableIdentities.length === 0}
              onChange={(event) => setSelectedIdentity(event.target.value)}
              value={selectedIdentity}
            >
              <option value="">
                {availableIdentities.length === 0
                  ? "暂无其他已命名人物"
                  : "选择人物"}
              </option>
              {availableIdentities.map((identity) => (
                <option key={identity.id} value={identity.id}>
                  {identity.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="w-full rounded-md bg-primary px-3 py-2 text-[12px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={busy || loading || !selectedIdentity}
            onClick={assign}
            type="button"
          >
            归入已有人物
          </button>

          <div className="border-border border-t pt-3">
            <label className="block text-[12px] text-muted-foreground">
              <span className="mb-1.5 block">创建新人物</span>
              <input
                autoFocus
                className="w-full rounded-md border border-input bg-background px-2.5 py-2 text-[13px] text-foreground outline-none focus:border-primary"
                disabled={busy || loading}
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    create();
                  }
                }}
                placeholder="输入人物名称"
                value={newName}
              />
            </label>
          </div>
        </div>

        <DialogFooter>
          <button
            className="rounded-md border border-border px-3 py-1.5 text-[12px] text-foreground hover:bg-foreground/5 disabled:opacity-40"
            disabled={busy || loading || !newName.trim()}
            onClick={create}
            type="button"
          >
            创建并归类
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
