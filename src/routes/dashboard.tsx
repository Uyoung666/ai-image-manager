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
  shutterSpeedDistribution: BucketStat[];
  yearlyStats: { count: number; year: string }[];
  monthlyStats: { count: number; month: string }[];
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

  const shutterData = (data?.shutterSpeedDistribution || []).map((b) => {
    const parts = b.range?.split("-");
    const getApproxSeconds = (label: string): number | undefined => {
      if (label.startsWith(">")) {
        // ">1/1000s" → 1/2000 as representative
        const m = label.match(/>1\/(\d+)s/);
        if (m) return 0.5 / Number.parseFloat(m[1]);
      }
      if (label.startsWith("<")) {
        // "<1/30s" → 1/15 as representative
        const m = label.match(/<1\/(\d+)s/);
        if (m) return 2 / Number.parseFloat(m[1]);
      }
      const m = label.match(/1\/(\d+)s-1\/(\d+)s/);
      if (m) {
        const lo = Number.parseFloat(m[1]);
        const hi = Number.parseFloat(m[2]);
        return (1 / lo + 1 / hi) / 2;
      }
      return undefined;
    };
    const approxSec = getApproxSeconds(b.range || "");
    return {
      name: b.range || "",
      count: b.count,
      shutterMin: approxSec !== undefined ? approxSec * 0.7 : undefined,
      shutterMax: approxSec !== undefined ? approxSec * 1.3 : undefined,
    };
  });

  const yearlyData = (data?.yearlyStats || []).map((y) => {
    const year = Number.parseInt(y.year, 10);
    return {
      name: y.year,
      count: y.count,
      dateFrom: `${year}-01-01`,
      dateTo: `${year}-12-31`,
    };
  });

  const MONTH_LABELS = ["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
  const monthCountMap = new Map<number, number>();
  for (const m of data?.monthlyStats || []) {
    const idx = Number.parseInt(m.month, 10);
    if (idx >= 1 && idx <= 12) monthCountMap.set(idx, m.count);
  }
  const monthlyData = MONTH_LABELS.map((name, i) => ({
    name,
    count: monthCountMap.get(i + 1) || 0,
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
                  animationDuration={800}
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
                  animationDuration={800}
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
                    animationDuration={800}
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
                    animationDuration={800}
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
                    animationDuration={800}
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
                  <Bar animationDuration={800} dataKey="count" radius={[3, 3, 0, 0]}>
                    {timeData.map((_, i) => (<Cell fill={CHART_1} key={i} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (<EmptyHint text="暂无拍摄时间数据" />)}
          </ChartSection>
        </div>

        {/* Shutter Speed Distribution */}
        <ChartSection hint="点击查看" title={t("shutterDistribution")}>
          {shutterData.length > 0 && shutterData.some((d) => d.count > 0) ? (
            <ResponsiveContainer height={180} width="100%">
              <BarChart data={shutterData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                <XAxis angle={-45} axisLine={false} dataKey="name" height={40} textAnchor="end" tick={{ fill: TEXT_TERTIARY, fontSize: 10 }} tickLine={false} />
                <YAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                <Tooltip {...chartTooltipStyle} />
                <Bar
                  animationDuration={800}
                  className="cursor-pointer"
                  dataKey="count"
                  onClick={(entry) => {
                    if (entry.shutterMin !== undefined && entry.shutterMax !== undefined) {
                      drillToHome({
                        shutterMin: String(entry.shutterMin),
                        shutterMax: String(entry.shutterMax),
                      });
                    }
                  }}
                  radius={[4, 4, 0, 0]}
                >
                  {shutterData.map((_, i) => (<Cell fill={CHART_5} key={i} />))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (<EmptyHint text="暂无快门速度数据" />)}
        </ChartSection>

        {/* Yearly & Monthly Distribution */}
        <div className="grid grid-cols-2 gap-4">
          <ChartSection hint="点击年份可查看" title={t("yearlyDistribution")}>
            {yearlyData.length > 0 ? (
              <ResponsiveContainer height={200} width="100%">
                <BarChart data={yearlyData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                  <XAxis axisLine={false} dataKey="name" tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <YAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <Tooltip {...chartTooltipStyle} />
                  <Bar
                    animationDuration={800}
                    className="cursor-pointer"
                    dataKey="count"
                    onClick={(entry) => {
                      if (entry.dateFrom && entry.dateTo) {
                        drillToHome({ dateFrom: entry.dateFrom, dateTo: entry.dateTo });
                      }
                    }}
                    radius={[4, 4, 0, 0]}
                  >
                    {yearlyData.map((_, i) => (<Cell fill={CHART_2} key={i} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (<EmptyHint text="暂无拍摄年份数据" />)}
          </ChartSection>

          <ChartSection title={t("monthlyDistribution")}>
            {monthlyData.some((d) => d.count > 0) ? (
              <ResponsiveContainer height={200} width="100%">
                <BarChart data={monthlyData} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
                  <XAxis axisLine={false} dataKey="name" tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <YAxis axisLine={false} tick={{ fill: TEXT_TERTIARY, fontSize: 11 }} tickLine={false} />
                  <Tooltip {...chartTooltipStyle} />
                  <Bar animationDuration={800} dataKey="count" radius={[4, 4, 0, 0]}>
                    {monthlyData.map((_, i) => (<Cell fill={CHART_4} key={i} />))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (<EmptyHint text="暂无拍摄月份数据" />)}
          </ChartSection>
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-border bg-secondary p-4">
      <p className="font-[510] text-muted-foreground/70 text-[11px] uppercase tracking-wider">{label}</p>
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
          <span className="text-muted-foreground/70 text-[10px]">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-muted-foreground/70 text-[13px]">{text}</p>;
}

export const Route = createFileRoute("/dashboard")({ component: DashboardPage });
