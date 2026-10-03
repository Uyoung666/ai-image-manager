/** Original, bundled landscape illustrations. No library or network access. */
const PALETTES = [
  ["#f7c996", "#c57569", "#746b87", "#354964", "#263749"],
  ["#b7dae0", "#f8e8b9", "#799d9c", "#426967", "#294d50"],
  ["#c7c6e7", "#fae9ca", "#9193b4", "#575d85", "#343e60"],
  ["#e6bca4", "#f7dfb1", "#b19b8a", "#697c71", "#3f5c54"],
];

export function WanderPreviewScene({
  index,
  className,
  fit = "slice",
}: {
  index: number;
  className?: string;
  fit?: "slice" | "meet";
}) {
  const [sky, sun, distant, mountain, foreground] = PALETTES[index % 4];
  const variant = Math.floor(index / 4);
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      height="200"
      preserveAspectRatio={`xMidYMid ${fit}`}
      viewBox="0 0 300 200"
      width="300"
    >
      <rect fill={sky} height="200" width="300" />
      <circle cx={65 + index * 13} cy={42 + variant * 8} fill={sun} r="22" />
      <path
        d={`M0 120 L${60 + variant * 15} 48 L135 115 L220 65 L300 125 V200 H0Z`}
        fill={distant}
      />
      <path
        d={`M0 150 L90 ${88 + variant * 12} L165 155 L250 93 L300 137 V200 H0Z`}
        fill={mountain}
      />
      <path d="M0 162 Q75 142 150 166 T300 161 V200 H0Z" fill={sky} />
      <path d="M0 185 Q80 162 160 184 T300 177 V200 H0Z" fill={foreground} />
      {[25, 265].map((x) => (
        <path
          d={`M${x} 183 V141 M${x - 13} 162 L${x} 129 L${x + 13} 162Z`}
          fill={foreground}
          key={x}
          stroke={foreground}
          strokeWidth="3"
        />
      ))}
    </svg>
  );
}
