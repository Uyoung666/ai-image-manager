import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  buildCalendarHeatmapData,
  type DailyStat,
} from "@/utils/dashboard-data";

const WEEKDAY_ROWS = [0, 1, 2, 3, 4, 5, 6] as const;

function getLevelColors(color: string) {
  return [
    "var(--muted)",
    `color-mix(in oklab, ${color} 35%, var(--muted))`,
    `color-mix(in oklab, ${color} 55%, var(--muted))`,
    `color-mix(in oklab, ${color} 75%, var(--muted))`,
    color,
  ];
}

export function CalendarHeatmap({
  color = "var(--dashboard-time)",
  data,
  now,
  onDateClick,
}: {
  color?: string;
  data: DailyStat[];
  now?: Date;
  onDateClick: (date: string) => void;
}) {
  const { i18n, t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const levelColors = useMemo(() => getLevelColors(color), [color]);
  const heatmap = useMemo(
    () => buildCalendarHeatmapData(data, now),
    [data, now]
  );
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }),
    [i18n.language]
  );
  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: "short" }),
    [i18n.language]
  );
  const weekdays = useMemo(() => {
    const formatter = new Intl.DateTimeFormat(i18n.language, {
      weekday: "narrow",
    });
    return WEEKDAY_ROWS.map((weekday) => ({
      label: formatter.format(new Date(2024, 0, weekday + 7)),
      weekday,
    }));
  }, [i18n.language]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) {
      return;
    }
    const onWheel = (event: WheelEvent) => {
      if (
        container.scrollWidth > container.clientWidth &&
        Math.abs(event.deltaY) > Math.abs(event.deltaX)
      ) {
        container.scrollLeft += event.deltaY;
        event.preventDefault();
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, []);

  if (data.length === 0) {
    return null;
  }

  return (
    <div className="min-w-0 max-w-full" data-testid="calendar-heatmap">
      <div
        className="max-w-full overflow-x-auto overscroll-x-contain pb-1"
        ref={scrollRef}
      >
        <div className="flex w-max min-w-full gap-2">
          <div className="mt-[19px] grid grid-rows-7 gap-1 text-[10px] text-muted-foreground">
            {weekdays.map(({ label, weekday }) => (
              <span className="flex h-[15px] items-center" key={weekday}>
                {weekday % 2 === 1 ? label : ""}
              </span>
            ))}
          </div>
          <div className="flex min-w-max flex-1 justify-between gap-1">
            {heatmap.weeks.map((week) => {
              const monthCell = week.find((day) => day?.day === 1);
              const weekKey = week.find((day) => day)?.date ?? "empty-week";
              const month = monthCell
                ? monthFormatter.format(new Date(`${monthCell.date}T00:00:00`))
                : "";
              return (
                <div className="w-[15px]" key={weekKey}>
                  <span className="mb-1 block h-[15px] overflow-visible whitespace-nowrap text-[10px] text-muted-foreground">
                    {month}
                  </span>
                  <div className="grid grid-rows-7 gap-1">
                    {WEEKDAY_ROWS.map((weekday) => {
                      const day = week[weekday];
                      if (!day) {
                        return (
                          <span
                            className="h-[15px] w-[15px]"
                            key={`${weekKey}-${weekday}`}
                          />
                        );
                      }
                      if (day.count === 0) {
                        return (
                          <span
                            className="h-[15px] w-[15px] rounded-[3px]"
                            key={day.date}
                            style={{ backgroundColor: levelColors[0] }}
                          />
                        );
                      }
                      return (
                        <Tooltip key={day.date}>
                          <TooltipTrigger asChild>
                            <button
                              aria-label={t("dashboardHeatmapTooltip", {
                                count: day.count.toLocaleString(i18n.language),
                                date: dateFormatter.format(
                                  new Date(`${day.date}T00:00:00`)
                                ),
                              })}
                              className="h-[15px] w-[15px] rounded-[3px] transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2 motion-reduce:transition-none"
                              onClick={() => onDateClick(day.date)}
                              style={{
                                backgroundColor: levelColors[day.level],
                              }}
                              type="button"
                            />
                          </TooltipTrigger>
                          <TooltipContent>
                            {t("dashboardHeatmapTooltip", {
                              count: day.count.toLocaleString(i18n.language),
                              date: dateFormatter.format(
                                new Date(`${day.date}T00:00:00`)
                              ),
                            })}
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-1 text-[10px] text-muted-foreground">
        <span>{t("dashboardHeatmapLess")}</span>
        {levelColors.map((levelColor) => (
          <span
            className="h-[15px] w-[15px] rounded-[3px]"
            key={levelColor}
            style={{ backgroundColor: levelColor }}
          />
        ))}
        <span>{t("dashboardHeatmapMore")}</span>
      </div>
    </div>
  );
}
