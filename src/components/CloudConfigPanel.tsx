import { Cloud, Link2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { FilterDropdown } from "@/components/filter-dropdown";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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

interface CloudConfig {
  configJson: string;
  createdAt: number;
  id: number;
  isDefault: boolean;
  name: string;
  provider: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  webdav: "WebDAV",
  s3: "Amazon S3",
};

function ConfigSkeleton() {
  return (
    <div className="space-y-2 border-border border-t pt-3">
      {[0, 1].map((item) => (
        <div className="flex items-center gap-3" key={item}>
          <div className="h-3 w-3 rounded bg-muted-foreground/10" />
          <div className="h-3 flex-1 rounded bg-muted-foreground/10" />
          <div className="h-5 w-14 rounded bg-muted-foreground/10" />
        </div>
      ))}
    </div>
  );
}

export function CloudConfigPanel() {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<CloudConfig[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [provider, setProvider] = useState<"webdav" | "s3">("webdav");
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [accessKey, setAccessKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("");
  const [publicBase, setPublicBase] = useState("");
  const [saving, setSaving] = useState(false);
  const [testStates, setTestStates] = useState<
    Record<number, { result: string; success: boolean | null }>
  >({});
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);

  const loadConfigs = useCallback(async () => {
    try {
      const result = await ipc.client.cloud.listCloudConfigs({});
      setConfigs(result as CloudConfig[]);
    } catch {
      toast.error(t("cloudLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  function resetForm() {
    setProvider("webdav");
    setName("");
    setUrl("");
    setUsername("");
    setPassword("");
    setEndpoint("");
    setAccessKey("");
    setSecretKey("");
    setBucket("");
    setRegion("");
    setPublicBase("");
  }

  async function handleSave() {
    if (!name.trim()) {
      return;
    }
    setSaving(true);
    try {
      const config: Record<string, string> =
        provider === "webdav"
          ? { url, username, password }
          : { endpoint, accessKey, secretKey, bucket, region, publicBase };
      await ipc.client.cloud.createCloudConfig({
        name: name.trim(),
        provider,
        config,
      });
      resetForm();
      setShowAdd(false);
      await loadConfigs();
      toast.success(t("cloudConfigSaved"));
    } catch {
      toast.error(t("cloudConfigSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (deleteConfirmId === null) {
      return;
    }
    try {
      await ipc.client.cloud.deleteCloudConfig({ id: deleteConfirmId });
      setDeleteConfirmId(null);
      await loadConfigs();
      toast.success(t("cloudConfigDeleted"));
    } catch {
      toast.error(t("cloudConfigDeleteFailed"));
    }
  }

  async function handleTestConnection(id: number) {
    setTestingId(id);
    setTestStates((prev) => ({
      ...prev,
      [id]: { result: t("cloudTesting"), success: null },
    }));
    try {
      const result = (await ipc.client.cloud.testCloudConnection({ id })) as {
        success: boolean;
        latencyMs?: number;
        error?: string;
      };
      const message = result.success
        ? t("cloudConnectionSuccess", { latency: result.latencyMs })
        : t("cloudConnectionFailed", {
            error: result.error || t("cloudUnknownError"),
          });
      setTestStates((prev) => ({
        ...prev,
        [id]: { result: message, success: result.success },
      }));
      if (result.success) {
        toast.success(message);
      } else {
        toast.error(message);
      }
    } catch {
      setTestStates((prev) => ({
        ...prev,
        [id]: { result: t("cloudTestException"), success: false },
      }));
      toast.error(t("cloudTestException"));
    }
    setTestingId(null);
    setTimeout(() => {
      setTestStates((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    }, 4000);
  }

  return (
    <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Cloud className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-[13px] text-muted-foreground">
            {t("cloudConfigTitle")}
          </span>
        </div>
        <button
          className="shrink-0 rounded-[6px] border border-input px-3 py-1 text-[11px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
          onClick={() => {
            resetForm();
            setShowAdd(true);
          }}
          type="button"
        >
          {t("cloudAddConfig")}
        </button>
      </div>

      <Dialog onOpenChange={setShowAdd} open={showAdd}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>{t("cloudAddConfig")}</DialogTitle>
            <DialogDescription>{t("cloudAddConfigHint")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-2.5">
            <div className="flex gap-2 max-sm:flex-col">
              <FilterDropdown
                ariaLabel={t("cloudConfigTitle")}
                className="shrink-0"
                onChange={(value) => setProvider(value as "webdav" | "s3")}
                options={[
                  { label: "WebDAV", value: "webdav" },
                  { label: "Amazon S3", value: "s3" },
                ]}
                placeholder={t("cloudConfigTitle")}
                value={provider}
              />
              <input
                className="h-8 min-w-0 flex-1 rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                onChange={(e) => setName(e.target.value)}
                placeholder={t("cloudConfigNamePlaceholder")}
                value={name}
              />
            </div>

            {provider === "webdav" ? (
              <>
                <input
                  className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="WebDAV URL"
                  value={url}
                />
                <input
                  className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={t("username")}
                  value={username}
                />
                <input
                  className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder={t("password")}
                  type="password"
                  value={password}
                />
              </>
            ) : (
              <>
                <input
                  className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="Endpoint URL"
                  value={endpoint}
                />
                <input
                  className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setAccessKey(e.target.value)}
                  placeholder="Access Key"
                  value={accessKey}
                />
                <input
                  className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder="Secret Key"
                  type="password"
                  value={secretKey}
                />
                <div className="flex gap-2 max-sm:flex-col">
                  <input
                    className="h-8 min-w-0 flex-1 rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                    onChange={(e) => setBucket(e.target.value)}
                    placeholder="Bucket"
                    value={bucket}
                  />
                  <input
                    className="h-8 w-[45%] shrink-0 rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary max-sm:w-full"
                    onChange={(e) => setRegion(e.target.value)}
                    placeholder="Region"
                    value={region}
                  />
                </div>
                <input
                  className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setPublicBase(e.target.value)}
                  placeholder="Public Base URL (e.g. https://img.example.cn)"
                  value={publicBase}
                />
              </>
            )}
          </div>

          <DialogFooter>
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setShowAdd(false)}
              type="button"
            >
              {t("cancel")}
            </button>
            <button
              className="rounded-[6px] bg-primary px-4 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              disabled={!name.trim() || saving}
              onClick={handleSave}
              type="button"
            >
              {saving ? t("saving") : t("save")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {loading && <ConfigSkeleton />}

      {!loading && configs.length > 0 && (
        <div className="space-y-1 border-border border-t pt-3">
          {configs.map((cfg) => (
            <div
              className="flex items-center justify-between gap-2 rounded-[6px] px-1 py-1.5 hover:bg-foreground/5"
              key={cfg.id}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate text-[12px] text-foreground">
                  {cfg.name}
                </span>
                <span className="shrink-0 rounded-[4px] bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground/70">
                  {PROVIDER_LABELS[cfg.provider] || cfg.provider}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {testStates[cfg.id] && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className={`max-w-[180px] truncate text-[10px] ${
                          testStates[cfg.id].success
                            ? "text-[#46a758]"
                            : "text-[#e5484d]"
                        }`}
                        tabIndex={0}
                      >
                        {testStates[cfg.id].result}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {testStates[cfg.id].result}
                    </TooltipContent>
                  </Tooltip>
                )}
                <button
                  className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground disabled:opacity-40"
                  disabled={testingId !== null}
                  onClick={() => handleTestConnection(cfg.id)}
                  type="button"
                >
                  {testingId === cfg.id ? t("cloudTesting") : t("test")}
                </button>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={t("delete")}
                      className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-[#e5484d]"
                      onClick={() => setDeleteConfirmId(cfg.id)}
                      type="button"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{t("delete")}</TooltipContent>
                </Tooltip>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && configs.length === 0 && (
        <p className="border-border border-t pt-3 text-[11px] text-muted-foreground/70">
          {t("cloudNoConfigShort")}
        </p>
      )}

      <ConfirmDialog
        confirmText={t("delete")}
        description={t("cloudDeleteConfirmDesc", {
          name: configs.find((c) => c.id === deleteConfirmId)?.name ?? "",
        })}
        destructive
        onCancel={() => setDeleteConfirmId(null)}
        onConfirm={confirmDelete}
        open={deleteConfirmId !== null}
        title={t("cloudDeleteConfirmTitle")}
      />
    </div>
  );
}
