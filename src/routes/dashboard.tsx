import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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

interface CameraStat { count: number; model: string; }
interface LensStat { count: number; model: string; }
interface FocalStat { count: number; focalLength: string; }
interface ApertureStat { aperture: number; count: number; }
interface BucketStat { count: number; range?: string; period?: string; }
interface DashboardData {
  aiProcessed: number;
  apertureStats: ApertureStat[];
  avgIso: number;
  cameraStats: CameraStat[];
  lensStats: LensStat[];
  dateRange: { earliest: number; latest: number } | null;
  focalStats: FocalStat[];
  isoDistribution: BucketStat[];
  timeHeatmap: BucketStat[];
  totalPhotos: number;
}

const CHART_1 = "var(--chart-1)";
const CHART_2 = "var(--chart-2)";
const CHART_3 = "var(--chart-3)";
const CHART_4 = "var(--chart-4)";
const CHART_5 = "var(--chart-5)";
const TEXT_SECONDARY = "#a1a1aa";
const TEXT_TERTIARY = "#6b6b75";

const chartTooltipStyle = {
  contentStyle: {
    background: "hsl(220 10% 12%)",
    border: "1px solid hsl(240 4% 18%)",
    borderRadius: 6,
    fontSize: 12,
  },
  cursor: { fill: "rgba(255,255,255,0.05)" },
  labelStyle: { color: "hsl(180 8% 97%)" },
};

// Focal length to range mapping: "85" → { min: 75, max: 95 }
function focalToRange(focalRaw: string): { min: number; max: number } | null {
  const n = Number.parseFloat(focalRaw);
  if (Number.isNaN(n) || n <= 0) return null;
  // Round to nearest 5mm bucket
  const bucket = Math.round(n / 5) * 5;
  const half = bucket >= 50 ? 10 : 3;
  return { min: bucket - half, max: bucket + half };
}

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
      } catch { /* ignore */ } finally { setLoading(false); }
    })();
  }, []);

  const drillToHome = useCallback(
    (params: Record<string, string>) => {
      navigate({ to: "/", search: params });
    },
    [navigate],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  const cameraData = (data?.cameraStats || []).map((c) => ({
    name: c.model || "Unknown",
    count: c.count,
    cameraModel: c.model,
  }));

  const lensData = (data?.lensStats || []).map((l) => ({
    name: l.model,
    count: l.count,
    lensModel: l.model,
  }));

  const focalData = (data?.focalStats || [])
    .filter((f) => f.focalLength)
    .map((f) => {
      const range = focalToRange(f.focalLength);
      return {
        name: `${f.focalLength}mm`,
        count: f.count,
        focalMin: range?.min,
        focalMax: range?.max,
      };
    })
    .slice(0, 12);

  const apertureData = (data?.apertureStats || [])
    .filter((a) => a.aperture)
    .map((a) => ({
      name: `f/${a.aperture}`,
      count: a.count,
      apertureMin: (a.aperture - 0.2).toFixed(1),
      apertureMax: (a.aperture + 0.2).toFixed(1),
    }))
    .slice(0, 10);

  const isoData = (data?.isoDistribution || []).map((b) => {
    // Parse "100-400" → { min: 100, max: 400 }
    const parts = b.range?.split("-");
    return {
      name: b.range || "",
      count: b.count,
      isoMin: parts?.[0],
      isoMax: parts?.[1],
    };
  });

  const timeData = (data?.timeHeatmap || []).map((b) => ({
    name: b.period,
    count: b.count,
  }));

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <div className="flex items-center gap-4 border-border border-b px-6 py-4">
        <button className="text-muted-foreground hover:text-foreground" onClick={() => navigate({ to: "/" })}>
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-[590] text-foreground text-[18px]">{t("dashboardTitle")}</h1>
      </div>

      <div className="space-y-6 p-6">
        {/* Stat Cards */}
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

        {/* Camera Usage */}
        <ChartSection hint="点击查看" title={t("cameraUsage")}>
          {cameraData.length > 0 ? (
            <ResponsiveContainer height={cameraData.length * 36 + 20} width="100%">
              <BarChart data={cameraData} layout="vertical" margin={{ top: 0, right: 20, left: 140, bottom: 0 }}>
                <XAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} type="number" />
                <YAxis axisLine={false} dataKey="name" tick={{ fill: TEXT_SECONDARY, fontSize: 12 }} tickLine={false} type="category" width={130} />
                <Tooltip {...chartTooltipStyle} />
                <Bar
                  className="cursor-pointer"
                  dataKey="count"
                  onClick={(entry) => {
                    if (entry.cameraModel) {
                      drillToHome({ cameraModel: entry.cameraModel });
                    }
                  }}
                  radius={[0, 4, 4, 0]}
                >
                  {cameraData.map((_, i) => (<Cell fill={CHART_1} key={i} />))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (<EmptyHint text={t("noCameraData")} />)}
        </ChartSection>

        {/* Lens Usage */}
        {lensData.length > 0 && (
          <ChartSection hint="点击查看" title="镜头使用频率">
            <ResponsiveContainer height={lensData.length * 36 + 20} width="100%">
              <BarChart data={lensData} layout="vertical" margin={{ top: 0, right: 20, left: 160, bottom: 0 }}>
                <XAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} type="number" />
                <YAxis axisLine={false} dataKey="name" tick={{ fill: TEXT_SECONDARY, fontSize: 11 }} tickLine={false} type="category" width={150} />
                <Tooltip {...chartTooltipStyle} />
                <Bar
                  className="cursor-pointer"
                  dataKey="count"
                  onClick={() => {
                    // Lens drill-down — navigate with the lens model as camera filter
                    // (lensModel filter not yet in ExifFilters, skip for now)
                  }}
                  radius={[0, 4, 4, 0]}
                >
                  {lensData.map((_, i) => (<Cell fill={CHART_5} key={i} />))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </ChartSection>
        )}

        {/* Charts Grid 2×2 */}
        <div className="grid grid-cols-2 gap-4">
          <ChartSection hint="点击查看" title={t("focalDistribution")}>
            {focalData.length > 0 ? (
              <ResponsiveContainer height={180} width="100%">
                <BarChart data={focalData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                  <XAxis angle={-45} axisLine={false} dataKey="name" height={40} textAnchor="end" tick={{ fill: TEXT_TERTIARY, fontSize: 10 }} tickLine={false} />
                  <YAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <Tooltip {...chartTooltipStyle} />
                  <Bar
                    className="cursor-pointer"
                    dataKey="count"
                    onClick={(entry) => {
                      if (entry.focalMin && entry.focalMax) {
                        drillToHome({
                          focalMin: String(entry.focalMin),
                          focalMax: String(entry.focalMax),
                        });
                      }
                    }}
                    radius={[4, 4, 0, 0]}
                  >
                    {focalData.map((_, i) => (<Cell fill={CHART_2} key={i} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (<EmptyHint text={t("noFocalData")} />)}
          </ChartSection>

          <ChartSection hint="点击查看" title="光圈偏好">
            {apertureData.length > 0 ? (
              <ResponsiveContainer height={180} width="100%">
                <BarChart data={apertureData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                  <XAxis angle={-45} axisLine={false} dataKey="name" height={40} textAnchor="end" tick={{ fill: TEXT_TERTIARY, fontSize: 10 }} tickLine={false} />
                  <YAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <Tooltip {...chartTooltipStyle} />
                  <Bar
                    className="cursor-pointer"
                    dataKey="count"
                    onClick={(entry) => {
                      if (entry.apertureMin && entry.apertureMax) {
                        drillToHome({
                          apertureMin: entry.apertureMin,
                          apertureMax: entry.apertureMax,
                        });
                      }
                    }}
                    radius={[4, 4, 0, 0]}
                  >
                    {apertureData.map((_, i) => (<Cell fill={CHART_3} key={i} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (<EmptyHint text="暂无光圈数据" />)}
          </ChartSection>

          <ChartSection hint="点击查看" title="ISO 分布">
            {isoData.length > 0 && isoData.some((d) => d.count > 0) ? (
              <ResponsiveContainer height={180} width="100%">
                <BarChart data={isoData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                  <XAxis axisLine={false} dataKey="name" tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <YAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <Tooltip {...chartTooltipStyle} />
                  <Bar
                    className="cursor-pointer"
                    dataKey="count"
                    onClick={(entry) => {
                      if (entry.isoMin && entry.isoMax) {
                        drillToHome({
                          isoMin: entry.isoMin,
                          isoMax: entry.isoMax,
                        });
                      }
                    }}
                    radius={[4, 4, 0, 0]}
                  >
                    {isoData.map((_, i) => (<Cell fill={CHART_4} key={i} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (<EmptyHint text="暂无 ISO 数据" />)}
          </ChartSection>

          <ChartSection title="24小时拍摄分布">
            {timeData.length > 0 && timeData.some((d) => d.count > 0) ? (
              <ResponsiveContainer height={180} width="100%">
                <BarChart data={timeData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                  <XAxis angle={-90} axisLine={false} dataKey="name" height={40} interval={2} textAnchor="end" tick={{ fill: TEXT_TERTIARY, fontSize: 9 }} tickLine={false} />
                  <YAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <Tooltip {...chartTooltipStyle} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {timeData.map((_, i) => (<Cell fill={CHART_1} key={i} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (<EmptyHint text="暂无拍摄时间数据" />)}
          </ChartSection>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-border bg-secondary p-4">
      <p className="font-[510] text-[#6b6b75] text-[11px] uppercase tracking-wider">{label}</p>
      <p className="mt-1 font-[590] text-foreground text-[24px]">{value}</p>
    </div>
  );
}

function ChartSection({ title, children, hint }: { children: React.ReactNode; hint?: string; title: string }) {
  return (
    <div className="rounded-[8px] border border-border bg-secondary p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-[590] text-foreground text-[16px]">{title}</h2>
        {hint && (
          <span className="text-[#6b6b75] text-[10px]">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-[#6b6b75] text-[13px]">{text}</p>;
}

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });
