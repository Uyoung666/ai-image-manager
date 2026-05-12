import { Cloud, Link2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/ipc/manager";

interface CloudConfig {
  id: number;
  name: string;
  provider: string;
  configJson: string;
  isDefault: boolean;
  createdAt: number;
}

const PROVIDER_LABELS: Record<string, string> = {
  webdav: "WebDAV",
  s3: "Amazon S3",
};

export function CloudConfigPanel() {
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
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<string>("");
  const [testing, setTesting] = useState(false);

  const loadConfigs = useCallback(async () => {
    try {
      const result = await ipc.client.cloud.listCloudConfigs({});
      setConfigs(result as CloudConfig[]);
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  useEffect(() => { loadConfigs(); }, [loadConfigs]);

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
    setTestResult("");
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const config: Record<string, string> = provider === "webdav"
        ? { url, username, password }
        : { endpoint, accessKey, secretKey, bucket, region };
      await ipc.client.cloud.createCloudConfig({ name: name.trim(), provider, config });
      resetForm();
      setShowAdd(false);
      loadConfigs();
    } catch { /* ignore */ }
    setSaving(false);
  }

  async function handleDelete(id: number) {
    try {
      await ipc.client.cloud.deleteCloudConfig({ id });
      loadConfigs();
    } catch { /* ignore */ }
  }

  async function handleTestConnection(id: number) {
    setTesting(true);
    setTestResult("测试中...");
    try {
      const result = await ipc.client.cloud.testCloudConnection({ id }) as { success: boolean; latencyMs?: number; error?: string };
      if (result.success) {
        setTestResult(`连接成功 (${result.latencyMs}ms)`);
      } else {
        setTestResult(`连接失败: ${result.error || "未知错误"}`);
      }
    } catch {
      setTestResult("测试异常");
    }
    setTesting(false);
    setTimeout(() => setTestResult(""), 4000);
  }

  return (
    <div className="rounded-[8px] border border-border bg-secondary p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cloud className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground text-[13px]">云同步配置</span>
        </div>
        <button
          className="rounded-[6px] border border-input px-3 py-1 text-[11px] text-muted-foreground hover:border-muted-foreground/30 hover:text-foreground"
          onClick={() => { resetForm(); setShowAdd(true); }}
        >
          添加配置
        </button>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="space-y-2 border-border border-t pt-3">
          <div className="flex gap-2">
            <select
              className="h-7 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground"
              onChange={(e) => setProvider(e.target.value as "webdav" | "s3")}
              value={provider}
            >
              <option value="webdav">WebDAV</option>
              <option value="s3">Amazon S3</option>
            </select>
            <input
              className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary"
              onChange={(e) => setName(e.target.value)}
              placeholder="配置名称"
              value={name}
            />
          </div>

          {provider === "webdav" ? (
            <>
              <input className="h-7 w-full rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setUrl(e.target.value)} placeholder="WebDAV URL" value={url} />
              <div className="flex gap-2">
                <input className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setUsername(e.target.value)} placeholder="用户名" value={username} />
                <input className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setPassword(e.target.value)} placeholder="密码" type="password" value={password} />
              </div>
            </>
          ) : (
            <>
              <input className="h-7 w-full rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setEndpoint(e.target.value)} placeholder="Endpoint URL" value={endpoint} />
              <input className="h-7 w-full rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setAccessKey(e.target.value)} placeholder="Access Key" value={accessKey} />
              <input className="h-7 w-full rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setSecretKey(e.target.value)} placeholder="Secret Key" type="password" value={secretKey} />
              <div className="flex gap-2">
                <input className="h-7 flex-1 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setBucket(e.target.value)} placeholder="Bucket" value={bucket} />
                <input className="h-7 w-24 rounded-[4px] border border-input bg-card px-2 text-[11px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary" onChange={(e) => setRegion(e.target.value)} placeholder="Region" value={region} />
              </div>
            </>
          )}

          <div className="flex gap-2">
            <button
              className="rounded-[4px] bg-primary px-3 py-1 text-[11px] text-white hover:opacity-90 disabled:opacity-40"
              disabled={!name.trim() || saving}
              onClick={handleSave}
            >
              保存
            </button>
            <button
              className="rounded-[4px] border border-input px-3 py-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowAdd(false)}
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Existing configs */}
      {!loading && configs.length > 0 && (
        <div className="space-y-1.5 border-border border-t pt-3">
          {configs.map((cfg) => (
            <div className="flex items-center justify-between rounded-[4px] py-1" key={cfg.id}>
              <div className="flex items-center gap-2">
                <Link2 className="h-3 w-3 text-muted-foreground" />
                <span className="text-[12px] text-foreground">{cfg.name}</span>
                <span className="text-[10px] text-[#6b6b75]">{PROVIDER_LABELS[cfg.provider] || cfg.provider}</span>
              </div>
              <div className="flex items-center gap-1">
                {testResult && (
                  <span className={`text-[10px] ${testResult.includes("成功") ? "text-[#46a758]" : "text-[#e5484d]"}`}>
                    {testResult}
                  </span>
                )}
                <button
                  className="rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground disabled:opacity-40"
                  disabled={testing}
                  onClick={() => handleTestConnection(cfg.id)}
                >
                  测试
                </button>
                <button
                  className="rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-[#e5484d]"
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
        <p className="text-[#6b6b75] text-[11px]">暂无云同步配置</p>
      )}
    </div>
  );
}
