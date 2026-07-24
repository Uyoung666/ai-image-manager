import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Lightbulb, Sparkles } from "lucide-react";
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
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { advancedExifActions } from "@/actions/advanced-exif";
import {
  CalendarHeatmap,
} from "@/components/dashboard/calendar-heatmap";
import {
  ChartSection,
  DashboardBarChart,
  type DashboardPoint,
  EmptyChart,
} from "@/components/dashboard/dashboard-charts";
import { type GeoLocation, PhotoMap } from "@/components/PhotoMap";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip as AppTooltip,
  TooltipContent as AppTooltipContent,
  TooltipTrigger as AppTooltipTrigger,
} from "@/components/ui/tooltip";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";
import type { AdvancedExifProgress } from "@/types/photo-metadata";
import {
  buildApertureChartData,
  buildDashboardReturnTarget,
  buildDateDrillParams,
  buildFocalChartData,
  buildMonthlyChartData,
  buildRangeSearchParams,
  buildShootingGuidance,
  buildYearDrillParams,
  calculateCoverage,
  type DailyStat,
  type DashboardRangePreset,
  fillYearlyChartData,
  getDashboardTimeRange,
  getTopItems,
  mergeDashboardDrillParams,
  type ShootingGuidanceKind,
} from "@/utils/dashboard-data";

type DashboardTab =
  | "overview"
  | "gear"
  | "exposure"
  | "technique"
  | "time"
  | "places";
type DashboardDisplayMode = "trend" | "heatmap";

interface BucketStat {
  count: number;
  max?: number;
  min?: number;
  period?: string;
  range?: string;
}
interface Completeness {
  missingAperture: number;
  missingCamera: number;
  missingDate: number;
  missingFocal: number;
  missingGps: number;
  missingIso: number;
  missingLens: number;
  missingShutter: number;
  withExif: number;
  withoutExif: number;
}
interface DistributionMeta {
  missing: number;
  totalCategories: number;
  truncated: boolean;
  valid: number;
}
interface DashboardData {
  advancedStats: Record<string, { count: number; name: string }[]>;
  aiProcessed: number;
  apertureStats: { aperture: number; count: number }[];
  avgIso: number;
  cameraStats: { count: number; model: string }[];
  coverage: {
    advancedExif: number;
    ai: number;
    color: number;
    date: number;
    exif: number;
    gps: number;
  };
  dailyStats: DailyStat[];
  dateRange: { earliest: number; latest: number } | null;
  distributionMetadata: Record<string, DistributionMeta>;
  exifCompleteness: Completeness | null;
  focalStats: { count: number; focalLength: string }[];
  isoDistribution: BucketStat[];
  lensStats: { count: number; model: string }[];
  monthlyStats: { count: number; month: string }[];
  scope: {
    datedPhotos: number;
    excludedUndated: number;
    libraryTotal: number;
    scopedPhotos: number;
  };
  shutterSpeedDistribution: BucketStat[];
  timeHeatmap: BucketStat[];
  totalPhotos: number;
  yearlyStats: { count: number; year: string }[];
}
interface ColorData {
  globalPalette: { hex: string; weight: number }[];
  hueDistribution: { count: number; hex: string; hueRange: [number, number] }[];
  sampled: number;
  saturationDistribution: {
    count: number;
    level: "vivid" | "moderate" | "muted";
  }[];
  totalPhotos: number;
}
interface GeoData {
  locations: GeoLocation[];
  total: number;
  truncated: boolean;
}

const TABS: DashboardTab[] = [
  "overview",
  "gear",
  "exposure",
  "technique",
  "time",
  "places",
];
const PRESETS: DashboardRangePreset[] = ["all", "year", "last12", "custom"];
const chartTooltipStyle = {
  contentStyle: {
    background: "var(--popover)",
    border: "1px solid var(--border)",
    borderRadius: 6,
    color: "var(--popover-foreground)",
    fontSize: 12,
  },
  cursor: { fill: "var(--muted)" },
};

const DASHBOARD_COLORS = {
  exposure: "var(--dashboard-exposure)",
  gear: "var(--dashboard-gear)",
  provenance: "var(--dashboard-provenance)",
  technique: "var(--dashboard-technique)",
  time: "var(--dashboard-time)",
} as const;

const FRIENDLY_ADVANCED_VALUES: Record<string, [RegExp, string][]> = {
  driveMode: [
    [/continuous|burst|high.speed/i, "dashboardFriendlyDriveContinuous"],
    [/single/i, "dashboardFriendlyDriveSingle"],
    [/timer|self.timer/i, "dashboardFriendlyDriveTimer"],
  ],
  exposureProgram: [
    [/manual/i, "dashboardFriendlyExposureManual"],
    [/aperture|\bav\b|\ba\b/i, "dashboardFriendlyExposureAperture"],
    [/shutter|\btv\b|\bs\b/i, "dashboardFriendlyExposureShutter"],
    [/program|\bp\b/i, "dashboardFriendlyExposureProgram"],
  ],
  focusMode: [
    [/continuous|af.c|servo/i, "dashboardFriendlyFocusContinuous"],
    [/single|af.s|one.shot/i, "dashboardFriendlyFocusSingle"],
    [/manual|\bmf\b/i, "dashboardFriendlyFocusManual"],
  ],
  meteringMode: [
    [/matrix|evaluative|multi/i, "dashboardFriendlyMeteringMatrix"],
    [/center/i, "dashboardFriendlyMeteringCenter"],
    [/spot/i, "dashboardFriendlyMeteringSpot"],
  ],
  subjectTarget: [
    [/bird/i, "dashboardFriendlySubjectBird"],
    [/animal|cat|dog/i, "dashboardFriendlySubjectAnimal"],
    [/human|person|people|face/i, "dashboardFriendlySubjectPerson"],
    [/vehicle|car|train|plane|aircraft/i, "dashboardFriendlySubjectVehicle"],
  ],
  whiteBalance: [
    [/auto|awb/i, "dashboardFriendlyWhiteBalanceAuto"],
    [/daylight|sun/i, "dashboardFriendlyWhiteBalanceDaylight"],
    [/cloud/i, "dashboardFriendlyWhiteBalanceCloudy"],
    [/shade/i, "dashboardFriendlyWhiteBalanceShade"],
    [/tungsten|incandescent/i, "dashboardFriendlyWhiteBalanceTungsten"],
    [/fluorescent/i, "dashboardFriendlyWhiteBalanceFluorescent"],
  ],
};
const axisTick = { fill: "var(--muted-foreground)", fontSize: 11 };

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: coordinates five lazy dashboard sections and their shared filters
function DashboardPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = Route.useSearch();
  const tab = search.tab ?? "overview";
  const preset = search.range ?? "all";
  const scrollRef = useRef<HTMLDivElement>(null);
  const [mapSource, setMapSource] = useState<"offline" | "online">("offline");
  const [expandedCharts, setExpandedCharts] = useState<Set<string>>(new Set());
  const [startingAi, setStartingAi] = useState(false);
  const [overviewDisplayMode, setOverviewDisplayMode] =
    useState<DashboardDisplayMode>("trend");
  const [timeDisplayMode, setTimeDisplayMode] =
    useState<DashboardDisplayMode>("trend");
  const [isCustomRangeDialogOpen, setIsCustomRangeDialogOpen] =
    useState(false);
  const [customFrom, setCustomFrom] = useState(search.from ?? "");
  const [customTo, setCustomTo] = useState(search.to ?? "");
  useRouteScrollRestoration(scrollRef, {
    getRouteKey: () => `dashboard-${tab}`,
  });

  const range = useMemo(
    () => getDashboardTimeRange(preset, new Date(), search.from, search.to),
    [preset, search.from, search.to]
  );
  const setSearch = useCallback(
    (patch: Partial<typeof search>) => {
      navigate({
        to: "/dashboard",
        search: { ...search, ...patch },
        replace: true,
      });
    },
    [navigate, search]
  );
  const openCustomRangeDialog = () => {
    setCustomFrom(search.from ?? "");
    setCustomTo(search.to ?? "");
    setIsCustomRangeDialogOpen(true);
  };
  const applyCustomRange = () => {
    setSearch({
      range: "custom",
      from: customFrom || undefined,
      to: customTo || undefined,
    });
    setIsCustomRangeDialogOpen(false);
  };

  const statsQuery = useQuery({
    queryKey: ["dashboard", "stats", range.from, range.toExclusive],
    queryFn: () =>
      ipc.client.photos.getStats({
        includeColors: false,
        includeGeo: false,
        ...range,
      }) as Promise<DashboardData>,
    placeholderData: (previousData) => previousData,
    staleTime: 30_000,
  });
  const advancedExifQuery = useQuery({
    queryKey: ["advanced-exif-status"],
    queryFn: () =>
      advancedExifActions.getStatus() as Promise<AdvancedExifProgress>,
    refetchInterval: 1500,
  });
  const queryData = statsQuery.data ?? null;
  const data = useDeferredValue(queryData);
  const heavyEnabled = tab === "places" && statsQuery.data !== undefined;
  const colorQuery = useQuery({
    queryKey: ["dashboard", "colors", range.from, range.toExclusive],
    queryFn: () =>
      ipc.client.photos.getColorDistribution(range) as Promise<ColorData>,
    enabled: heavyEnabled,
    staleTime: 30_000,
  });
  const geoQuery = useQuery({
    queryKey: ["dashboard", "geo", range.from, range.toExclusive],
    queryFn: () => ipc.client.photos.getGeoLocations(range) as Promise<GeoData>,
    enabled: heavyEnabled,
    staleTime: 30_000,
  });

  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key: "mapSource" })
      .then((result) => {
        if (result?.value === "online") {
          setMapSource("online");
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key: "dashboardOverviewDisplayMode" })
      .then((result) => {
        if (result?.value === "heatmap") {
          setOverviewDisplayMode("heatmap");
        }
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    ipc.client.settings
      .getAppSetting({ key: "dashboardTimeDisplayMode" })
      .then((result) => {
        if (result?.value === "heatmap") {
          setTimeDisplayMode("heatmap");
        }
      })
      .catch(() => undefined);
  }, []);
  const changeTimeDisplayMode = useCallback((mode: DashboardDisplayMode) => {
    setTimeDisplayMode(mode);
    ipc.client.settings
      .setAppSetting({ key: "dashboardTimeDisplayMode", value: mode })
      .catch(() => undefined);
  }, []);
  const changeOverviewDisplayMode = useCallback(
    (mode: DashboardDisplayMode) => {
      setOverviewDisplayMode(mode);
      ipc.client.settings
        .setAppSetting({ key: "dashboardOverviewDisplayMode", value: mode })
        .catch(() => undefined);
    },
    []
  );
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (
        event.data?.type === "import-queue-status" &&
        event.data?.prevStatus === "processing" &&
        event.data?.status === "done"
      ) {
        queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      }
      if (event.data?.type === "advanced-exif-progress") {
        queryClient.setQueryData(
          ["advanced-exif-status"],
          event.data.progress ?? event.data
        );
        if (!event.data.running) {
          queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        }
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [queryClient]);

  const drill = useCallback(
    (params: Record<string, string>) => {
      navigate({
        to: "/",
        search: {
          ...mergeDashboardDrillParams(params, range),
          dashboardReturn: buildDashboardReturnTarget({
            from: search.from,
            range: preset,
            tab,
            to: search.to,
          }),
        },
      });
    },
    [navigate, preset, range, search.from, search.to, tab]
  );
  const toggleExpanded = (key: string) =>
    setExpandedCharts((current) => {
      const next = new Set(current);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });

  const cameraAll = useMemo(
    () =>
      (data?.cameraStats ?? []).map((item) => ({
        name: item.model,
        count: item.count,
        cameraModel: item.model,
      })),
    [data?.cameraStats]
  );
  const lensAll = useMemo(
    () =>
      (data?.lensStats ?? []).map((item) => ({
        name: item.model,
        count: item.count,
        lensModel: item.model,
      })),
    [data?.lensStats]
  );
  const cameraData = expandedCharts.has("camera")
    ? cameraAll
    : getTopItems(cameraAll, 8);
  const lensData = expandedCharts.has("lens")
    ? lensAll
    : getTopItems(lensAll, 8);
  const focalData = useMemo(
    () => buildFocalChartData(data?.focalStats ?? [], 12),
    [data?.focalStats]
  );
  const apertureData = useMemo(
    () => buildApertureChartData(data?.apertureStats ?? [], 10),
    [data?.apertureStats]
  );
  const isoData = useMemo(
    () =>
      (data?.isoDistribution ?? []).map((item) => ({
        name: item.range ?? "",
        count: item.count,
        isoMin: item.min,
        isoMax: item.max,
      })),
    [data?.isoDistribution]
  );
  const shutterData = useMemo(
    () =>
      (data?.shutterSpeedDistribution ?? []).map((item) => ({
        name: item.range ?? "",
        count: item.count,
        shutterMin: item.min,
        shutterMax: item.max,
      })),
    [data?.shutterSpeedDistribution]
  );
  const timeData = useMemo(
    () =>
      (data?.timeHeatmap ?? []).map((item, hour) => ({
        name: item.period ?? "",
        count: item.count,
        hour,
      })),
    [data?.timeHeatmap]
  );
  const yearlyData = useMemo(
    () => fillYearlyChartData(data?.yearlyStats ?? [], range),
    [data?.yearlyStats, range]
  );
  const monthlyData = useMemo(
    () => buildMonthlyChartData(data?.monthlyStats ?? [], i18n.language),
    [data?.monthlyStats, i18n.language]
  );
  const shootingGuidance = useMemo(
    () =>
      buildShootingGuidance({
        advancedExif: data?.coverage.advancedExif ?? 0,
        apertureStats: data?.apertureStats ?? [],
        avgIso: data?.avgIso ?? 0,
        focalStats: data?.focalStats ?? [],
        totalPhotos: data?.scope.scopedPhotos ?? 0,
      }),
    [
      data?.apertureStats,
      data?.avgIso,
      data?.coverage.advancedExif,
      data?.focalStats,
      data?.scope.scopedPhotos,
    ]
  );
  const friendlyAdvancedValue = (key: string, value: string) => {
    const match = FRIENDLY_ADVANCED_VALUES[key]?.find(([pattern]) =>
      pattern.test(value)
    );
    return match ? `${t(match[1])} · ${value}` : value;
  };
  const advancedChart = (key: string) =>
    (data?.advancedStats?.[key] ?? []).map((item) => ({
      name:
        key === "provenanceStatus"
          ? t(`metadataProvenance_${item.name}`)
          : friendlyAdvancedValue(key, item.name),
      count: item.count,
      advancedField: key,
      advancedValue: item.name,
    }));

  if (statsQuery.isLoading || (queryData !== null && data === null)) {
    return <DashboardSkeleton />;
  }
  if (statsQuery.isError || !data) {
    return <DashboardError onRetry={() => statsQuery.refetch()} />;
  }

  const sampleTotal = data.scope.scopedPhotos;
  const topCamera = cameraAll[0];
  const topLens = lensAll[0];
  const peakHour = [...timeData].sort((a, b) => b.count - a.count)[0];
  const peakMonth = [...monthlyData].sort((a, b) => b.count - a.count)[0];
  const overviewCoverage = {
    ai: calculateCoverage(data.coverage.ai, sampleTotal),
    advancedExif: calculateCoverage(data.coverage.advancedExif, sampleTotal),
    color: calculateCoverage(data.coverage.color, sampleTotal),
    date: calculateCoverage(data.coverage.date, sampleTotal),
    exif: calculateCoverage(data.coverage.exif, sampleTotal),
    gps: calculateCoverage(data.coverage.gps, sampleTotal),
  };
  const weakestCoverageKey =
    sampleTotal > 0
      ? Object.entries(overviewCoverage).sort(
          ([, left], [, right]) => left - right
        )[0]?.[0]
      : undefined;

  const startAi = async () => {
    setStartingAi(true);
    try {
      await ipc.client.photos.startAiIndexing();
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    } finally {
      setStartingAi(false);
    }
  };

  return (
    <div className="flex h-full flex-col bg-background">
      <header className="border-border border-b px-4 py-3 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              aria-label={t("backToHome")}
              className="rounded-[5px] p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              onClick={() => navigate({ to: "/" })}
              type="button"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
            <div>
              <h1 className="font-semibold text-[18px] text-foreground">
                {t("dashboardTitle")}
              </h1>
              <p className="text-[11px] text-muted-foreground">
                {t("dashboardSubtitle")}
              </p>
            </div>
          </div>
          <fieldset className="flex flex-wrap items-center gap-2">
            <legend className="sr-only">{t("dashboardRangeLabel")}</legend>
            {PRESETS.map((item) => (
              <button
                className={`rounded-[6px] px-3 py-1.5 text-[11px] transition-colors focus-visible:outline-2 focus-visible:outline-ring ${preset === item ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground hover:text-foreground"}`}
                key={item}
                onClick={() => {
                  if (item === "custom") {
                    openCustomRangeDialog();
                    return;
                  }
                  setSearch({ range: item, from: undefined, to: undefined });
                }}
                type="button"
              >
                {t(`dashboardRange_${item}`)}
              </button>
            ))}
          </fieldset>
        </div>
      </header>

      <Dialog
        onOpenChange={setIsCustomRangeDialogOpen}
        open={isCustomRangeDialogOpen}
      >
        <DialogContent size="sm">
          <DialogHeader>
            <DialogTitle>{t("dashboardRange_custom")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-[12px] text-muted-foreground">
            <label className="grid gap-1.5">
              <span>{t("dashboardFromDate")}</span>
              <input
                className="dashboard-date-input rounded-[5px] border border-border bg-background px-2 py-1.5 text-foreground"
                max={customTo || undefined}
                onChange={(event) => setCustomFrom(event.target.value)}
                type="date"
                value={customFrom}
              />
            </label>
            <label className="grid gap-1.5">
              <span>{t("dashboardToDate")}</span>
              <input
                className="dashboard-date-input rounded-[5px] border border-border bg-background px-2 py-1.5 text-foreground"
                min={customFrom || undefined}
                onChange={(event) => setCustomTo(event.target.value)}
                type="date"
                value={customTo}
              />
            </label>
          </div>
          <DialogFooter>
            <Button
              onClick={() => setIsCustomRangeDialogOpen(false)}
              type="button"
              variant="outline"
            >
              {t("cancel")}
            </Button>
            <Button onClick={applyCustomRange} type="button">
              {t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <nav
        aria-label={t("dashboardSections")}
        className="flex shrink-0 gap-1 overflow-x-auto border-border border-b px-4 py-2 sm:px-6"
      >
        {TABS.map((item) => (
          <button
            aria-current={tab === item ? "page" : undefined}
            className={`shrink-0 rounded-[6px] px-3 py-2 text-[12px] focus-visible:outline-2 focus-visible:outline-ring ${tab === item ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"}`}
            key={item}
            onClick={() => setSearch({ tab: item })}
            type="button"
          >
            {t(`dashboardTab_${item}`)}
          </button>
        ))}
      </nav>

      <main className="flex-1 overflow-y-auto p-4 sm:p-6" ref={scrollRef}>
        {range.from !== undefined && data.scope.excludedUndated > 0 && (
          <div className="mb-4 flex items-start gap-2 rounded-[8px] border border-warning/30 bg-warning/10 px-3 py-2 text-[11px] text-foreground">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
            <span>
              {t("dashboardUndatedExcluded", {
                count: data.scope.excludedUndated.toLocaleString(i18n.language),
              })}
            </span>
          </div>
        )}

        {tab === "overview" && (
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
            <section className="relative order-1 overflow-hidden rounded-[12px] border border-primary/25 bg-gradient-to-br from-primary/[0.12] via-secondary to-secondary p-5 shadow-sm sm:p-6 xl:col-span-2">
              <div className="absolute top-5 right-5 sm:top-6 sm:right-6">
                <ChartDisplayModeToggle
                  onChange={changeOverviewDisplayMode}
                  value={overviewDisplayMode}
                />
              </div>
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div>
                  <p className="font-medium text-[11px] text-primary uppercase tracking-[0.14em]">
                    {t("dashboardOverviewEyebrow")}
                  </p>
                  <p className="mt-3 text-[11px] text-muted-foreground">
                    {t("dashboardScopedPhotos")}
                  </p>
                  <h2 className="mt-1 font-semibold text-[40px] text-foreground tabular-nums leading-none tracking-tight">
                    {sampleTotal.toLocaleString(i18n.language)}
                  </h2>
                  <p className="mt-3 max-w-xl text-[11px] text-muted-foreground">
                    {t("dashboardOverviewSubtitle")}
                  </p>
                </div>
                <div className="flex flex-wrap gap-x-6 gap-y-2 border-primary/15 border-t pt-3 text-[11px] sm:border-t-0 sm:border-l sm:pt-0 sm:pl-5">
                  {sampleTotal !== data.scope.libraryTotal && (
                    <div>
                      <p className="text-muted-foreground">
                        {t("dashboardLibraryTotal")}
                      </p>
                      <p className="mt-0.5 font-medium text-foreground tabular-nums">
                        {data.scope.libraryTotal.toLocaleString(i18n.language)}
                      </p>
                    </div>
                  )}
                  <div>
                    <p className="text-muted-foreground">{t("dateRange")}</p>
                    <p className="mt-0.5 font-medium text-foreground tabular-nums">
                      {data.dateRange
                        ? `${new Date(data.dateRange.earliest).getFullYear()}–${new Date(data.dateRange.latest).getFullYear()}`
                        : "—"}
                    </p>
                  </div>
                </div>
              </div>
              <div className="mt-6 border-primary/10 border-t pt-3">
                <OverviewTrend
                  calendarData={data.dailyStats}
                  color="var(--primary)"
                  data={yearlyData}
                  displayMode={overviewDisplayMode}
                  onDateClick={(date) => drill(buildDateDrillParams(date))}
                  title={t("yearlyDistribution")}
                />
              </div>
            </section>
            <section className="order-3 rounded-[10px] border border-border bg-secondary p-5 xl:col-span-3">
              <h2 className="font-semibold text-[15px] text-foreground">
                {t("dashboardLibraryHealth")}
              </h2>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {t("dashboardCoverageDescription")}
              </p>
              <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-[8px] border border-border sm:grid-cols-3 xl:grid-cols-6">
                <HealthMetric
                  emphasized={weakestCoverageKey === "ai"}
                  label={t("dashboardAiCoverage")}
                  percentage={overviewCoverage.ai}
                />
                <HealthMetric
                  emphasized={weakestCoverageKey === "exif"}
                  label={t("dashboardExifCoverage")}
                  percentage={overviewCoverage.exif}
                />
                <HealthMetric
                  emphasized={weakestCoverageKey === "advancedExif"}
                  label={t("dashboardAdvancedExifCoverage")}
                  percentage={overviewCoverage.advancedExif}
                />
                <HealthMetric
                  emphasized={weakestCoverageKey === "date"}
                  label={t("dashboardDateCoverage")}
                  percentage={overviewCoverage.date}
                />
                <HealthMetric
                  emphasized={weakestCoverageKey === "gps"}
                  label={t("dashboardGpsCoverage")}
                  percentage={overviewCoverage.gps}
                />
                <HealthMetric
                  emphasized={weakestCoverageKey === "color"}
                  label={t("dashboardColorCoverage")}
                  percentage={overviewCoverage.color}
                />
              </div>
            </section>
            <div className="contents">
              <section
                className={`order-4 rounded-[10px] border border-border bg-secondary p-5 ${shootingGuidance.length > 0 ? "xl:col-span-2" : "xl:col-span-3"}`}
              >
                <h2 className="font-semibold text-[15px] text-foreground">
                  {t("dashboardPhotographyProfile")}
                </h2>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {t("dashboardPhotographyProfileSubtitle")}
                </p>
                <div className="mt-4 grid grid-cols-2 overflow-hidden rounded-[8px] border border-border lg:grid-cols-3">
                  <Insight
                    detail={
                      topCamera
                        ? t("dashboardPhotoCount", { count: topCamera.count })
                        : undefined
                    }
                    label={t("cameraUsage")}
                    value={topCamera?.name ?? t("dashboardNoInsight")}
                  />
                  <Insight
                    detail={
                      advancedChart("captureMode")[0]?.count
                        ? t("dashboardPhotoCount", {
                            count: advancedChart("captureMode")[0].count,
                          })
                        : undefined
                    }
                    label={t("metadataCaptureMode")}
                    value={
                      advancedChart("captureMode")[0]?.name ??
                      t("dashboardNoInsight")
                    }
                  />
                  <Insight
                    detail={
                      advancedChart("inCameraLook")[0]?.count
                        ? t("dashboardPhotoCount", {
                            count: advancedChart("inCameraLook")[0].count,
                          })
                        : undefined
                    }
                    label={t("metadataInCameraLook")}
                    value={
                      advancedChart("inCameraLook")[0]?.name ??
                      t("dashboardNoInsight")
                    }
                  />
                  <Insight
                    detail={
                      topLens
                        ? t("dashboardPhotoCount", { count: topLens.count })
                        : undefined
                    }
                    label={t("lensUsage")}
                    value={topLens?.name ?? t("dashboardNoInsight")}
                  />
                  <Insight
                    detail={
                      peakHour?.count
                        ? t("dashboardPhotoCount", { count: peakHour.count })
                        : undefined
                    }
                    label={t("dashboardPeakHour")}
                    value={
                      peakHour?.count ? peakHour.name : t("dashboardNoInsight")
                    }
                  />
                  <Insight
                    detail={
                      peakMonth?.count
                        ? t("dashboardPhotoCount", { count: peakMonth.count })
                        : undefined
                    }
                    label={t("dashboardPeakMonth")}
                    value={
                      peakMonth?.count
                        ? peakMonth.name
                        : t("dashboardNoInsight")
                    }
                  />
                </div>
              </section>
              <section className="order-2 rounded-[12px] border border-primary/25 bg-primary/[0.05] p-5 shadow-sm">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-primary" />
                  <h2 className="font-semibold text-[15px] text-foreground">
                    {t("dashboardNextActions")}
                  </h2>
                </div>
                {data.coverage.ai < sampleTotal ? (
                  <div className="mt-4">
                    <p className="text-[12px] text-foreground">
                      {t("dashboardContinueAi", {
                        count: sampleTotal - data.coverage.ai,
                      })}
                    </p>
                    <Button
                      className="mt-3 h-8 text-[11px]"
                      disabled={startingAi}
                      onClick={startAi}
                    >
                      {startingAi
                        ? t("dashboardStartingAi")
                        : t("dashboardStartAi")}
                    </Button>
                  </div>
                ) : (data.exifCompleteness?.withoutExif ?? 0) > 0 ? (
                  <p className="mt-4 text-[12px] text-foreground">
                    {t("dashboardMissingExifAction", {
                      count: data.exifCompleteness?.withoutExif,
                    })}
                  </p>
                ) : (
                  <p className="mt-4 text-[12px] text-muted-foreground">
                    {t("dashboardHealthGood")}
                  </p>
                )}
                {advancedExifQuery.data && (
                  <div className="mt-4 border-border border-t pt-3">
                    <p className="text-[11px] text-muted-foreground">
                      {t("advancedExifProgress", {
                        processed: advancedExifQuery.data.processed,
                        total: advancedExifQuery.data.total,
                      })}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {advancedExifQuery.data.running &&
                      !advancedExifQuery.data.paused ? (
                        <Button
                          className="h-7 text-[10px]"
                          onClick={() => advancedExifActions.pause()}
                          variant="outline"
                        >
                          {t("pause")}
                        </Button>
                      ) : (
                        <Button
                          className="h-7 text-[10px]"
                          onClick={() => advancedExifActions.resume()}
                          variant="outline"
                        >
                          {t("advancedExifResume")}
                        </Button>
                      )}
                      {advancedExifQuery.data.failed > 0 && (
                        <Button
                          className="h-7 text-[10px]"
                          onClick={() => advancedExifActions.retry()}
                          variant="outline"
                        >
                          {t("advancedExifRetry", {
                            count: advancedExifQuery.data.failed,
                          })}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </section>
            </div>
            {shootingGuidance.length > 0 && (
              <section className="order-5 rounded-[10px] border border-primary/20 bg-primary/[0.04] p-5">
                <div className="flex items-start gap-3">
                  <div className="rounded-full bg-primary/10 p-2 text-primary">
                    <Lightbulb className="h-4 w-4" />
                  </div>
                  <div>
                    <h2 className="font-semibold text-[15px] text-foreground">
                      {t("dashboardGuidanceTitle")}
                    </h2>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {t("dashboardGuidanceSubtitle")}
                    </p>
                  </div>
                </div>
                <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  {shootingGuidance.slice(0, 3).map((item) => (
                    <GuidanceCard
                      key={item.kind}
                      kind={item.kind}
                      value={item.value}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {tab === "gear" && (
          <div className="space-y-4">
            <ChartBlock
              color={DASHBOARD_COLORS.gear}
              data={advancedChart("vendor")}
              hint={t("dashboardHint_vendor")}
              horizontal
              meta={data.distributionMetadata.advancedVendor}
              onClick={(point) =>
                drill({
                  advancedField: String(point.advancedField),
                  advancedValue: String(point.advancedValue),
                })
              }
              title={t("dashboardCameraBrand")}
            />
            <ChartWithExpand
              color={DASHBOARD_COLORS.gear}
              data={cameraData}
              expanded={expandedCharts.has("camera")}
              hasMore={cameraAll.length > 8}
              hint={t("dashboardHint_camera")}
              meta={data.distributionMetadata.camera}
              onExpand={() => toggleExpanded("camera")}
              onPointClick={(point) =>
                drill({ cameraModel: String(point.cameraModel) })
              }
              title={t("cameraUsage")}
            />
            <ChartWithExpand
              color={DASHBOARD_COLORS.gear}
              data={lensData}
              expanded={expandedCharts.has("lens")}
              hasMore={lensAll.length > 8}
              hint={t("dashboardHint_lens")}
              meta={data.distributionMetadata.lens}
              onExpand={() => toggleExpanded("lens")}
              onPointClick={(point) =>
                drill({ lensModel: String(point.lensModel) })
              }
              title={t("lensUsage")}
            />
          </div>
        )}

        {tab === "exposure" && (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <ChartBlock
                color={DASHBOARD_COLORS.exposure}
                data={focalData}
                hint={t("dashboardHint_focal")}
                meta={data.distributionMetadata.focal}
                onClick={(point) =>
                  drill({
                    focalMin: String(point.focalMin),
                    focalMax: String(point.focalMax),
                  })
                }
                title={t("focalDistribution")}
              />
              <ChartBlock
                color={DASHBOARD_COLORS.exposure}
                data={apertureData}
                hint={t("dashboardHint_aperture")}
                meta={data.distributionMetadata.aperture}
                onClick={(point) =>
                  drill({
                    apertureMin: String(point.apertureMin),
                    apertureMax: String(point.apertureMax),
                  })
                }
                title={t("aperturePreference")}
              />
              <ChartBlock
                color={DASHBOARD_COLORS.exposure}
                data={isoData}
                hint={t("dashboardHint_iso")}
                meta={data.distributionMetadata.iso}
                onClick={(point) =>
                  drill(
                    buildRangeSearchParams(
                      "iso",
                      point.isoMin as number | undefined,
                      point.isoMax as number | undefined
                    )
                  )
                }
                title={t("isoDistributionTitle")}
              />
              <ChartBlock
                color={DASHBOARD_COLORS.exposure}
                data={shutterData}
                hint={t("dashboardHint_shutter")}
                meta={data.distributionMetadata.shutter}
                onClick={(point) =>
                  drill(
                    buildRangeSearchParams(
                      "shutter",
                      point.shutterMin as number | undefined,
                      point.shutterMax as number | undefined
                    )
                  )
                }
                title={t("shutterDistribution")}
              />
              {[
                ["exposureProgram", "metadataExposureProgram"],
                ["meteringMode", "metadataMeteringMode"],
                ["whiteBalance", "metadataWhiteBalance"],
                ["stabilizationMode", "metadataStabilization"],
              ].map(([key, label]) => (
                <ChartBlock
                  color={DASHBOARD_COLORS.exposure}
                  data={advancedChart(key)}
                  hint={t(`dashboardHint_${key}`)}
                  horizontal
                  key={key}
                  meta={data.distributionMetadata[key]}
                  onClick={(point) =>
                    drill({
                      advancedField: String(point.advancedField),
                      advancedValue: String(point.advancedValue),
                    })
                  }
                  title={t(label)}
                />
              ))}
            </div>
            <div className="rounded-[8px] border border-border bg-secondary px-4 py-3 text-[12px] text-muted-foreground">
              {t("dashboardAverageIso")}:{" "}
              <strong className="text-foreground">
                {data.avgIso
                  ? Math.round(data.avgIso).toLocaleString(i18n.language)
                  : "—"}
              </strong>{" "}
              · {t("dashboardAverageIsoHint")}
            </div>
          </div>
        )}

        {tab === "technique" && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {[
              ["focusMode", "metadataFocusMode"],
              ["subjectTarget", "metadataSubjectTarget"],
              ["driveMode", "metadataDriveMode"],
              ["computationalMode", "metadataComputationalMode"],
              ["inCameraLook", "metadataInCameraLook"],
              ["provenanceStatus", "metadataCredentialStatus"],
            ].map(([key, label]) => (
              <ChartBlock
                color={
                  key === "provenanceStatus"
                    ? DASHBOARD_COLORS.provenance
                    : DASHBOARD_COLORS.technique
                }
                data={advancedChart(key)}
                hint={t(`dashboardHint_${key}`)}
                horizontal
                key={key}
                meta={data.distributionMetadata[key]}
                onClick={(point) =>
                  drill({
                    advancedField: String(point.advancedField),
                    advancedValue: String(point.advancedValue),
                  })
                }
                title={t(label)}
              />
            ))}
          </div>
        )}

        {tab === "time" && (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.65fr)_minmax(280px,0.85fr)]">
            <TrendChart
              calendarData={data.dailyStats}
              color={DASHBOARD_COLORS.time}
              data={yearlyData}
              displayMode={timeDisplayMode}
              hint={t("dashboardHint_yearly")}
              onDateClick={(date) => drill(buildDateDrillParams(date))}
              onDisplayModeChange={changeTimeDisplayMode}
              onPointClick={(point) => {
                const params = buildYearDrillParams(
                  Number(point.year),
                  range
                );
                if (Object.keys(params).length > 0) {
                  drill(params);
                }
              }}
              sampleTotal={sampleTotal}
              title={t("yearlyDistribution")}
            />
            <ChartBlock
              color={DASHBOARD_COLORS.time}
              data={monthlyData}
              hint={t("dashboardHint_monthly")}
              meta={{
                valid: data.coverage.date,
                missing: data.exifCompleteness?.missingDate ?? 0,
                totalCategories: 12,
                truncated: false,
              }}
              onClick={(point) =>
                drill({ dateMonth: String(point.month) })
              }
              title={t("dashboardMonthlyPreference")}
            />
            <div className="xl:col-span-2">
              <TrendChart
                color={DASHBOARD_COLORS.time}
                data={timeData}
                hint={t("dashboardHint_time")}
                onPointClick={(point) =>
                  drill({ dateHour: String(point.hour) })
                }
                sampleTotal={data.coverage.date}
                title={t("timeDistribution24h")}
              />
            </div>
          </div>
        )}

        {tab === "places" && (
          <PlacesAndColors
            colorData={colorQuery.data ?? null}
            colorLoading={colorQuery.isLoading}
            drill={drill}
            geoData={geoQuery.data ?? null}
            geoLoading={geoQuery.isLoading}
            mapSource={mapSource}
            onMapSourceChange={(source) => {
              setMapSource(source);
              ipc.client.settings
                .setAppSetting({ key: "mapSource", value: source })
                .catch(() => undefined);
            }}
          />
        )}
      </main>
    </div>
  );
}

function GuidanceCard({
  kind,
  value,
}: {
  kind: ShootingGuidanceKind;
  value: number;
}) {
  const { t } = useTranslation();
  return (
    <article className="rounded-[8px] border border-border/80 bg-background/70 p-4">
      <h3 className="font-medium text-[12px] text-foreground">
        {t(`dashboardGuidance_${kind}Title`)}
      </h3>
      <p className="mt-2 text-[11px] text-muted-foreground leading-relaxed">
        {t(`dashboardGuidance_${kind}Body`, { value })}
      </p>
    </article>
  );
}

function ChartDescription({
  hint,
  meta,
  showClickHint = false,
}: {
  hint?: string;
  meta: DistributionMeta;
  showClickHint?: boolean;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div>
      {hint && <p className="text-foreground/75">{hint}</p>}
      <p className={hint ? "mt-1" : undefined}>
        {t("dashboardChartCoverage", {
          missing: meta.missing.toLocaleString(i18n.language),
          valid: meta.valid.toLocaleString(i18n.language),
        })}
        {meta.truncated ? ` · ${t("dashboardDataTruncated")}` : ""}
        {showClickHint ? ` · ${t("dashboardChartClickHint")}` : ""}
      </p>
    </div>
  );
}
function ChartBlock({
  color,
  data,
  hint,
  horizontal = false,
  meta,
  onClick,
  title,
}: {
  color?: string;
  data: DashboardPoint[];
  hint?: string;
  horizontal?: boolean;
  meta: DistributionMeta;
  onClick?: (point: DashboardPoint) => void;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <ChartSection
      data={data}
      description={
        <ChartDescription hint={hint} meta={meta} showClickHint={!!onClick} />
      }
      onPointClick={onClick}
      sampleTotal={meta.valid}
      title={title}
    >
      {data.some((point) => point.count > 0) ? (
        <div
          className={horizontal ? "max-h-[520px] overflow-y-auto" : undefined}
        >
          <DashboardBarChart
            color={color}
            data={data}
            horizontal={horizontal}
            onPointClick={onClick}
            sampleTotal={meta.valid}
          />
        </div>
      ) : (
        <EmptyChart message={t("dashboardEmptyForRange")} />
      )}
    </ChartSection>
  );
}
function ChartWithExpand({
  color,
  data,
  expanded,
  hasMore,
  hint,
  meta,
  onExpand,
  onPointClick,
  title,
}: {
  color?: string;
  data: DashboardPoint[];
  expanded: boolean;
  hasMore: boolean;
  hint?: string;
  meta: DistributionMeta;
  onExpand: () => void;
  onPointClick: (point: DashboardPoint) => void;
  title: string;
}) {
  const { t } = useTranslation();
  return (
    <ChartSection
      data={data}
      description={<ChartDescription hint={hint} meta={meta} showClickHint />}
      onPointClick={onPointClick}
      sampleTotal={meta.valid}
      title={title}
    >
      {data.length ? (
        <>
          <div className="max-h-[620px] overflow-y-auto">
            <DashboardBarChart
              color={color}
              data={data}
              horizontal
              onPointClick={onPointClick}
              sampleTotal={meta.valid}
            />
          </div>
          {hasMore && (
            <button
              className="mt-2 text-[11px] text-primary hover:underline"
              onClick={onExpand}
              type="button"
            >
              {expanded
                ? t("dashboardShowLess")
                : t("dashboardShowAll", { count: meta.totalCategories })}
            </button>
          )}
        </>
      ) : (
        <EmptyChart message={t("dashboardMissingExifEmpty")} />
      )}
    </ChartSection>
  );
}

function ChartDisplayModeToggle({
  onChange,
  value,
}: {
  onChange?: (mode: DashboardDisplayMode) => void;
  value: DashboardDisplayMode;
}) {
  const { t } = useTranslation();
  return (
    <fieldset
      aria-label={t("dashboardDisplayMode")}
      className="m-0 flex min-w-0 rounded-[5px] border border-border p-0.5"
    >
      <button
        aria-pressed={value === "trend"}
        className={`rounded-[3px] px-2 py-1 text-[10px] focus-visible:outline-2 focus-visible:outline-ring ${
          value === "trend"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onChange?.("trend")}
        type="button"
      >
        {t("dashboardDisplayTrend")}
      </button>
      <button
        aria-pressed={value === "heatmap"}
        className={`rounded-[3px] px-2 py-1 text-[10px] focus-visible:outline-2 focus-visible:outline-ring ${
          value === "heatmap"
            ? "bg-muted text-foreground"
            : "text-muted-foreground hover:text-foreground"
        }`}
        onClick={() => onChange?.("heatmap")}
        type="button"
      >
        {t("dashboardDisplayHeatmap")}
      </button>
    </fieldset>
  );
}

function TrendChart({
  calendarData,
  color,
  data,
  displayMode = "trend",
  hint,
  onDateClick,
  onDisplayModeChange,
  onPointClick,
  sampleTotal,
  title,
}: {
  calendarData?: DailyStat[];
  color: string;
  data: DashboardPoint[];
  displayMode?: DashboardDisplayMode;
  hint?: string;
  onDateClick?: (date: string) => void;
  onDisplayModeChange?: (mode: DashboardDisplayMode) => void;
  onPointClick?: (point: DashboardPoint) => void;
  sampleTotal: number;
  title: string;
}) {
  const { t } = useTranslation();
  const noMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  const hasCalendarData = calendarData && calendarData.length > 0;
  return (
    <ChartSection
      data={data}
      description={
        <div>
          {hint && <p className="text-foreground/75">{hint}</p>}
          <p className={hint ? "mt-1" : undefined}>
            {t("dashboardValidSamples", { count: sampleTotal })}
          </p>
        </div>
      }
      headerAction={
        hasCalendarData ? (
          <ChartDisplayModeToggle
            onChange={onDisplayModeChange}
            value={displayMode}
          />
        ) : undefined
      }
      onPointClick={onPointClick}
      sampleTotal={sampleTotal}
      title={title}
    >
      {displayMode === "heatmap" && hasCalendarData ? (
        <CalendarHeatmap
          data={calendarData}
          onDateClick={(date) => onDateClick?.(date)}
        />
      ) : data.some((point) => point.count > 0) ? (
        <ResponsiveContainer height={230} width="100%">
          <AreaChart
            data={data}
            margin={{ bottom: 18, left: 0, right: 8, top: 4 }}
            onClick={(state) => {
              const dashboardPoint = state?.activePayload?.[0]?.payload as
                | DashboardPoint
                | undefined;
              if (dashboardPoint && dashboardPoint.count > 0) {
                onPointClick?.(dashboardPoint);
              }
            }}
          >
            <defs>
              <linearGradient id={`trend-${title}`} x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.35} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid
              stroke="var(--border)"
              strokeDasharray="3 3"
              vertical={false}
            />
            <XAxis
              axisLine={false}
              dataKey="name"
              interval="preserveStartEnd"
              tick={axisTick}
              tickLine={false}
            />
            <YAxis
              axisLine={false}
              tick={axisTick}
              tickLine={false}
              width={42}
            />
            <Tooltip {...chartTooltipStyle} />
            <Area
              animationDuration={400}
              animationEasing="ease-out"
              dataKey="count"
              fill={`url(#trend-${title})`}
              isAnimationActive={!noMotion}
              stroke={color}
              strokeWidth={2}
              style={onPointClick ? { cursor: "pointer" } : undefined}
              type="linear"
            />
          </AreaChart>
        </ResponsiveContainer>
      ) : (
        <EmptyChart message={t("dashboardEmptyForRange")} />
      )}
    </ChartSection>
  );
}

function PlacesAndColors({
  colorData,
  colorLoading,
  drill,
  geoData,
  geoLoading,
  mapSource,
  onMapSourceChange,
}: {
  colorData: ColorData | null;
  colorLoading: boolean;
  drill: (params: Record<string, string>) => void;
  geoData: GeoData | null;
  geoLoading: boolean;
  mapSource: "offline" | "online";
  onMapSourceChange: (source: "offline" | "online") => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-4">
      <ChartSection
        description={
          geoData
            ? t("dashboardMapCoverage", { count: geoData.total }) +
              (geoData.truncated ? ` · ${t("dashboardMapTruncated")}` : "")
            : undefined
        }
        title={t("geoMap")}
      >
        <GeoContent
          data={geoData}
          loading={geoLoading}
          mapSource={mapSource}
          onMapSourceChange={onMapSourceChange}
        />
      </ChartSection>
      <ChartSection
        description={
          colorData
            ? t("colorSampled", {
                count: colorData.sampled,
                total: colorData.totalPhotos,
              })
            : undefined
        }
        title={t("colorDistribution")}
      >
        <ColorContent data={colorData} drill={drill} loading={colorLoading} />
      </ChartSection>
    </div>
  );
}

function GeoContent({
  data,
  loading,
  mapSource,
  onMapSourceChange,
}: {
  data: GeoData | null;
  loading: boolean;
  mapSource: "offline" | "online";
  onMapSourceChange: (source: "offline" | "online") => void;
}) {
  const { t } = useTranslation();
  if (loading) {
    return <div className="h-[320px] animate-pulse rounded-[6px] bg-muted" />;
  }
  if (!data?.locations.length) {
    return <EmptyChart message={t("noGeoData")} />;
  }
  return (
    <PhotoMap
      locations={data.locations}
      mapSource={mapSource}
      onMapSourceChange={onMapSourceChange}
    />
  );
}

function ColorContent({
  data,
  drill,
  loading,
}: {
  data: ColorData | null;
  drill: (params: Record<string, string>) => void;
  loading: boolean;
}) {
  const { t } = useTranslation();
  if (loading) {
    return <div className="h-32 animate-pulse rounded-[6px] bg-muted" />;
  }
  if (!data?.globalPalette.length) {
    return <EmptyChart message={t("noColorData")} />;
  }
  return (
    <div className="space-y-5">
      <div>
        <h3 className="mb-2 text-[11px] text-muted-foreground uppercase">
          {t("colorPalette")}
        </h3>
        <div className="flex h-9 overflow-hidden rounded-[6px]">
          {data.globalPalette.map((color) => (
            <AppTooltip key={color.hex}>
              <AppTooltipTrigger asChild>
                <button
                  aria-label={`${color.hex} ${Math.round(color.weight * 100)}%`}
                  className="min-w-2 focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() =>
                    drill({ colorHex: color.hex.replace("#", "") })
                  }
                  style={{
                    backgroundColor: color.hex,
                    width: `${Math.max(2, color.weight * 100)}%`,
                  }}
                  type="button"
                />
              </AppTooltipTrigger>
              <AppTooltipContent>
                {color.hex} · {Math.round(color.weight * 100)}%
              </AppTooltipContent>
            </AppTooltip>
          ))}
        </div>
      </div>
      <div className="hue-distribution-scroll">
        <h3 className="mb-2 text-[11px] text-muted-foreground uppercase">
          {t("colorHueDistribution")}
        </h3>
        <div className="hue-distribution-items">
          {data.hueDistribution.map((hue) => (
            <AppTooltip key={hue.hueRange[0]}>
              <AppTooltipTrigger asChild>
                <button
                  aria-disabled={hue.count === 0}
                  aria-label={`${hue.hex} ${t("dashboardPhotoCount", { count: hue.count })}`}
                  className="hue-distribution-item rounded-[4px] px-1 py-4 font-medium text-[10px] text-white shadow-sm focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={
                    hue.count > 0
                      ? () => drill({ colorHex: hue.hex.replace("#", "") })
                      : undefined
                  }
                  style={{
                    backgroundColor: hue.hex,
                  }}
                  type="button"
                >
                  {hue.count}
                </button>
              </AppTooltipTrigger>
              <AppTooltipContent>
                {hue.hex} · {t("dashboardPhotoCount", { count: hue.count })}
              </AppTooltipContent>
            </AppTooltip>
          ))}
        </div>
      </div>
    </div>
  );
}
function HealthMetric({
  emphasized,
  label,
  percentage,
}: {
  emphasized: boolean;
  label: string;
  percentage: number;
}) {
  return (
    <div
      className={`min-w-0 border-border/70 border-r border-b p-4 xl:border-b-0 ${emphasized ? "bg-warning/[0.06]" : "bg-background/30"}`}
    >
      <div className="flex items-center gap-1.5">
        {emphasized && (
          <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning" />
        )}
        <p className="truncate text-[10px] text-muted-foreground" title={label}>
          {label}
        </p>
      </div>
      <p className="mt-1 font-semibold text-[18px] text-foreground tabular-nums">
        {percentage}%
      </p>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{
            backgroundColor: emphasized ? "var(--warning)" : "var(--primary)",
            width: `${Math.min(100, percentage)}%`,
          }}
        />
      </div>
    </div>
  );
}

function OverviewTrend({
  calendarData,
  color,
  data,
  displayMode,
  onDateClick,
  title,
}: {
  calendarData: DailyStat[];
  color: string;
  data: DashboardPoint[];
  displayMode: DashboardDisplayMode;
  onDateClick: (date: string) => void;
  title: string;
}) {
  const noMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;
  if (!(data.some((point) => point.count > 0) || calendarData.length > 0)) {
    return null;
  }
  return (
    <div aria-label={title} className="w-full">
      {displayMode === "heatmap" ? (
        <CalendarHeatmap
          color={color}
          data={calendarData}
          onDateClick={onDateClick}
        />
      ) : (
        <div className="h-40" role="img">
          <ResponsiveContainer height="100%" width="100%">
        <AreaChart
          data={data}
          margin={{ bottom: 4, left: 0, right: 8, top: 8 }}
        >
          <defs>
            <linearGradient id="overview-trend" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.38} />
              <stop offset="100%" stopColor={color} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="var(--border)"
            strokeDasharray="3 3"
            vertical={false}
          />
          <XAxis
            axisLine={false}
            dataKey="name"
            interval="preserveStartEnd"
            tick={axisTick}
            tickLine={false}
          />
          <Tooltip {...chartTooltipStyle} />
          <Area
            animationDuration={400}
            dataKey="count"
            fill="url(#overview-trend)"
            isAnimationActive={!noMotion}
            stroke={color}
            strokeWidth={2}
            type="linear"
          />
        </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
function Insight({
  detail,
  label,
  value,
}: {
  detail?: string;
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 border-border/70 border-r border-b bg-background/20 p-4">
      <p className="text-[10px] text-muted-foreground uppercase">{label}</p>
      <p
        className="mt-1 truncate font-medium text-[13px] text-foreground"
        title={value}
      >
        {value}
      </p>
      {detail && (
        <p className="mt-1 text-[10px] text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}
function DashboardSkeleton() {
  const skeletonKeys = [
    "summary-1",
    "summary-2",
    "summary-3",
    "summary-4",
    "panel-1",
    "panel-2",
    "panel-3",
    "panel-4",
  ];
  return (
    <div className="flex h-full flex-col bg-background">
      <div className="h-16 border-border border-b" />
      <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden p-6 sm:grid-cols-2 xl:grid-cols-4">
        {skeletonKeys.map((key) => (
          <div
            className="h-32 animate-pulse rounded-[9px] bg-muted"
            key={key}
          />
        ))}
      </div>
    </div>
  );
}
function DashboardError({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 bg-background text-center">
      <AlertTriangle className="h-8 w-8 text-danger" />
      <p className="text-[13px] text-foreground">{t("dashboardLoadFailed")}</p>
      <Button onClick={onRetry}>{t("retry")}</Button>
    </div>
  );
}

export const Route = createFileRoute("/dashboard")({
  component: DashboardPage,
  validateSearch: (
    search: Record<string, unknown>
  ): {
    from?: string;
    range?: DashboardRangePreset;
    tab?: DashboardTab;
    to?: string;
  } => ({
    from: typeof search.from === "string" ? search.from : undefined,
    range: PRESETS.includes(search.range as DashboardRangePreset)
      ? (search.range as DashboardRangePreset)
      : undefined,
    tab: TABS.includes(search.tab as DashboardTab)
      ? (search.tab as DashboardTab)
      : undefined,
    to: typeof search.to === "string" ? search.to : undefined,
  }),
});
