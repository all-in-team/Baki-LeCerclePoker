// Btn — bouton réutilisable de l app. NE PAS toucher type=submit hack pour l instant (voir QA report 2026-04-27).
import { ReactNode, ButtonHTMLAttributes } from "react";

interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
  size?: "sm" | "md";
}

const VARIANTS = {
  primary: {
    background: "linear-gradient(135deg, #10B981, #047857)",
    color: "#fff",
    border: "none",
    fontWeight: "700",
  },
  secondary: {
    background: "#22252B",
    color: "#E8E8EE",
    border: "1px solid rgba(255,255,255,0.08)",
    fontWeight: "500",
  },
  danger: {
    background: "rgba(239,68,68,0.12)",
    color: "#EF4444",
    border: "1px solid rgba(239,68,68,0.2)",
    fontWeight: "600",
  },
  ghost: {
    background: "transparent",
    color: "#8888A0",
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
        borderRadius: 8,
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
