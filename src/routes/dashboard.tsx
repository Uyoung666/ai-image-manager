import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ipc } from "@/ipc/manager";

interface CameraStat {
  count: number;
  model: string;
}
interface FocalStat {
  count: number;
  focalLength: string;
}
interface DashboardData {
  aiProcessed: number;
  avgIso: number;
  cameraStats: CameraStat[];
  dateRange: { earliest: number; latest: number } | null;
  focalStats: FocalStat[];
  totalPhotos: number;
}

const ACCENT = "#5e6ad2";
const _ACCENT_HOVER = "#7c7fe0";
const _GRID_COLOR = "rgba(255,255,255,0.04)";
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
      } catch {
        /* ignore */
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-[#5e6ad2] border-t-transparent" />
      </div>
    );
  }

  const cameraData = (data?.cameraStats || []).map((c) => ({
    name: c.model || "Unknown",
    count: c.count,
  }));

  const focalData = (data?.focalStats || [])
    .filter((f) => f.focalLength)
    .map((f) => ({ name: `${f.focalLength}mm`, count: f.count }))
    .slice(0, 12);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-4 border-[rgba(255,255,255,0.06)] border-b px-6 py-4">
        <button
          className="text-[#a1a1aa] hover:text-[#f7f8f8]"
          onClick={() => navigate({ to: "/" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-[590] text-[#f7f8f8] text-[18px]">
          {t("dashboardTitle")}
        </h1>
      </div>

      <div className="space-y-6 p-6">
        <div className="grid grid-cols-4 gap-4">
          <StatCard
            label={t("totalPhotos")}
            value={data?.totalPhotos.toLocaleString() || "0"}
          />
          <StatCard
            label={t("aiProcessed")}
            value={data?.aiProcessed.toLocaleString() || "0"}
          />
          <StatCard
            label={t("dateRange")}
            value={
              data?.dateRange
                ? `${new Date(data.dateRange.earliest).getFullYear()} - ${new Date(data.dateRange.latest).getFullYear()}`
                : "—"
            }
          />
          <StatCard
            label={t("avgIso")}
            value={data?.avgIso ? Math.round(data.avgIso).toString() : "—"}
          />
        </div>

        <div className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#121214] p-5">
          <h2 className="mb-4 font-[590] text-[#f7f8f8] text-[16px]">
            {t("cameraUsage")}
          </h2>
          {cameraData.length > 0 ? (
            <ResponsiveContainer
              height={cameraData.length * 36 + 20}
              width="100%"
            >
              <BarChart
                data={cameraData}
                layout="vertical"
                margin={{ top: 0, right: 20, left: 140, bottom: 0 }}
              >
                <XAxis
                  axisLine={false}
                  tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
                  tickLine={false}
                  type="number"
                />
                <YAxis
                  axisLine={false}
                  dataKey="name"
                  tick={{ fill: TEXT_SECONDARY, fontSize: 12 }}
                  tickLine={false}
                  type="category"
                  width={130}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1c1e22",
                    border: "1px solid #2c2c30",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                  labelStyle={{ color: "#f7f8f8" }}
                />
                <Bar dataKey="count" radius={[0, 4, 4, 0]}>
                  {cameraData.map((_, i) => (
                    <Cell fill={ACCENT} key={i} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <p className="text-[#6b6b75] text-[13px]">{t("noCameraData")}</p>
          )}
        </div>

        <div className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#121214] p-5">
          <h2 className="mb-4 font-[590] text-[#f7f8f8] text-[16px]">
            {t("focalDistribution")}
          </h2>
          {focalData.length > 0 ? (
            <ResponsiveContainer height={180} width="100%">
              <BarChart
                data={focalData}
                margin={{ top: 0, right: 0, left: 0, bottom: 20 }}
              >
                <XAxis
                  angle={-45}
                  axisLine={false}
                  dataKey="name"
                  height={40}
                  textAnchor="end"
                  tick={{ fill: TEXT_TERTIARY, fontSize: 10 }}
                  tickLine={false}
                />
                <YAxis
                  axisLine={false}
                  tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
                  tickLine={false}
                />
                <Tooltip
                  contentStyle={{
                    background: "#1c1e22",
                    border: "1px solid #2c2c30",
                    borderRadius: 6,
                    fontSize: 12,
                  }}
                  cursor={{ fill: "rgba(255,255,255,0.03)" }}
                  labelStyle={{ color: "#f7f8f8" }}
                />
                <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                  {focalData.map((_, i) => (
                    <Cell fill={ACCENT} key={i} />
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
    <div className="rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[#121214] p-4">
      <p className="font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-1 font-[590] text-[#f7f8f8] text-[24px]">{value}</p>
    </div>
  );
}

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});
