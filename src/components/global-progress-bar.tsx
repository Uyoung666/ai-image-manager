import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { ipc } from "@/ipc/manager";
import { getRandomPhrase } from "@/utils/progress-phrases";

/** Smooth-transitioning global progress indicator for the header area. */
export function GlobalProgressBar() {
  const { t } = useTranslation();
  const status = useGlobalAiStatus();

  // ── Fun phrase rotation ─────────────────────────────────────
  const [phrase, setPhrase] = useState(() => getRandomPhrase(status.phase));
  const phraseTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (status.isRunning) {
      setPhrase(getRandomPhrase(status.phase));
      phraseTimerRef.current = window.setInterval(() => {
        setPhrase(getRandomPhrase(status.phase));
      }, 4000);
    } else {
      if (phraseTimerRef.current !== null) {
        clearInterval(phraseTimerRef.current);
      }
      phraseTimerRef.current = null;
    }
    return () => {
      if (phraseTimerRef.current !== null) {
        clearInterval(phraseTimerRef.current);
      }
    };
  }, [status.isRunning, status.phase]);

  // ── Smooth enter / exit ──────────────────────────────────────
  // Use a delayed unmount so the slide-out animation completes.
  const [visible, setVisible] = useState(false);
  const [render, setRender] = useState(false);
  const prevRunningRef = useRef(false);

  useEffect(() => {
    if (status.isRunning && !render) {
      // Enter: render immediately, then animate in
      setRender(true);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => setVisible(true))
      );
      prevRunningRef.current = true;
    } else if (!status.isRunning && render) {
      // Exit: animate out, then unmount after transition
      setVisible(false);
      const timer = setTimeout(() => setRender(false), 350);
      prevRunningRef.current = false;
      return () => clearTimeout(timer);
    }
    prevRunningRef.current = status.isRunning;
  }, [status.isRunning, render]);

  // ── Percent smoothing ───────────────────────────────────────
  // Smooth the raw percentage so rapid updates don't cause jitter.
  const [smoothPct, setSmoothPct] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!status.isRunning) {
      setSmoothPct(0);
      return;
    }
    // Animate toward target over ~120ms using rAF
    const target = status.percent;
    let frame = 0;
    const totalFrames = 8; // ~133ms at 60fps

    function step() {
      frame++;
      const t = Math.min(1, frame / totalFrames);
      // Ease-out quad
      const eased = 1 - (1 - t) * (1 - t);
      setSmoothPct((prev) => {
        const next = prev + (target - prev) * eased * 0.5;
        if (Math.abs(next - target) < 0.5) {
          return target;
        }
        return next;
      });
      if (frame < totalFrames && status.isRunning) {
        rafRef.current = requestAnimationFrame(step);
      }
    }
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [status.percent, status.isRunning]);

  // Immediately snap on phase changes so the bar doesn't lag behind
  // a completely different task.
  const prevPhaseRef = useRef(status.phase);
  useEffect(() => {
    if (status.phase !== prevPhaseRef.current) {
      setSmoothPct(status.percent);
      prevPhaseRef.current = status.phase;
    }
  }, [status.phase, status.percent]);

  if (!render) {
    return null;
  }

  const isIndeterminate =
    (status.phase === "loading-model" && smoothPct < 1) ||
    (status.phase === "import-queue" && smoothPct < 1);
  const showSpinner = status.phase === "loading-model" || isIndeterminate;

  return (
    <div
      className={`overflow-hidden transition-all duration-300 ease-out ${visible ? "max-h-12 opacity-100" : "max-h-0 opacity-0"}
      `}
    >
      <div className="flex items-center gap-2 px-4 py-1.5">
        {showSpinner && <LoadingSpinner size="xs" />}

        <span
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={
            status.statusText ? `${phrase} · ${status.statusText}` : phrase
          }
        >
          {phrase}
          {status.statusText && (
            <span className="text-muted-foreground/70">
              {` · ${status.statusText}`}
            </span>
          )}
        </span>

        {status.canCancel && (
          <button
            className="shrink-0 rounded px-2 py-0.5 text-[10px] text-danger hover:bg-danger/10"
            onClick={() => {
              ipc.client.photos.stopScanning({}).catch((error) => {
                console.error("[Import] Failed to cancel current scan", error);
              });
            }}
            type="button"
          >
            {t("cancel")}
          </button>
        )}

        {!isIndeterminate && (
          <span className="shrink-0 font-medium text-[11px] text-primary tabular-nums">
            {Math.round(smoothPct)}%
          </span>
        )}
      </div>

      <div className="mx-4 h-px rounded-full bg-foreground/10">
        <div
          className={`h-full bg-primary transition-[width] duration-300 ease-out ${isIndeterminate ? "animate-indeterminate-bar" : ""}
          `}
          style={{
            width: isIndeterminate ? "30%" : `${Math.max(1, smoothPct)}%`,
          }}
        />
      </div>
    </div>
  );
}
