import { createFileRoute, Link, Outlet, useMatch, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Play, RefreshCw, Trash2, User } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ipc } from "@/ipc/manager";

interface FaceIdentity {
  id: number;
  name: string | null;
  faceCount: number;
  representativePhotoId: number | null;
  coverThumbnailPath: string | null;
  createdAt: number;
}

function PeoplePage() {
  const [identities, setIdentities] = useState<FaceIdentity[]>([]);
  const [loading, setLoading] = useState(true);
  const [detecting, setDetecting] = useState(false);
  const [progress, setProgress] = useState<string>("");
  const navigate = useNavigate();

  const loadIdentities = useCallback(async () => {
    try {
      const result = await ipc.client.faces.listFaceIdentities({});
      setIdentities(result as FaceIdentity[]);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIdentities();
  }, [loadIdentities]);

  async function handleStartDetection(rescan = false) {
    setDetecting(true);
    setProgress(rescan ? "正在重新扫描所有照片..." : "正在启动人脸检测...");
    try {
      const result = await ipc.client.faces.startFaceDetection({ rescan }) as { started: boolean; photoCount?: number; message?: string };
      if (result.started) {
        setProgress(`正在检测 ${result.photoCount} 张照片中的人脸...`);
        // Poll for progress
        const poll = setInterval(async () => {
          try {
            const p = await ipc.client.faces.getDetectionProgress({}) as { phase: string; processed: number; total?: number };
            if (p.phase === "complete") {
              setProgress(`检测完成！已处理 ${p.processed} 张照片`);
              clearInterval(poll);
              setDetecting(false);
              loadIdentities();
            } else if (p.phase === "running") {
              setProgress(`检测中... ${p.processed}/${p.total}`);
            } else {
              clearInterval(poll);
              setDetecting(false);
              setProgress("");
            }
          } catch {
            clearInterval(poll);
            setDetecting(false);
          }
        }, 2000);
      } else {
        setProgress(result.message || "启动失败");
        setDetecting(false);
      }
    } catch {
      setProgress("启动人脸检测失败");
      setDetecting(false);
    }
  }

  async function handleRecluster() {
    setDetecting(true);
    setProgress("正在重新聚类...");
    try {
      const result = await ipc.client.faces.recluster({}) as { ok: boolean; identityCount?: number; message?: string };
      if (result.ok) {
        setProgress(`聚类完成！共 ${result.identityCount} 个人物分组`);
        loadIdentities();
      } else {
        setProgress(result.message || "聚类失败");
      }
    } catch {
      setProgress("重新聚类失败");
    } finally {
      setDetecting(false);
    }
  }

  async function handleDeleteIdentity(id: number, name: string | null) {
    if (!confirm(`确定删除人物"${name || "未命名"}"？此操作不可撤销。`)) return;
    try {
      await ipc.client.faces.deleteFaceIdentity({ id });
      loadIdentities();
    } catch {
      /* ignore */
    }
  }

  function toLocalMediaUrl(filePath: string): string {
    const encoded = filePath
      .replace(/\\/g, "/")
      .split("/")
      .map((s) => encodeURIComponent(s))
      .join("/");
    return `local-media://${encoded}`;
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="font-[590] text-[24px] text-foreground tracking-tight">
              人物
            </h1>
            <p className="mt-0.5 text-[#6b6b75] text-[12px]">
              {identities.length > 0
                ? `${identities.length} 个人物分组`
                : "人脸识别与人物管理"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {identities.length > 0 && (
            <>
              <button
                className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-[13px] font-[510] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                disabled={detecting}
                onClick={handleRecluster}
                title="重新聚类现有人脸数据"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重新聚类
              </button>
              <button
                className="flex items-center gap-1.5 rounded-[6px] border border-border px-3 py-1.5 text-[13px] font-[510] text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                disabled={detecting}
                onClick={() => handleStartDetection(true)}
                title="清除所有数据并重新扫描"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重新扫描
              </button>
            </>
          )}
          <button
            className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={detecting}
            onClick={() => handleStartDetection(false)}
          >
            <Play className="h-3.5 w-3.5" />
            {detecting ? "检测中..." : "开始人脸检测"}
          </button>
        </div>
      </div>

      {/* Progress */}
      {progress && (
        <div className="border-border border-b bg-primary/5 px-6 py-2 text-[12px] text-primary">
          {detecting && (
            <span className="mr-2 inline-block h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          )}
          {progress}
        </div>
      )}

      {/* Grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <div
                className="aspect-[3/4] animate-pulse rounded-[8px] bg-card"
                key={i}
              />
            ))}
          </div>
        ) : identities.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 text-[#6b6b75]">
            <User className="h-12 w-12 opacity-20" />
            <p className="text-[13px]">还没有检测到人物</p>
            <p className="text-[11px] text-[#6b6b75]/60">
              点击"开始人脸检测"来分析照片中的人物
            </p>
            <button
              className="mt-2 rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90"
              disabled={detecting}
              onClick={() => handleStartDetection(false)}
            >
              开始检测
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-4">
            {identities.map((identity) => (
              <div
                className="group relative overflow-hidden rounded-[8px] border border-border bg-card transition-colors hover:border-primary/30"
                key={identity.id}
              >
                <Link
                  className="block"
                  to="/people/$identityId"
                  params={{ identityId: identity.id.toString() }}
                >
                  <div className="aspect-[3/4] bg-muted">
                    {identity.coverThumbnailPath ? (
                      <img
                        alt={identity.name || "未命名"}
                        className="h-full w-full object-cover"
                        src={toLocalMediaUrl(identity.coverThumbnailPath)}
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center">
                        <User className="h-12 w-12 text-muted-foreground/30" />
                      </div>
                    )}
                  </div>
                  <div className="p-3">
                    <h3 className="truncate font-[510] text-[13px] text-foreground">
                      {identity.name || "未命名"}
                    </h3>
                    <p className="mt-0.5 text-[#6b6b75] text-[11px]">
                      {identity.faceCount} 张照片
                    </p>
                  </div>
                </Link>
                <button
                  className="absolute top-2 right-2 flex h-7 w-7 items-center justify-center rounded-[4px] bg-black/60 text-white opacity-0 transition-opacity hover:bg-[#e5484d] group-hover:opacity-100"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    handleDeleteIdentity(identity.id, identity.name);
                  }}
                  title="删除此人物"
                  type="button"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function PeopleLayout() {
  const childMatch = useMatch({ from: "/people/$identityId", shouldThrow: false });
  if (childMatch) {
    return <Outlet />;
  }
  return <PeoplePage />;
}

export const Route = createFileRoute("/people" as "/people")({
  component: PeopleLayout,
});
