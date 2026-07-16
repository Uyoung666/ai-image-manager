import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

export interface DashboardPoint {
  count: number;
  name: string;
  [key: string]: unknown;
}

const axisTick = { fill: "var(--muted-foreground)", fontSize: 11 };

function CountTooltip({
  active,
  payload,
  sampleTotal,
}: {
  active?: boolean;
  payload?: { payload: DashboardPoint }[];
  sampleTotal: number;
}) {
  const { t, i18n } = useTranslation();
  const point = payload?.[0]?.payload;
  if (!(active && point)) {
    return null;
  }
  const percentage = sampleTotal > 0 ? (point.count / sampleTotal) * 100 : 0;
  return (
    <div className="rounded-[6px] border border-border bg-popover px-3 py-2 text-popover-foreground shadow-lg">
      <p className="max-w-64 font-medium text-[12px]">{point.name}</p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {t("dashboardTooltipCount", {
          count: point.count.toLocaleString(i18n.language),
          percentage: percentage.toFixed(1),
        })}
      </p>
    </div>
  );
}

export function DashboardBarChart({
  data,
  color = "var(--chart-1)",
  horizontal = false,
  onPointClick,
  sampleTotal,
}: {
  color?: string;
  data: DashboardPoint[];
  horizontal?: boolean;
  onPointClick?: (point: DashboardPoint) => void;
  sampleTotal: number;
}) {
  const noMotion =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;
  if (horizontal) {
    const maxCount = Math.max(...data.map((point) => point.count), 1);
    return (
      <ul className="list-none space-y-2">
        {data.map((point) => {
          const content = (
            <>
              <span
                className="truncate text-left text-[11px] text-muted-foreground"
                title={point.name}
              >
                {point.name}
              </span>
              <span className="h-5 overflow-hidden rounded-[4px] bg-muted">
                <span
                  className="block h-full rounded-[4px]"
                  style={{
                    backgroundColor: color,
                    width: `${Math.max(1.5, (point.count / maxCount) * 100)}%`,
                  }}
                />
              </span>
              <span className="text-right text-[11px] text-foreground tabular-nums">
                {point.count.toLocaleString()}
              </span>
            </>
          );
          return (
            <li key={point.name}>
              {onPointClick ? (
                <button
                  className="grid w-full grid-cols-[minmax(100px,150px)_1fr_52px] items-center gap-3 rounded-[5px] py-1 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={() => onPointClick(point)}
                  title={`${point.name}: ${point.count}`}
                  type="button"
                >
                  {content}
                </button>
              ) : (
                <div
                  className="grid grid-cols-[minmax(100px,150px)_1fr_52px] items-center gap-3 py-1"
                  title={`${point.name}: ${point.count}`}
                >
                  {content}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <ResponsiveContainer height={230} width="100%">
      <BarChart
        data={data}
        layout="horizontal"
        margin={{ bottom: 24, left: 0, right: 8, top: 4 }}
      >
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical />
        <XAxis
          axisLine={false}
          dataKey="name"
          interval="preserveStartEnd"
          tick={axisTick}
          tickLine={false}
        />
        <YAxis axisLine={false} tick={axisTick} tickLine={false} width={42} />
        <Tooltip
          content={<CountTooltip sampleTotal={sampleTotal} />}
          cursor={{ fill: "var(--muted)" }}
        />
        <Bar
          animationDuration={noMotion ? 0 : 500}
          dataKey="count"
          onClick={(point) => onPointClick?.(point as DashboardPoint)}
          radius={[4, 4, 0, 0]}
          style={onPointClick ? { cursor: "pointer" } : undefined}
        >
          {data.map((point) => (
            <Cell fill={color} key={point.name} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function ChartSection({
  children,
  data,
  description,
  onPointClick,
  sampleTotal,
  title,
}: {
  children: React.ReactNode;
  data?: DashboardPoint[];
  description?: React.ReactNode;
  onPointClick?: (point: DashboardPoint) => void;
  sampleTotal?: number;
  title: string;
}) {
  const { t, i18n } = useTranslation();
  const [showData, setShowData] = useState(false);
  return (
    <section
      aria-label={title}
      className="rounded-[10px] border border-border bg-secondary p-5"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold text-[15px] text-foreground">{title}</h2>
          {description && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {data && data.length > 0 && (
          <button
            aria-expanded={showData}
            className="rounded-[5px] px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => setShowData((value) => !value)}
            type="button"
          >
            {showData ? t("dashboardHideData") : t("dashboardViewData")}
          </button>
        )}
      </div>
      {children}
      {showData && data && (
        <div className="mt-4 max-h-72 overflow-auto rounded-[6px] border border-border">
          <table className="w-full text-left text-[12px]">
            <thead className="sticky top-0 bg-muted text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">
                  {t("dashboardDataItem")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("dashboardDataCount")}
                </th>
                <th className="px-3 py-2 text-right font-medium">
                  {t("dashboardDataShare")}
                </th>
              </tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr className="border-border border-t" key={point.name}>
                  <td className="px-3 py-2">
                    {onPointClick ? (
                      <button
                        className="text-primary hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                        onClick={() => onPointClick(point)}
                        type="button"
                      >
                        {point.name}
                      </button>
                    ) : (
                      point.name
                    )}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {point.count.toLocaleString(i18n.language)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {sampleTotal
                      ? `${((point.count / sampleTotal) * 100).toFixed(1)}%`
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function CoverageCard({
  count,
  label,
  percentage,
}: {
  count: number;
  label: string;
  percentage: number;
}) {
  return (
    <div className="rounded-[8px] border border-border bg-background/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">{label}</p>
        <span className="font-semibold text-[13px] text-foreground tabular-nums">
          {percentage}%
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${Math.min(100, percentage)}%` }}
        />
      </div>
      <p className="mt-2 text-[10px] text-muted-foreground tabular-nums">
        {count.toLocaleString()}
      </p>
    </div>
  );
}

export function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex min-h-36 items-center justify-center rounded-[6px] border border-border border-dashed px-4 text-center text-[12px] text-muted-foreground">
      {message}
    </div>
  );
}
