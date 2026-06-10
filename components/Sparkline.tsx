interface SparklineProps {
  data: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
}

// Tiny static SVG sparkline — no deps, no animation, renders server-side.
export default function Sparkline({ data, width = 110, height = 32, color = "#10B981", fill = true }: SparklineProps) {
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

  return (
    <svg width={width} height={height} aria-hidden style={{ display: "block" }}>
      {fill && (
        <polygon
          points={`${pad},${height - pad} ${pts.join(" ")} ${width - pad},${height - pad}`}
          fill={color} opacity={0.08}
        />
      )}
      <polyline className="spark-line" pathLength={100} points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width - pad} cy={lastY} r={2} fill={color} />
    </svg>
  );
}
