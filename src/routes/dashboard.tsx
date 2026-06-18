import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";

interface ChartClickState {
  activePayload?: { payload: Record<string, unknown> }[];
}

import { type GeoLocation, PhotoMap } from "@/components/PhotoMap";
import { ipc } from "@/ipc/manager";

interface CameraStat {
  count: number;
  model: string;
}
interface LensStat {
  count: number;
  model: string;
}
interface FocalStat {
  count: number;
  focalLength: string;
}
interface ApertureStat {
  aperture: number;
  count: number;
}
interface BucketStat {
  count: number;
  period?: string;
  range?: string;
}
interface DashboardData {
  aiProcessed: number;
  apertureStats: ApertureStat[];
  avgIso: number;
  cameraStats: CameraStat[];
  dateRange: { earliest: number; latest: number } | null;
  focalStats: FocalStat[];
  geoLocations: GeoLocation[];
  isoDistribution: BucketStat[];
  lensStats: LensStat[];
  monthlyStats: { count: number; month: string }[];
  shutterSpeedDistribution: BucketStat[];
  timeHeatmap: BucketStat[];
  totalPhotos: number;
  yearlyStats: { count: number; year: string }[];
}

interface ColorPaletteColor {
  b: number;
  g: number;
  hex: string;
  hue: number;
  lightness: number;
  r: number;
  saturation: number;
  weight: number;
}
interface HueBucket {
  count: number;
  hex: string;
  hueRange: [number, number];
  label: string;
}
interface SaturationBucket {
  count: number;
  label: string;
  level: "vivid" | "moderate" | "muted";
}
interface ColorDistributionUI {
  globalPalette: ColorPaletteColor[];
  hueDistribution: HueBucket[];
  sampled: number;
  saturationDistribution: SaturationBucket[];
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
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    fontSize: 13,
  },
  cursor: { fill: "var(--border)" },
  itemStyle: { color: "var(--popover-foreground)" },
  labelStyle: { color: "var(--popover-foreground)", fontWeight: 600 },
};

// Focal length to range mapping: "85" → { min: 75, max: 95 }
function focalToRange(focalRaw: string): { min: number; max: number } | null {
  const n = Number.parseFloat(focalRaw);
  if (Number.isNaN(n) || n <= 0) {
    return null;
  }
  // Round to nearest 5mm bucket
  const bucket = Math.round(n / 5) * 5;
  const half = bucket >= 50 ? 10 : 3;
  return { min: bucket - half, max: bucket + half };
}

function DashboardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const HUE_LABEL_KEYS: Record<number, string> = {
    0: "hueRed",
    30: "hueOrange",
    60: "hueYellow",
    90: "hueYellowGreen",
    120: "hueGreen",
    150: "hueSpringGreen",
    180: "hueCyan",
    210: "hueBlue",
    240: "hueBlueViolet",
    270: "huePurple",
    300: "hueMagenta",
    330: "huePink",
  };
  function getHueLabel(hueStart: number): string {
    return t(HUE_LABEL_KEYS[hueStart] || "hueRed");
  }

  const prefersReducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef, { getRouteKey: () => "dashboard" });

  // ── TanStack Query: single IPC call merges stats + colors ──────────
  const {
    data: rawData,
    isLoading,
    isError,
    refetch,
  } = useQuery({
    queryKey: ["dashboard"],
    queryFn: async () => {
      const result = (await ipc.client.photos.getStats({
        includeColors: true,
      })) as DashboardData & { colorDistribution?: ColorDistributionUI | null };
      return result;
    },
    staleTime: 30_000,
  });

  // React 19: defer chart recalc to keep page responsive
  const data = useDeferredValue(rawData ?? null);
  const colorData = (rawData as any)?.colorDistribution ?? null;

  const [mapSource, setMapSource] = useState<"offline" | "online">("offline");
  const [mapExpanded, setMapExpanded] = useState(false);
  const [colorVisible, setColorVisible] = useState(false);
  const colorRef = useRef<HTMLDivElement | null>(null);

  // Map source setting (lightweight, loaded once)
  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key: "mapSource" })
      .then((r) => {
        if (r?.value === "online") {
          setMapSource("online");
        }
      })
      .catch(() => {});
  }, []);

  // Auto-refresh dashboard when background import queue finishes
  useEffect(() => {
    function onMsg(e: MessageEvent) {
      if (e.data?.type === "import-queue-status") {
        const prev = (e.data as any).prevStatus;
        const next = (e.data as any).status;
        // Transition from running → done: invalidate to pick up new data
        if (prev === "processing" && next === "done") {
          queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        }
      }
    }
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [queryClient]);

  // IntersectionObserver: entrance animation when color section scrolls into view
  useEffect(() => {
    const el = colorRef.current;
    if (!(el && colorData)) {
      return;
    }
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0) {
      setColorVisible(true);
      return;
    }
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setColorVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.1 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [colorData]);

  const handleMapSourceChange = useCallback((source: "offline" | "online") => {
    setMapSource(source);
    ipc.client.settings
      .setAppSetting({ key: "mapSource", value: source })
      .catch(() => {});
  }, []);

  const drillToHome = useCallback(
    (params: Record<string, string>) => {
      navigate({ to: "/", search: params });
    },
    [navigate]
  );

  const cameraData = useMemo(
    () =>
      (data?.cameraStats || []).map((c) => ({
        name: c.model || "Unknown",
        count: c.count,
        cameraModel: c.model,
      })),
    [data?.cameraStats]
  );

  const lensData = useMemo(
    () =>
      (data?.lensStats || []).map((l) => ({
        name: l.model,
        count: l.count,
        lensModel: l.model,
      })),
    [data?.lensStats]
  );

  const focalData = useMemo(
    () =>
      (data?.focalStats || [])
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
        .sort((a, b) => {
          const na = Number.parseFloat(a.name);
          const nb = Number.parseFloat(b.name);
          if (!(Number.isNaN(na) || Number.isNaN(nb))) {
            return na - nb;
          }
          return 0;
        })
        .slice(0, 12),
    [data?.focalStats]
  );

  const apertureData = useMemo(
    () =>
      (data?.apertureStats || [])
        .filter((a) => a.aperture)
        .map((a) => ({
          name: `f/${a.aperture}`,
          count: a.count,
          apertureMin: (a.aperture - 0.2).toFixed(1),
          apertureMax: (a.aperture + 0.2).toFixed(1),
        }))
        .slice(0, 10),
    [data?.apertureStats]
  );

  const isoData = useMemo(
    () =>
      (data?.isoDistribution || []).map((b) => {
        // Parse "100-400" → { min: 100, max: 400 }
        const parts = b.range?.split("-");
        return {
          name: b.range || "",
          count: b.count,
          isoMin: parts?.[0],
          isoMax: parts?.[1],
        };
      }),
    [data?.isoDistribution]
  );

  const timeData = useMemo(
    () =>
      (data?.timeHeatmap || []).map((b) => ({
        name: b.period,
        count: b.count,
      })),
    [data?.timeHeatmap]
  );

  const shutterData = useMemo(
    () =>
      (data?.shutterSpeedDistribution || []).map((b) => {
        const parts = b.range?.split("-");
        const getApproxSeconds = (label: string): number | undefined => {
          if (label.startsWith(">")) {
            // ">1/1000s" → 1/2000 as representative
            const m = label.match(/>1\/(\d+)s/);
            if (m) {
              return 0.5 / Number.parseFloat(m[1]);
            }
          }
          if (label.startsWith("<")) {
            // "<1/30s" → 1/15 as representative
            const m = label.match(/<1\/(\d+)s/);
            if (m) {
              return 2 / Number.parseFloat(m[1]);
            }
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
          shutterMin: approxSec === undefined ? undefined : approxSec * 0.7,
          shutterMax: approxSec === undefined ? undefined : approxSec * 1.3,
        };
      }),
    [data?.shutterSpeedDistribution]
  );

  const yearlyData = useMemo(
    () =>
      (data?.yearlyStats || []).map((y) => {
        const year = Number.parseInt(y.year, 10);
        return {
          name: y.year,
          count: y.count,
          dateFrom: `${year}-01-01`,
          dateTo: `${year}-12-31`,
        };
      }),
    [data?.yearlyStats]
  );

  const monthlyData = useMemo(() => {
    const monthLabelFormatter = new Intl.DateTimeFormat(i18n.language, {
      month: "short",
    });
    const monthCountMap = new Map<number, number>();
    for (const m of data?.monthlyStats || []) {
      const idx = Number.parseInt(m.month, 10);
      if (idx >= 1 && idx <= 12) {
        monthCountMap.set(idx, m.count);
      }
    }
    return Array.from({ length: 12 }, (_, i) => ({
      name: monthLabelFormatter.format(new Date(2000, i, 1)),
      count: monthCountMap.get(i + 1) || 0,
    }));
  }, [data?.monthlyStats, i18n.language]);

  if (isLoading) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex items-center gap-4 border-border border-b px-6 py-4">
          <div className="h-5 w-5 animate-pulse rounded-[4px] bg-muted" />
          <div className="h-5 w-32 animate-pulse rounded-[4px] bg-muted" />
        </div>
        <div className="flex-1 space-y-6 overflow-y-auto p-6">
          {/* Stat cards skeleton */}
          <div className="grid grid-cols-4 gap-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div
                className="rounded-[8px] border border-border bg-card p-4"
                key={`stat-skel-${i}`}
              >
                <div className="mb-2 h-3 w-16 animate-pulse rounded-[3px] bg-muted" />
                <div className="h-7 w-20 animate-pulse rounded-[3px] bg-muted" />
              </div>
            ))}
          </div>
          {/* Map skeleton */}
          <div className="rounded-[8px] border border-border bg-card p-4">
            <div className="mb-3 h-4 w-20 animate-pulse rounded-[3px] bg-muted" />
            <div className="h-[300px] w-full animate-pulse rounded-[6px] bg-muted" />
          </div>
          {/* Color skeleton */}
          <div className="rounded-[8px] border border-border bg-card p-4">
            <div className="mb-3 h-4 w-24 animate-pulse rounded-[3px] bg-muted" />
            <div className="mb-3 h-6 w-full animate-pulse rounded-[4px] bg-muted" />
            <div className="mb-3 h-6 w-full animate-pulse rounded-[4px] bg-muted" />
            <div className="space-y-1.5">
              {Array.from({ length: 3 }).map((_, i) => (
                <div className="flex items-center gap-2" key={`clr-skel-${i}`}>
                  <div className="h-2 w-10 animate-pulse rounded-[2px] bg-muted" />
                  <div className="h-2 flex-1 animate-pulse rounded-[2px] bg-muted" />
                </div>
              ))}
            </div>
          </div>
          {/* Chart skeletons (6 charts) */}
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              className="rounded-[8px] border border-border bg-card p-4"
              key={`chart-skel-${i}`}
            >
              <div className="mb-3 h-4 w-24 animate-pulse rounded-[3px] bg-muted" />
              <div className="h-[200px] w-full animate-pulse rounded-[6px] bg-muted" />
            </div>
          ))}
          {/* Yearly / Monthly skeleton */}
          <div className="grid grid-cols-2 gap-4">
            {Array.from({ length: 2 }).map((_, i) => (
              <div
                className="rounded-[8px] border border-border bg-card p-4"
                key={`ym-skel-${i}`}
              >
                <div className="mb-3 h-4 w-20 animate-pulse rounded-[3px] bg-muted" />
                <div className="h-[200px] w-full animate-pulse rounded-[6px] bg-muted" />
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (isError && !data) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-danger/10">
          <svg
            aria-hidden="true"
            className="h-5 w-5 text-danger"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            viewBox="0 0 24 24"
          >
            <path
              d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <p className="font-medium text-[13px] text-foreground">
          {t("errorBoundaryTitle")}
        </p>
        <p className="text-[12px] text-muted-foreground">
          {t("dashboardLoadFailed")}
        </p>
        <button
          className="rounded-[6px] bg-primary/10 px-3 py-1.5 font-medium text-[12px] text-primary transition-colors hover:bg-primary/20"
          onClick={() => refetch()}
        >
          {t("retry")}
        </button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-4 border-border border-b px-6 py-4">
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => navigate({ to: "/" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-semibold text-[18px] text-foreground">
          {t("dashboardTitle")}
        </h1>
      </div>

      <div className="flex-1 space-y-6 overflow-y-auto p-6" ref={scrollRef}>
        {/* Stat Cards */}
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

        {/* GPS Map — collapsed by default */}
        <div className="rounded-[8px] border border-border bg-secondary p-5">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold text-[16px] text-foreground">
              {t("geoMap")}
            </h2>
            <button
              className="flex items-center gap-1 rounded-[6px] px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => setMapExpanded((v) => !v)}
              title={t("expandMap")}
            >
              <svg
                className="h-4 w-4 transition-transform"
                style={{ transform: mapExpanded ? "rotate(180deg)" : "rotate(0deg)" }}
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                <path d="m6 9 6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span>{t("expandMap")}</span>
            </button>
          </div>
          {mapExpanded && (
            <div className="mt-4">
              <PhotoMap
                locations={data?.geoLocations || []}
                mapSource={mapSource}
                onMapSourceChange={handleMapSourceChange}
              />
            </div>
          )}
        </div>

        {/* Color Distribution */}
        <ChartSection
          hint={t("colorClickToSearch")}
          title={t("colorDistribution")}
        >
          {colorData ? (
            colorData && colorData.globalPalette.length > 0 ? (
              <div
                className={colorVisible ? "animate-card-enter" : "opacity-0"}
                ref={colorRef}
              >
                {/* Insight text */}
                {(() => {
                  let warmT = 0,
                    coolT = 0,
                    greenT = 0;
                  for (const h of colorData.hueDistribution) {
                    const hue = h.hueRange[0];
                    if (hue >= 0 && hue < 90) {
                      warmT += h.count;
                    } else if (hue >= 210 && hue < 330) {
                      coolT += h.count;
                    } else if (hue >= 90 && hue < 180) {
                      greenT += h.count;
                    }
                  }
                  const total = warmT + coolT + greenT;
                  const max = Math.max(warmT, coolT, greenT);
                  let insightKey = "colorInsightNeutral";
                  if (total > 0 && max / total >= 0.35) {
                    if (max === warmT) {
                      insightKey = "colorInsightWarm";
                    } else if (max === coolT) {
                      insightKey = "colorInsightCool";
                    } else {
                      insightKey = "colorInsightGreen";
                    }
                  }
                  return (
                    <p className="mb-3 text-[12px] text-muted-foreground/80">
                      {t(insightKey)}
                    </p>
                  );
                })()}

                {/* Palette Swatch Row — sorted by hue */}
                <div className="mb-4">
                  <h3 className="mb-2 font-semibold text-[12px] text-foreground uppercase tracking-wider">
                    {t("colorPalette")}
                  </h3>
                  <div className="flex h-6 w-full overflow-hidden rounded-[4px]">
                    {colorData.globalPalette.map((c, i) => (
                      <button
                        className="h-full shrink-0 cursor-pointer border-0 p-0 transition-opacity hover:opacity-70 focus:outline-none"
                        key={i}
                        onClick={() =>
                          drillToHome({
                            colorHex: c.hex.replace("#", ""),
                          })
                        }
                        style={{
                          width: `${Math.max(c.weight * 100, 1.5)}%`,
                          backgroundColor: c.hex,
                        }}
                        title={`${c.hex} — ${Math.round(c.weight * 100)}%`}
                      />
                    ))}
                  </div>
                </div>

                {/* Hue Distribution Bar — equal-width segments, opacity = relative count */}
                <div className="mb-4">
                  <h3 className="mb-2 font-semibold text-[12px] text-foreground uppercase tracking-wider">
                    {t("colorHueDistribution")}
                  </h3>
                  {(() => {
                    const maxHue = Math.max(
                      ...colorData.hueDistribution.map((h) => h.count),
                      1
                    );
                    return (
                      <>
                        <div className="flex h-6 w-full gap-[1px] overflow-hidden rounded-[4px]">
                          {colorData.hueDistribution.map((h) => {
                            const ratio = h.count / maxHue;
                            const opacity = 0.12 + ratio * 0.88;
                            return (
                              <button
                                className="h-full flex-1 cursor-pointer border-0 p-0 transition-opacity hover:opacity-70 focus:outline-none"
                                key={h.hueRange[0]}
                                onClick={() =>
                                  drillToHome({
                                    colorHex: h.hex.replace("#", ""),
                                  })
                                }
                                style={{
                                  backgroundColor: h.hex,
                                  opacity,
                                }}
                                title={`${getHueLabel(h.hueRange[0])}: ${h.count} — ${t("colorClickToSearch")}`}
                              />
                            );
                          })}
                        </div>
                        <div className="mt-1.5 flex justify-between px-0">
                          {colorData.hueDistribution.map((h) => (
                            <span
                              className="text-center text-[10px] text-muted-foreground/60 leading-tight"
                              key={h.hueRange[0]}
                            >
                              {getHueLabel(h.hueRange[0])}
                            </span>
                          ))}
                        </div>
                      </>
                    );
                  })()}
                </div>

                {/* Saturation Distribution */}
                <div>
                  <h3 className="mb-2 font-semibold text-[12px] text-foreground uppercase tracking-wider">
                    {t("colorSaturationDistribution")}
                  </h3>
                  {(() => {
                    const maxSat = Math.max(
                      ...colorData.saturationDistribution.map((s) => s.count),
                      1
                    );
                    const barColors: Record<string, string> = {
                      vivid: "hsl(237, 55%, 55%)",
                      moderate: "hsl(237, 25%, 48%)",
                      muted: "hsl(237, 8%, 40%)",
                    };
                    const satLabels: Record<string, string> = {
                      vivid: t("colorVivid"),
                      moderate: t("colorModerate"),
                      muted: t("colorMuted"),
                    };
                    return (
                      <div className="space-y-1.5">
                        {colorData.saturationDistribution.map((s) => {
                          const pct = Math.round((s.count / maxSat) * 100);
                          return (
                            <div
                              className="flex items-center gap-2"
                              key={s.level}
                            >
                              <span className="w-10 shrink-0 text-[11px] text-muted-foreground/70">
                                {satLabels[s.level]}
                              </span>
                              <div className="h-2.5 flex-1 overflow-hidden rounded-[2px] bg-muted">
                                <div
                                  className="h-full rounded-[2px] transition-all"
                                  style={{
                                    width: `${Math.max(pct, 4)}%`,
                                    backgroundColor: barColors[s.level],
                                  }}
                                />
                              </div>
                              <span className="w-8 text-right text-[11px] text-muted-foreground/50 tabular-nums">
                                {s.count}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>

                <p className="mt-3 text-right text-[10px] text-muted-foreground/50">
                  {t("colorSampled", {
                    count: colorData.sampled,
                    total: colorData.totalPhotos,
                  })}
                </p>
              </div>
            ) : (
              <div className="py-2 text-center">
                <p className="text-[12px] text-muted-foreground/50">
                  {t("noColorData")}
                </p>
                {colorData && colorData.sampled > 0 && (
                  <p className="mt-1 text-[11px] text-muted-foreground/30">
                    {t("colorNotEnoughData", { count: colorData.sampled })}
                  </p>
                )}
              </div>
            )
          ) : (
            <div className="space-y-3 py-2">
              <p className="text-[11px] text-muted-foreground/50">
                {t("colorAnalyzing")}
              </p>
              <div className="flex h-5 w-full gap-[2px] overflow-hidden rounded-[4px]">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div
                    className="h-full flex-1 animate-shimmer rounded-[2px]"
                    key={i}
                    style={{ animationDelay: `${i * 80}ms` }}
                  />
                ))}
              </div>
              <div className="flex h-5 w-full gap-[2px] overflow-hidden rounded-[4px]">
                {Array.from({ length: 12 }).map((_, i) => (
                  <div
                    className="h-full flex-1 animate-shimmer rounded-[2px]"
                    key={i}
                    style={{ animationDelay: `${i * 60}ms` }}
                  />
                ))}
              </div>
              <div className="space-y-1.5">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div className="flex items-center gap-2" key={i}>
                    <div className="h-2 w-10 animate-shimmer rounded-[2px]" />
                    <div className="h-2 flex-1 animate-shimmer rounded-[2px]" />
                    <div className="h-2 w-8 animate-shimmer rounded-[2px]" />
                  </div>
                ))}
              </div>
            </div>
          )}
        </ChartSection>

        {/* Camera Usage */}
        <ChartSection hint={t("clickToView")} title={t("cameraUsage")}>
          {cameraData.length > 0 ? (
            <DashboardBarChart
              barRadius={[0, 4, 4, 0]}
              data={cameraData}
              fillColor={CHART_1}
              horizontal
              leftMargin={140}
              onBarClick={(entry) => {
                if (entry.cameraModel) {
                  drillToHome({ cameraModel: entry.cameraModel });
                }
              }}
            />
          ) : (
            <EmptyHint text={t("noCameraData")} />
          )}
        </ChartSection>

        {/* Lens Usage */}
        {lensData.length > 0 && (
          <ChartSection hint={t("clickToView")} title={t("lensUsage")}>
            <DashboardBarChart
              barRadius={[0, 4, 4, 0]}
              cursor={true}
              data={lensData}
              fillColor={CHART_5}
              horizontal
              leftMargin={160}
              onBarClick={(entry) => {
                if (entry.lensModel) {
                  drillToHome({ lensModel: entry.lensModel });
                }
              }}
            />
          </ChartSection>
        )}

        {/* Charts Grid 2×2 */}
        <div className="grid grid-cols-2 gap-4">
          <ChartSection hint={t("clickToView")} title={t("focalDistribution")}>
            {focalData.length > 0 ? (
              <DashboardBarChart
                data={focalData}
                fillColor={CHART_2}
                onBarClick={(entry) => {
                  if (entry.focalMin && entry.focalMax) {
                    drillToHome({
                      focalMin: String(entry.focalMin),
                      focalMax: String(entry.focalMax),
                    });
                  }
                }}
                xAxisAngle={-45}
                xAxisFontSize={10}
              />
            ) : (
              <EmptyHint text={t("noFocalData")} />
            )}
          </ChartSection>

          <ChartSection hint={t("clickToView")} title={t("aperturePreference")}>
            {apertureData.length > 0 ? (
              <DashboardBarChart
                data={apertureData}
                fillColor={CHART_3}
                onBarClick={(entry) => {
                  if (entry.apertureMin && entry.apertureMax) {
                    drillToHome({
                      apertureMin: entry.apertureMin,
                      apertureMax: entry.apertureMax,
                    });
                  }
                }}
                xAxisAngle={-45}
                xAxisFontSize={10}
              />
            ) : (
              <EmptyHint text={t("noApertureData")} />
            )}
          </ChartSection>

          <ChartSection
            hint={t("clickToView")}
            title={t("isoDistributionTitle")}
          >
            {isoData.length > 0 && isoData.some((d) => d.count > 0) ? (
              <DashboardBarChart
                data={isoData}
                fillColor={CHART_4}
                onBarClick={(entry) => {
                  if (entry.isoMin && entry.isoMax) {
                    drillToHome({
                      isoMin: entry.isoMin,
                      isoMax: entry.isoMax,
                    });
                  }
                }}
              />
            ) : (
              <EmptyHint text={t("noIsoData")} />
            )}
          </ChartSection>

          <ChartSection title={t("timeDistribution24h")}>
            {timeData.length > 0 && timeData.some((d) => d.count > 0) ? (
              <ResponsiveContainer height={180} width="100%">
                <AreaChart
                  data={timeData}
                  margin={{ top: 0, right: 0, left: 0, bottom: 20 }}
                >
                  <defs>
                    <linearGradient
                      id="timeGradient"
                      x1="0"
                      x2="0"
                      y1="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor="var(--chart-1)"
                        stopOpacity={0.5}
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--chart-1)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <XAxis
                    axisLine={false}
                    dataKey="name"
                    interval={3}
                    tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
                    tickLine={false}
                  />
                  <YAxis
                    axisLine={false}
                    tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
                    tickLine={false}
                  />
                  <Tooltip {...chartTooltipStyle} />
                  <Area
                    animationDuration={prefersReducedMotion ? 0 : 800}
                    dataKey="count"
                    fill="url(#timeGradient)"
                    stroke={CHART_1}
                    strokeWidth={2}
                    type="monotone"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyHint text={t("noTimeData")} />
            )}
          </ChartSection>
        </div>

        {/* Shutter Speed Distribution */}
        <ChartSection hint={t("clickToView")} title={t("shutterDistribution")}>
          {shutterData.length > 0 && shutterData.some((d) => d.count > 0) ? (
            <DashboardBarChart
              data={shutterData}
              fillColor={CHART_5}
              onBarClick={(entry) => {
                if (
                  entry.shutterMin !== undefined &&
                  entry.shutterMax !== undefined
                ) {
                  drillToHome({
                    shutterMin: String(entry.shutterMin),
                    shutterMax: String(entry.shutterMax),
                  });
                }
              }}
              xAxisAngle={-45}
              xAxisFontSize={10}
            />
          ) : (
            <EmptyHint text={t("noShutterData")} />
          )}
        </ChartSection>

        {/* Yearly & Monthly Distribution */}
        <div className="grid grid-cols-2 gap-4">
          <ChartSection
            hint={t("clickYearToView")}
            title={t("yearlyDistribution")}
          >
            {yearlyData.length > 0 ? (
              <ResponsiveContainer height={200} width="100%">
                <AreaChart
                  data={yearlyData}
                  margin={{ top: 0, right: 0, left: 0, bottom: 20 }}
                  onClick={(state: ChartClickState) => {
                    if (state?.activePayload?.[0]?.payload) {
                      const p = state.activePayload[0].payload as {
                        dateFrom?: string;
                        dateTo?: string;
                      };
                      if (p.dateFrom && p.dateTo) {
                        drillToHome({ dateFrom: p.dateFrom, dateTo: p.dateTo });
                      }
                    }
                  }}
                >
                  <defs>
                    <linearGradient
                      id="yearGradient"
                      x1="0"
                      x2="0"
                      y1="0"
                      y2="1"
                    >
                      <stop
                        offset="0%"
                        stopColor="var(--chart-2)"
                        stopOpacity={0.5}
                      />
                      <stop
                        offset="100%"
                        stopColor="var(--chart-2)"
                        stopOpacity={0.02}
                      />
                    </linearGradient>
                  </defs>
                  <XAxis
                    axisLine={false}
                    dataKey="name"
                    tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
                    tickLine={false}
                  />
                  <YAxis
                    axisLine={false}
                    tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
                    tickLine={false}
                  />
                  <Tooltip {...chartTooltipStyle} />
                  <Area
                    animationDuration={prefersReducedMotion ? 0 : 800}
                    className="cursor-pointer"
                    dataKey="count"
                    fill="url(#yearGradient)"
                    stroke={CHART_2}
                    strokeWidth={2}
                    type="monotone"
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyHint text={t("noYearData")} />
            )}
          </ChartSection>

          <ChartSection title={t("monthlyDistribution")}>
            {monthlyData.some((d) => d.count > 0) ? (
              <DashboardBarChart
                cursor={false}
                data={monthlyData}
                fillColor={CHART_4}
                height={200}
              />
            ) : (
              <EmptyHint text={t("noMonthData")} />
            )}
          </ChartSection>
        </div>
      </div>
    </div>
  );
}

interface DashboardBarChartProps {
  barRadius?: [number, number, number, number];
  cursor?: boolean;
  data: any[];
  dataKey?: string;
  fillColor: string;
  height?: number;
  horizontal?: boolean;
  leftMargin?: number;
  onBarClick?: (entry: any) => void;
  xAxisAngle?: number;
  xAxisFontSize?: number;
  xAxisHeight?: number;
  xAxisInterval?: number;
}

function DashboardBarChart({
  data,
  dataKey = "count",
  fillColor,
  height = 180,
  horizontal = false,
  leftMargin = 0,
  xAxisAngle = 0,
  xAxisHeight = 40,
  xAxisFontSize = 11,
  xAxisInterval = 0,
  barRadius = [4, 4, 0, 0],
  cursor = true,
  onBarClick,
}: DashboardBarChartProps) {
  const noAnim = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (horizontal) {
    const containerHeight = data.length * 36 + 20;
    return (
      <ResponsiveContainer height={containerHeight} width="100%">
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 0, right: 20, left: leftMargin, bottom: 0 }}
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
            width={leftMargin - 10}
          />
          <Tooltip {...chartTooltipStyle} />
          <Bar
            animationDuration={noAnim ? 0 : 800}
            className={onBarClick && cursor ? "cursor-pointer" : undefined}
            dataKey={dataKey}
            onClick={onBarClick}
            radius={barRadius as [number, number, number, number]}
          >
            {data.map((_, i) => (
              <Cell fill={fillColor} key={i} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    );
  }

  return (
    <ResponsiveContainer height={height} width="100%">
      <BarChart data={data} margin={{ top: 0, right: 0, left: 0, bottom: 20 }}>
        <XAxis
          angle={xAxisAngle}
          axisLine={false}
          dataKey="name"
          height={xAxisHeight}
          interval={xAxisInterval}
          textAnchor={xAxisAngle === 0 ? undefined : "end"}
          tick={{ fill: TEXT_TERTIARY, fontSize: xAxisFontSize }}
          tickLine={false}
        />
        <YAxis
          axisLine={false}
          tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
          tickLine={false}
        />
        <Tooltip {...chartTooltipStyle} />
        <Bar
          animationDuration={noAnim ? 0 : 800}
          className={onBarClick && cursor ? "cursor-pointer" : undefined}
          dataKey={dataKey}
          onClick={onBarClick}
          radius={barRadius as [number, number, number, number]}
        >
          {data.map((_, i) => (
            <Cell fill={fillColor} key={i} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-[8px] border border-border bg-secondary p-4">
      <p className="font-medium text-[11px] text-muted-foreground/70 uppercase tracking-wider">
        {label}
      </p>
      <p className="mt-1 font-semibold text-[24px] text-foreground">{value}</p>
    </div>
  );
}

function ChartSection({
  title,
  children,
  hint,
}: {
  children: React.ReactNode;
  hint?: string;
  title: string;
}) {
  return (
    <div className="rounded-[8px] border border-border bg-secondary p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="font-semibold text-[16px] text-foreground">{title}</h2>
        {hint && (
          <span className="text-[10px] text-muted-foreground/70">{hint}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function EmptyHint({ text }: { text: string }) {
  return <p className="text-[13px] text-muted-foreground/70">{text}</p>;
}

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
});
