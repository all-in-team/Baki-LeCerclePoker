interface BadgeProps {
  label: string;
  color?: "green" | "gold" | "red" | "gray" | "blue";
}

const COLORS = {
  green: { bg: "rgba(34,197,94,0.15)", color: "#22c55e" },
  gold: { bg: "rgba(212,175,55,0.15)", color: "#d4af37" },
  red: { bg: "rgba(248,113,113,0.15)", color: "#f87171" },
  gray: { bg: "rgba(136,136,160,0.15)", color: "#8888a0" },
  blue: { bg: "rgba(96,165,250,0.15)", color: "#60a5fa" },
};

export default function Badge({ label, color = "gray" }: BadgeProps) {
  const c = COLORS[color];
  return (
    <span style={{
      display: "inline-block",
      padding: "2px 8px",
      borderRadius: 4,
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
