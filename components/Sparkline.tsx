interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  variant?: "gradient" | "solid";  // gradient = emerald→gold signature stroke
}

// Tiny static SVG sparkline — no deps, renders server-side.
// Signature look: stroke fades emerald→gold left-to-right with a soft neon glow.
// Same gradient def is repeated per instance under one shared id — identical
// definitions, so collisions are harmless.
export default function Sparkline({ data, width = 110, height = 32, color = "#10B981", fill = true, variant = "gradient" }: SparklineProps) {
  if (data.length < 2) {
    return <svg width={width} height={height} aria-hidden><line x1={0} y1={height / 2} x2={width} y2={height / 2} stroke="rgba(255,255,255,0.1)" strokeWidth={1} /></svg>;
  }
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pad = 2;
  const pts = data.map((v, i) => {
    const x = pad + (i / (data.length - 1)) * (width - pad * 2);
    const y = pad + (1 - (v - min) / span) * (height - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastY = Number(pts[pts.length - 1].split(",")[1]);
  const stroke = variant === "gradient" ? "url(#sparkEmeraldGold)" : color;
  const dotColor = variant === "gradient" ? "#F0B90B" : color;
  const glow = variant === "gradient" ? "rgba(16,185,129,0.45)" : `${color}55`;

  return (
    <svg width={width} height={height} aria-hidden style={{ display: "block", overflow: "visible" }}>
      <defs>
        <linearGradient id="sparkEmeraldGold" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#10B981" />
          <stop offset="100%" stopColor="#F0B90B" />
        </linearGradient>
      </defs>
      {fill && (
        <polygon
          points={`${pad},${height - pad} ${pts.join(" ")} ${width - pad},${height - pad}`}
          fill={variant === "gradient" ? "url(#sparkEmeraldGold)" : color} opacity={0.07}
        />
      )}
      <polyline
        className="spark-line"
        pathLength={100}
        points={pts.join(" ")}
        fill="none"
        stroke={stroke}
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        style={{ filter: `drop-shadow(0 0 3px ${glow})` }}
      />
      <circle cx={width - pad} cy={lastY} r={2} fill={dotColor} />
    </svg>
  );
}
