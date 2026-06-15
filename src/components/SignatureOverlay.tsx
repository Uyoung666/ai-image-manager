import { useEffect, useRef, useState } from "react";

interface SignatureOverlayProps {
  active: boolean;
  onDone?: () => void;
}

function useIsDarkMode() {
  const [isDark, setIsDark] = useState(() =>
    typeof document !== "undefined"
      ? document.documentElement.classList.contains("dark")
      : true,
  );

  useEffect(() => {
    const html = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDark(html.classList.contains("dark"));
    });
    observer.observe(html, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return isDark;
}

export function SignatureOverlay({ active, onDone }: SignatureOverlayProps) {
  const [phase, setPhase] = useState<"idle" | "drawing" | "done" | "fading">("idle");
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const isDark = useIsDarkMode();

  useEffect(() => {
    if (!active) {
      setPhase("idle");
      return;
    }

    const startTimer = setTimeout(() => setPhase("drawing"), 200);
    const doneTimer = setTimeout(() => setPhase("done"), 2800);
    const fadeTimer = setTimeout(() => setPhase("fading"), 5200);
    const completeTimer = setTimeout(() => {
      setPhase("idle");
      onDone?.();
    }, 6000);

    timerRef.current = startTimer;
    return () => {
      clearTimeout(startTimer);
      clearTimeout(doneTimer);
      clearTimeout(fadeTimer);
      clearTimeout(completeTimer);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [active, onDone]);

  if (phase === "idle") return null;

  const isDrawing = phase === "drawing";

  const colors = isDark
    ? {
        strokeGrad: { id: "ds", stops: ["#E0E7FF", "#FFFFFF", "#C7D2FE", "#A5B4FC"] },
        fillGrad: { id: "df", stops: ["#EEF2FF", "#C7D2FE"] },
        lineGrad: { id: "dl", stops: ["#818CF8", "#A5B4FC", "#6366F1"] },
        flourishGrad: { id: "dfl", stops: ["#A5B4FC", "#818CF8"] },
        hasGlow: true,
        bgOverlay: "bg-black/30",
      }
    : {
        strokeGrad: { id: "ls", stops: ["#1E3A5F", "#2D4A7A", "#1A365D", "#2B6CB0"] },
        fillGrad: { id: "lf", stops: ["#2D4A7A", "#1A365D"] },
        lineGrad: { id: "ll", stops: ["#4F46E5", "#6366F1", "#4338CA"] },
        flourishGrad: { id: "lfl", stops: ["#6366F1", "#4F46E5"] },
        hasGlow: false,
        bgOverlay: "bg-white/20",
      };

  const makeGradient = (g: typeof colors.strokeGrad, x2 = "100%", y2 = "0%") => (
    <linearGradient id={g.id} x1="0%" y1="0%" x2={x2} y2={y2}>
      {g.stops.map((stop, i) => (
        <stop
          key={stop}
          offset={`${(i / (g.stops.length - 1)) * 100}%`}
          stopColor={stop}
        />
      ))}
    </linearGradient>
  );

  return (
    <div
      className={`pointer-events-none fixed inset-0 z-[10000] flex items-center justify-center ${colors.bgOverlay}`}
      style={{
        opacity: phase === "fading" ? 0 : 1,
        transition: `opacity 800ms ease-out, background-color 400ms ease`,
      }}
    >
      <svg
        viewBox="0 0 1000 300"
        className="h-auto w-[min(750px,90vw)]"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {makeGradient(colors.strokeGrad)}
          {makeGradient(colors.fillGrad, "100%", "10%")}
          {makeGradient(colors.lineGrad)}
          {makeGradient(colors.flourishGrad)}
          {colors.hasGlow && (
            <filter id="sigGlow" x="-40%" y="-40%" width="180%" height="180%">
              <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b1" />
              <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b2" />
              <feMerge>
                <feMergeNode in="b2" />
                <feMergeNode in="b1" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          )}
          {!colors.hasGlow && (
            <filter id="sigShadow" x="-20%" y="-20%" width="140%" height="140%">
              <feDropShadow dx="0.5" dy="1" stdDeviation="2" floodColor="#1E3A5F" floodOpacity="0.25" />
            </filter>
          )}
        </defs>

        {/* Left flourish */}
        <path
          d="M 60 200 C 80 170, 100 140, 130 150 C 155 158, 150 180, 135 170 C 125 163, 120 150, 145 135 C 165 123, 185 120, 195 130"
          fill="none"
          stroke={`url(#${colors.flourishGrad.id})`}
          strokeWidth="1.8"
          strokeLinecap="round"
          filter={colors.hasGlow ? "url(#sigGlow)" : "url(#sigShadow)"}
          strokeDasharray="200"
          strokeDashoffset={isDrawing ? undefined : 0}
          style={{
            animation: isDrawing
              ? `signature-draw 1.2s 0.1s cubic-bezier(0.25, 0, 0.15, 1) both`
              : "none",
          }}
        />

        {/* Main text */}
        <text
          x="500"
          y="145"
          textAnchor="middle"
          dominantBaseline="central"
          fontFamily="'Segoe Script', 'Brush Script MT', 'Dancing Script', 'Pacifico', cursive"
          fontSize="150"
          fontWeight="400"
          fontStyle="italic"
          fill={`url(#${colors.fillGrad.id})`}
          stroke={`url(#${colors.strokeGrad.id})`}
          strokeWidth="3.5"
          paintOrder="stroke fill"
          filter={colors.hasGlow ? "url(#sigGlow)" : "url(#sigShadow)"}
          strokeDasharray="1000"
          strokeDashoffset={isDrawing ? undefined : 0}
          style={{
            animation: isDrawing
              ? `signature-draw 2s cubic-bezier(0.25, 0, 0.15, 1) both`
              : "none",
          }}
          letterSpacing="3"
        >
          Uyoung
        </text>

        {/* Right flourish */}
        <path
          d="M 830 110 C 850 100, 870 95, 890 105 C 905 113, 910 135, 895 145 C 880 155, 860 145, 870 130 C 880 118, 900 115, 910 125"
          fill="none"
          stroke={`url(#${colors.flourishGrad.id})`}
          strokeWidth="1.8"
          strokeLinecap="round"
          filter={colors.hasGlow ? "url(#sigGlow)" : "url(#sigShadow)"}
          strokeDasharray="160"
          strokeDashoffset={isDrawing ? undefined : 0}
          style={{
            animation: isDrawing
              ? `signature-draw 1s 1.2s cubic-bezier(0.25, 0, 0.15, 1) both`
              : "none",
          }}
        />

        {/* Underline */}
        <path
          d="M 160 185 Q 300 230 500 185 Q 580 165 640 185 Q 720 215 840 190"
          fill="none"
          stroke={`url(#${colors.lineGrad.id})`}
          strokeWidth="1.8"
          strokeLinecap="round"
          filter={colors.hasGlow ? "url(#sigGlow)" : "url(#sigShadow)"}
          strokeDasharray="800"
          strokeDashoffset={isDrawing ? undefined : 0}
          style={{
            animation: isDrawing
              ? `signature-draw 1.8s 0.6s cubic-bezier(0.25, 0, 0.15, 1) both`
              : "none",
          }}
        />

        {/* Accent dot */}
        <circle
          cx="855"
          cy="188"
          r="3.5"
          fill={`url(#${colors.lineGrad.id})`}
          filter={colors.hasGlow ? "url(#sigGlow)" : "url(#sigShadow)"}
          opacity={isDrawing ? 0 : 1}
          style={{
            transition: "opacity 0.3s ease 1.8s",
          }}
        />
      </svg>

      <style>{`
        @keyframes signature-draw {
          from {
            stroke-dashoffset: 1000;
          }
          to {
            stroke-dashoffset: 0;
          }
        }
      `}</style>
    </div>
  );
}
