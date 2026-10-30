// biome-ignore-all lint/a11y/noSvgWithoutTitle: decorative artwork, accessible name belongs to its parent.
import { useId } from "react";
export function SignatureArtwork({
  className,
  isDark = false,
  isDrawing = false,
  reduceMotion = false,
  monochrome = false,
}: {
  className?: string;
  isDark?: boolean;
  isDrawing?: boolean;
  reduceMotion?: boolean;
  monochrome?: boolean;
}) {
  const prefix = useId();
  const colors = isDark
    ? {
        strokeGrad: {
          id: `${prefix}-ds`,
          stops: ["#E0E7FF", "#FFFFFF", "#C7D2FE", "#A5B4FC"],
        },
        fillGrad: { id: `${prefix}-df`, stops: ["#EEF2FF", "#C7D2FE"] },
        lineGrad: {
          id: `${prefix}-dl`,
          stops: ["#818CF8", "#A5B4FC", "#6366F1"],
        },
        flourishGrad: { id: `${prefix}-dfl`, stops: ["#A5B4FC", "#818CF8"] },
        hasGlow: true,
        bgOverlay: "bg-black/30",
      }
    : {
        strokeGrad: {
          id: `${prefix}-ls`,
          stops: ["#1E3A5F", "#2D4A7A", "#1A365D", "#2B6CB0"],
        },
        fillGrad: { id: `${prefix}-lf`, stops: ["#2D4A7A", "#1A365D"] },
        lineGrad: {
          id: `${prefix}-ll`,
          stops: ["#4F46E5", "#6366F1", "#4338CA"],
        },
        flourishGrad: { id: `${prefix}-lfl`, stops: ["#6366F1", "#4F46E5"] },
        hasGlow: false,
        bgOverlay: "bg-white/20",
      };

  const effect = colors.hasGlow
    ? `url(#${prefix}-glow)`
    : `url(#${prefix}-shadow)`;
  const artFilter = monochrome ? undefined : effect;
  const makeGradient = (
    g: typeof colors.strokeGrad,
    x2 = "100%",
    y2 = "0%"
  ) => (
    <linearGradient id={g.id} x1="0%" x2={x2} y1="0%" y2={y2}>
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
    <>
      <svg
        aria-hidden="true"
        className={className}
        viewBox="0 0 1000 300"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {makeGradient(colors.strokeGrad)}
          {makeGradient(colors.fillGrad, "100%", "10%")}
          {makeGradient(colors.lineGrad)}
          {makeGradient(colors.flourishGrad)}
          {colors.hasGlow && (
            <filter
              height="180%"
              id={`${prefix}-glow`}
              width="180%"
              x="-40%"
              y="-40%"
            >
              <feGaussianBlur in="SourceGraphic" result="b1" stdDeviation="2" />
              <feGaussianBlur in="SourceGraphic" result="b2" stdDeviation="5" />
              <feMerge>
                <feMergeNode in="b2" />
                <feMergeNode in="b1" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          )}
          {!colors.hasGlow && (
            <filter
              height="140%"
              id={`${prefix}-shadow`}
              width="140%"
              x="-20%"
              y="-20%"
            >
              <feDropShadow
                dx="0.5"
                dy="1"
                floodColor="#1E3A5F"
                floodOpacity="0.25"
                stdDeviation="2"
              />
            </filter>
          )}
        </defs>

        {/* Left flourish */}
        <path
          d="M 60 200 C 80 170, 100 140, 130 150 C 155 158, 150 180, 135 170 C 125 163, 120 150, 145 135 C 165 123, 185 120, 195 130"
          fill="none"
          filter={artFilter}
          stroke={
            monochrome ? "currentColor" : `url(#${colors.flourishGrad.id})`
          }
          strokeDasharray="200"
          strokeDashoffset={isDrawing ? undefined : 0}
          strokeLinecap="round"
          strokeWidth="1.8"
          style={{
            animation: isDrawing
              ? "signature-draw 1.2s 0.1s cubic-bezier(0.25, 0, 0.15, 1) both"
              : "none",
          }}
        />

        {/* Main text */}
        <text
          dominantBaseline="central"
          fill={monochrome ? "currentColor" : `url(#${colors.fillGrad.id})`}
          filter={artFilter}
          fontFamily="'Segoe Script', 'Brush Script MT', 'Dancing Script', 'Pacifico', cursive"
          fontSize="150"
          fontStyle="italic"
          fontWeight="400"
          letterSpacing="3"
          paintOrder="stroke fill"
          stroke={monochrome ? "currentColor" : `url(#${colors.strokeGrad.id})`}
          strokeDasharray="1000"
          strokeDashoffset={isDrawing ? undefined : 0}
          strokeWidth="3.5"
          style={{
            animation: isDrawing
              ? "signature-draw 2s cubic-bezier(0.25, 0, 0.15, 1) both"
              : "none",
          }}
          textAnchor="middle"
          x="500"
          y="145"
        >
          Uyoung
        </text>

        {/* Right flourish */}
        <path
          d="M 830 110 C 850 100, 870 95, 890 105 C 905 113, 910 135, 895 145 C 880 155, 860 145, 870 130 C 880 118, 900 115, 910 125"
          fill="none"
          filter={artFilter}
          stroke={
            monochrome ? "currentColor" : `url(#${colors.flourishGrad.id})`
          }
          strokeDasharray="160"
          strokeDashoffset={isDrawing ? undefined : 0}
          strokeLinecap="round"
          strokeWidth="1.8"
          style={{
            animation: isDrawing
              ? "signature-draw 1s 1.2s cubic-bezier(0.25, 0, 0.15, 1) both"
              : "none",
          }}
        />

        {/* Underline */}
        <path
          d="M 160 185 Q 300 230 500 185 Q 580 165 640 185 Q 720 215 840 190"
          fill="none"
          filter={artFilter}
          stroke={monochrome ? "currentColor" : `url(#${colors.lineGrad.id})`}
          strokeDasharray="800"
          strokeDashoffset={isDrawing ? undefined : 0}
          strokeLinecap="round"
          strokeWidth="1.8"
          style={{
            animation: isDrawing
              ? "signature-draw 1.8s 0.6s cubic-bezier(0.25, 0, 0.15, 1) both"
              : "none",
          }}
        />

        {/* Accent dot */}
        <circle
          cx="855"
          cy="188"
          fill={monochrome ? "currentColor" : `url(#${colors.lineGrad.id})`}
          filter={artFilter}
          opacity={Number(!isDrawing)}
          r="3.5"
          style={{
            transition: reduceMotion ? "none" : "opacity 0.3s ease 1.8s",
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
    </>
  );
}
