import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { ipc } from "@/ipc/manager";

interface CameraStat { model: string; count: number; }
interface FocalStat { focalLength: string; count: number; }
interface DashboardData {
  totalPhotos: number; aiProcessed: number;
  cameraStats: CameraStat[]; focalStats: FocalStat[];
  dateRange: { earliest: number; latest: number } | null;
  avgIso: number;
}

const ACCENT = "#5e6ad2";
const ACCENT_HOVER = "#7c7fe0";
const GRID_COLOR = "rgba(255,255,255,0.04)";
const TEXT_SECONDARY = "#a1a1aa";
const TEXT_TERTIARY = "#6b6b75";

function DashboardPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const result = await ipc.client.photos.getStats({});
        setData(result as DashboardData);
      } catch { /* ignore */ }
      finally { setLoading(false); }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-[#5e6ad2] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const cameraData = (data?.cameraStats || []).map(c => ({
    name: c.model || "Unknown",
    count: c.count,
  }));

  const focalData = (data?.focalStats || [])
    .filter(f => f.focalLength)
    .map(f => ({ name: `${f.focalLength}mm`, count: f.count }))
    .slice(0, 12);

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="flex items-center gap-4 px-6 py-4 border-b border-[rgba(255,255,255,0.06)]">
        <button onClick={() => navigate({ to: "/" })} className="text-[#a1a1aa] hover:text-[#f7f8f8]">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <h1 className="text-[#f7f8f8] text-[18px] font-[590]">{t("dashboardTitle")}</h1>
      </div>

      <div className="p-6 space-y-6">
        <div className="grid grid-cols-4 gap-4">
          <StatCard label={t("totalPhotos")} value={data?.totalPhotos.toLocaleString() || "0"} />
          <StatCard label={t("aiProcessed")} value={data?.aiProcessed.toLocaleString() || "0"} />
          <StatCard
            label={t("dateRange")}
            value={data?.dateRange
              ? `${new Date(data.dateRange.earliest).getFullYear()} - ${new Date(data.dateRange.latest).getFullYear()}`
              : "—"}
          />
          <StatCard label={t("avgIso")} value={data?.avgIso ? Math.round(data.avgIso).toString() : "—"} />
        </div>

        <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-5">
          <h2 className="text-[#f7f8f8] text-[16px] font-[590] mb-4">{t("cameraUsage")}</h2>
          {cameraData.length > 0 ? (
            <ResponsiveContainer width="100%" height={cameraData.length * 36 + 20}>
              <BarChart data={cameraData} layout="vertical" margin={{ top: 0, right: 20, left: 140, bottom: 0 }}>
                <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} />
                <YAxis type="category" dataKey="name" axisLine={false} tickLine={false} tick={{ fill: TEXT_SECONDARY, fontSize: 12 }} width={130} />
                <Tooltip
                  contentStyle={{ background: "#1c1e22", border: "1px solid #2c2c30", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "#f7f8f8" }}
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {cameraData.map((_, i) => (
                    <Cell key={i} fill={ACCENT} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-[#6b6b75] text-[13px]">{t("noCameraData")}</p>
          )}
        </div>

        <div className="bg-[#121214] rounded-[8px] border border-[rgba(255,255,255,0.06)] p-5">
          <h2 className="text-[#f7f8f8] text-[16px] font-[590] mb-4">{t("focalDistribution")}</h2>
          {focalData.length > 0 ? (
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={focalData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 10 }} angle={-45} textAnchor="end" height={40} />
                <YAxis axisLine={false} tickLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: "#1c1e22", border: "1px solid #2c2c30", borderRadius: 6, fontSize: 12 }}
                  labelStyle={{ color: "#f7f8f8" }}
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {focalData.map((_, i) => (
                    <Cell key={i} fill={ACCENT} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-[#6b6b75] text-[13px]">{t("noFocalData")}</p>
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

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });
