import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { ipc } from "@/ipc/manager";
import { ArrowLeft } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";

interface CameraStat { model: string; count: number; }
interface FocalStat { focalLength: string; count: number; }
interface DashboardData {
  totalPhotos: number;
  aiProcessed: number;
  cameraStats: CameraStat[];
  focalStats: FocalStat[];
  dateRange: { earliest: number; latest: number } | null;
  avgIso: number;
}

function DashboardPage() {
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const result = await ipc.client.photos.getStats({});
        setData(result as DashboardData);
      } catch (error) {
        console.error("Failed to load stats:", error);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-[#5e6ad2] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      {/* Header */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
        <button
          onClick={() => navigate({ to: "/" })}
          className="text-[#a1a1aa] hover:text-[#f7f8f8] transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-[#f7f8f8] text-[18px] font-[590]">Dashboard</h1>
      </div>

      <div className="p-6 space-y-6">
        {/* Stats Cards */}
        <div className="grid grid-cols-4 gap-4">
          <StatCard label="Total Photos" value={data?.totalPhotos.toLocaleString() || "0"} />
          <StatCard label="AI Processed" value={data?.aiProcessed.toLocaleString() || "0"} />
          <StatCard
            label="Date Range"
            value={data?.dateRange
              ? `${new Date(data.dateRange.earliest).getFullYear()} - ${new Date(data.dateRange.latest).getFullYear()}`
              : "N/A"
            }
          />
          <StatCard label="Avg ISO" value={data?.avgIso ? Math.round(data.avgIso).toString() : "N/A"} />
        </div>

        {/* Camera Stats */}
        <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-5">
          <h2 className="text-[#f7f8f8] text-[16px] font-[590] mb-4">Camera Usage</h2>
          {data?.cameraStats && data.cameraStats.length > 0 ? (
            <div className="space-y-3">
              {data.cameraStats.map((c, i) => {
                const maxCount = data.cameraStats[0].count;
                const pct = (c.count / maxCount) * 100;
                return (
                  <div key={i} className="flex items-center gap-3">
                    <span className="text-[#a1a1aa] text-[13px] w-[200px] truncate">{c.model}</span>
                    <div className="flex-1 h-5 bg-[#1c1e22] rounded-[4px] overflow-hidden">
                      <div
                        className="h-full bg-[#5e6ad2] rounded-[4px] transition-all"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[#6b6b75] text-[12px] w-12 text-right tabular-nums">{c.count}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[#6b6b75] text-[13px]">No camera data yet. Index photos with EXIF data.</p>
          )}
        </div>

        {/* Focal Length Distribution */}
        <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-5">
          <h2 className="text-[#f7f8f8] text-[16px] font-[590] mb-4">Focal Length Distribution</h2>
          {data?.focalStats && data.focalStats.length > 0 ? (
            <div className="flex items-end gap-2 h-[120px]">
              {data.focalStats.slice(0, 12).map((f, i) => {
                const maxCount = data.focalStats[0].count;
                const pct = (f.count / maxCount) * 100;
                return (
                  <div key={i} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full bg-[#5e6ad2] rounded-t-[4px] transition-all min-h-[4px]"
                      style={{ height: `${Math.max(pct, 4)}%` }}
                    />
                    <span className="text-[#6b6b75] text-[10px]">{f.focalLength}mm</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-[#6b6b75] text-[13px]">No focal length data yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-4">
      <p className="text-[#6b6b75] text-[11px] font-[510] uppercase tracking-wider">{label}</p>
      <p className="text-[#f7f8f8] text-[24px] font-[590] mt-1">{value}</p>
    </div>
  );
}

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});
