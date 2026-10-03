import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "@/actions/shell";
import sprite from "@/assets/about/crowd.png";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { CrowdScene } from "./crowd-scene";

const CREDITS = [
  { label: "Skiper UI", url: "https://skiper-ui.com/v1/skiper39" },
  { label: "Open Peeps", url: "https://www.openpeeps.com/" },
  { label: "Zadvorsky", url: "https://codepen.io/zadvorsky/pen/xxwbBQV" },
];

export default function AboutCrowd() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const [enabled, setEnabled] = useState(true);
  const [systemReduceMotion, setSystemReduceMotion] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
  const [status, setStatus] = useState<"loading" | "ready" | "unavailable">(
    "loading"
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playbackRef = useRef(false);
  const syncRef = useRef<(() => void) | null>(null);
  const motionDisabled = reduceMotion || systemReduceMotion;

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => setSystemReduceMotion(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  useEffect(() => {
    playbackRef.current = enabled && !motionDisabled;
    syncRef.current?.();
  }, [enabled, motionDisabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!(canvas && stage)) {
      return;
    }
    let disposed = false;
    let visible = false;
    let scene: CrowdScene | null = null;
    const sync = () =>
      scene?.setPlaying(playbackRef.current && visible && !document.hidden);
    syncRef.current = sync;
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(stage);
    const resize = new ResizeObserver(() => scene?.resize());
    resize.observe(stage);
    document.addEventListener("visibilitychange", sync);
    const img = new Image();
    img.onload = async () => {
      try {
        const { createCrowdScene } = await import("./crowd-scene");
        if (disposed) {
          return;
        }
        scene = createCrowdScene(canvas, img);
        setStatus(scene ? "ready" : "unavailable");
        sync();
      } catch {
        if (!disposed) {
          setStatus("unavailable");
        }
      }
    };
    img.onerror = () => {
      if (!disposed) {
        setStatus("unavailable");
      }
    };
    img.src = sprite;
    return () => {
      disposed = true;
      img.onload = null;
      img.onerror = null;
      observer.disconnect();
      resize.disconnect();
      document.removeEventListener("visibilitychange", sync);
      syncRef.current = null;
      scene?.destroy();
    };
  }, []);

  return (
    <section
      className="about-crowd-section"
      data-status={status}
      data-testid="about-crowd"
    >
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <p className="text-[12px] text-muted-foreground">
          {t("aboutCrowdMessage")}
        </p>
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex items-center gap-2">
              <span
                className="text-[11px] text-muted-foreground"
                id="about-crowd-label"
              >
                {t("aboutCrowdPlay")}
              </span>
              <Switch
                ariaLabelledBy="about-crowd-label"
                checked={enabled && !motionDisabled}
                disabled={motionDisabled || status === "unavailable"}
                onCheckedChange={setEnabled}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            {t(
              motionDisabled ? "aboutCrowdReducedMotion" : "aboutCrowdPlayHint"
            )}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="about-crowd-stage" ref={stageRef}>
        <canvas
          aria-hidden="true"
          className="about-crowd-canvas"
          ref={canvasRef}
          tabIndex={-1}
        />
        {status !== "ready" && (
          <p className="absolute inset-0 flex items-end justify-center pb-8 text-[11px] text-muted-foreground">
            {t(status === "loading" ? "loading" : "aboutCrowdUnavailable")}
          </p>
        )}
      </div>
      <div className="mt-3 flex min-w-0 flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground/70">
        <span>{t("aboutCredits")}</span>
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {CREDITS.map(({ label, url }) => (
            <Tooltip key={label}>
              <TooltipTrigger asChild>
                <button
                  className="rounded underline decoration-border underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary"
                  onClick={() => openExternalLink(url)}
                  type="button"
                >
                  {label}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {t("aboutVisitCredit", { name: label })}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
      </div>
    </section>
  );
}
