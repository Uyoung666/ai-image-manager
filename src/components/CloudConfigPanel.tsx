import { Cloud, Link2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/ConfirmDialog";
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
      /* ignore */
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    loadConfigs();
  }, [loadConfigs]);

  function resetForm() {
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
      loadConfigs();
    } catch {
      /* ignore */
    }
    setSaving(false);
  }

  async function handleDelete(id: number) {
    setDeleteConfirmId(id);
  }

  async function confirmDelete() {
    if (deleteConfirmId === null) {
      return;
    }
    try {
      await ipc.client.cloud.deleteCloudConfig({ id: deleteConfirmId });
      setDeleteConfirmId(null);
      loadConfigs();
    } catch {
      /* ignore */
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
      if (result.success) {
        setTestStates((prev) => ({
          ...prev,
          [id]: {
            result: t("cloudConnectionSuccess", { latency: result.latencyMs }),
            success: true,
          },
        }));
      } else {
        setTestStates((prev) => ({
          ...prev,
          [id]: {
            result: t("cloudConnectionFailed", {
              error: result.error || t("cloudUnknownError"),
            }),
            success: false,
          },
        }));
      }
    } catch {
      setTestStates((prev) => ({
        ...prev,
        [id]: { result: t("cloudTestException"), success: false },
      }));
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
        >
          {t("cloudAddConfig")}
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="space-y-2.5 border-border border-t pt-3">
          {/* Row 1: Provider + Name */}
          <div className="flex gap-2">
            <select
              className="h-8 shrink-0 rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none focus:border-primary"
              onChange={(e) => setProvider(e.target.value as "webdav" | "s3")}
              value={provider}
            >
              <option value="webdav">WebDAV</option>
              <option value="s3">Amazon S3</option>
            </select>
            <input
              className="h-8 min-w-0 flex-1 rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
              onChange={(e) => setName(e.target.value)}
              placeholder={t("cloudConfigNamePlaceholder")}
              value={name}
            />
          </div>

          {provider === "webdav" ? (
            <>
              {/* WebDAV URL */}
              <input
                className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                onChange={(e) => setUrl(e.target.value)}
                placeholder="WebDAV URL"
                value={url}
              />
              {/* Username */}
              <input
                className="h-8 w-full rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                onChange={(e) => setUsername(e.target.value)}
                placeholder={t("username")}
                value={username}
              />
              {/* Password */}
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
              {/* Bucket + Region side by side — short values, won't overflow */}
              <div className="flex gap-2">
                <input
                  className="h-8 min-w-0 flex-1 rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                  onChange={(e) => setBucket(e.target.value)}
                  placeholder="Bucket"
                  value={bucket}
                />
                <input
                  className="h-8 w-[45%] shrink-0 rounded-[6px] border border-input bg-card px-2.5 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
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

          {/* Action buttons */}
          <div className="flex gap-2 pt-0.5">
            <button
              className="rounded-[6px] bg-primary px-4 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-40"
              disabled={!name.trim() || saving}
              onClick={handleSave}
            >
              {t("save")}
            </button>
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => setShowAdd(false)}
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      )}

      {/* Existing configs */}
      {!loading && configs.length > 0 && (
        <div className="space-y-1 border-border border-t pt-3">
          {configs.map((cfg) => (
            <div
              className="flex items-center justify-between gap-2 rounded-[4px] py-1"
              key={cfg.id}
            >
              <div className="flex min-w-0 items-center gap-2">
                <Link2 className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="truncate text-[12px] text-foreground">
                  {cfg.name}
                </span>
                <span className="shrink-0 text-[10px] text-muted-foreground/70">
                  {PROVIDER_LABELS[cfg.provider] || cfg.provider}
                </span>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                {testStates[cfg.id] && (
                  <span
                    className={`shrink-0 text-[10px] ${testStates[cfg.id].success ? "text-[#46a758]" : "text-[#e5484d]"}`}
                  >
                    {testStates[cfg.id].result}
                  </span>
                )}
                <button
                  className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40"
                  disabled={testingId !== null}
                  onClick={() => handleTestConnection(cfg.id)}
                >
                  {t("test")}
                </button>
                <button
                  className="shrink-0 rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:text-[#e5484d]"
                  onClick={() => handleDelete(cfg.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {!loading && configs.length === 0 && !showAdd && (
        <p className="text-[11px] text-muted-foreground/70">
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
