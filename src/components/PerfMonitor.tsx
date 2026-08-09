// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
import { useEffect, useState } from "react";

interface FrameMetrics {
  avgFps: number;
  elapsed: number;
  fps: number;
  frameCount: number;
  minFps: number;
}

interface PerformanceWithMemory extends Performance {
  memory?: {
    usedJSHeapSize: number;
  };
}

/**
 * 开发模式下的 FPS/内存 性能监控浮层。
 * 仅在 `DEV_PERF_MONITOR` localStorage 启用时可见。
 */
export function usePerfMonitor(enabled = false) {
  const [metrics, setMetrics] = useState<FrameMetrics>({
    fps: 0,
    avgFps: 0,
    minFps: Number.POSITIVE_INFINITY,
    frameCount: 0,
    elapsed: 0,
  });
  const [memory, setMemory] = useState<number>(0);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    let running = true;
    let lastTime = performance.now();
    let frames = 0;
    let totalFps = 0;
    let totalFrames = 0;
    let minFps = Number.POSITIVE_INFINITY;
    const startTime = lastTime;

    function tick() {
      if (!running) {
        return;
      }
      const now = performance.now();
      frames++;
      const elapsed = now - lastTime;

      if (elapsed >= 1000) {
        const fps = Math.round((frames / elapsed) * 1000);
        totalFps += fps;
        totalFrames += frames;
        if (fps < minFps) {
          minFps = fps;
        }

        setMetrics({
          fps,
          avgFps: Math.round(totalFps / (totalFrames / frames)),
          minFps: minFps === Number.POSITIVE_INFINITY ? fps : minFps,
          frameCount: totalFrames,
          elapsed: now - startTime,
        });

        // Memory (if available)
        if ("memory" in performance) {
          const mem = (performance as PerformanceWithMemory).memory;
          if (mem) {
            setMemory(mem.usedJSHeapSize / 1024 / 1024);
          }
        }

        frames = 0;
        lastTime = now;
      }

      requestAnimationFrame(tick);
    }

    requestAnimationFrame(tick);
    return () => {
      running = false;
    };
  }, [enabled]);

  return { metrics, memory };
}

export function PerfOverlay({
  metrics,
  memory,
}: {
  metrics: FrameMetrics;
  memory: number;
}) {
  if (metrics.frameCount === 0) {
    return null;
  }

  let fpsColor = "#ef4444";
  if (metrics.fps >= 55) {
    fpsColor = "#4ade80";
  } else if (metrics.fps >= 30) {
    fpsColor = "#facc15";
  }

  return (
    <div className="pointer-events-none fixed right-3 bottom-3 z-50 rounded-[6px] border border-border bg-background/90 px-3 py-2 font-mono text-[11px] backdrop-blur-sm">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-[14px]" style={{ color: fpsColor }}>
          {metrics.fps}
        </span>
        <span className="text-muted-foreground/70">FPS</span>
      </div>
      <div className="mt-1 text-muted-foreground/70">
        <div>
          avg {metrics.avgFps} / min {metrics.minFps}
        </div>
        <div>frames {metrics.frameCount}</div>
        {memory > 0 && <div>heap {memory.toFixed(0)} MB</div>}
      </div>
    </div>
  );
}
