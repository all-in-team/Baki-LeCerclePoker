interface BadgeProps {
  label: string;
  color?: "green" | "gold" | "red" | "gray" | "blue";
}

const COLORS = {
  green: { bg: "rgba(16,185,129,0.12)", color: "#10B981" },
  gold: { bg: "rgba(245,197,24,0.12)", color: "#F5C518" },
  red: { bg: "rgba(239,68,68,0.12)", color: "#EF4444" },
  gray: { bg: "rgba(136,136,160,0.12)", color: "#8888a0" },
  blue: { bg: "rgba(96,165,250,0.12)", color: "#60a5fa" },
};

export default function Badge({ label, color = "gray" }: BadgeProps) {
  const c = COLORS[color];
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 6,
      fontSize: 11,
      fontWeight: 600,
      letterSpacing: "0.05em",
      textTransform: "uppercase",
      background: c.bg,
      color: c.color,
    }}>
      {label}
    </span>
  );
}
