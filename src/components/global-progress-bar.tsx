import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useGlobalAiStatus } from "@/hooks/use-global-ai-status";
import { getRandomPhrase } from "@/utils/progress-phrases";

/** Smooth-transitioning global progress indicator for the header area. */
export function GlobalProgressBar() {
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
      clearInterval(phraseTimerRef.current!);
      phraseTimerRef.current = null;
    }
    return () => {
      clearInterval(phraseTimerRef.current!);
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
      <div className="flex items-center gap-2 border-border/40 border-b bg-card/80 px-3 py-1.5 backdrop-blur-sm">
        {showSpinner && (
          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary/70" />
        )}

        <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
          {phrase}
        </span>

        {!isIndeterminate && (
          <span className="shrink-0 font-[510] text-[11px] text-primary tabular-nums">
            {Math.round(smoothPct)}%
          </span>
        )}
      </div>

      <div className="h-[2px] w-full bg-secondary">
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
