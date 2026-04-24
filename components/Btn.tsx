import { ReactNode, ButtonHTMLAttributes } from "react";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
}

const VARIANTS = {
  primary: {
    background: "var(--green)",
    color: "#000",
    border: "none",
    fontWeight: "700",
  },
  secondary: {
    background: "var(--bg-elevated)",
    color: "var(--text)",
    border: "1px solid var(--border)",
    fontWeight: "500",
  },
  danger: {
    background: "rgba(248,113,113,0.15)",
    color: "#f87171",
    border: "1px solid rgba(248,113,113,0.3)",
    fontWeight: "600",
  },
  ghost: {
    background: "transparent",
    color: "var(--text-muted)",
    border: "none",
    fontWeight: "500",
  },
};

export default function Btn({ children, variant = "secondary", size = "md", style, ...props }: BtnProps) {
  const v = VARIANTS[variant];
  return (
    <button
      {...props}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: size === "sm" ? "5px 12px" : "8px 16px",
        borderRadius: 7,
        fontSize: size === "sm" ? 12 : 13,
        cursor: "pointer",
        transition: "opacity 0.15s",
        ...v,
        ...(props.disabled ? { opacity: 0.4, cursor: "not-allowed" } : {}),
        ...style,
      }}
      onMouseEnter={e => { if (!props.disabled) (e.currentTarget.style.opacity = "0.85"); }}
      onMouseLeave={e => { (e.currentTarget.style.opacity = "1"); }}
    >
      {children}
    </button>
  );
}
