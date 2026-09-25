"use client";

// Briques d'interface de l'écran Diffusion @LeCercle_Lebot — mêmes styles que
// le panneau DZPK, recopiés plutôt qu'importés pour ne pas toucher à celui-ci.

import type { HtmlNode } from "@/lib/funnels/lecercle/html";

export const INPUT: React.CSSProperties = {
  width: "100%", padding: "8px 10px", borderRadius: 8, fontSize: 13,
  background: "#0B0E13", border: "1px solid rgba(255,255,255,0.1)", color: "#E8E8EE",
  fontFamily: "inherit",
};

export const LABEL: React.CSSProperties = {
  fontSize: 10.5, fontWeight: 700, color: "#555568",
  textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 5, display: "block",
};

export const STATUS_LABEL: Record<string, { label: string; color: string }> = {
  draft: { label: "brouillon", color: "#8888A0" },
  scheduled: { label: "🕒 programmée", color: "#60A5FA" },
  running: { label: "⏳ en cours", color: "#F0B90B" },
  paused: { label: "⏸ en pause", color: "#F87171" },
  done: { label: "✅ terminée", color: "#34D399" },
  cancelled: { label: "annulée", color: "#555568" },
};

export function Btn({ onClick, disabled, tone, children }: {
  onClick: () => void; disabled?: boolean; tone?: "primary" | "danger"; children: React.ReactNode;
}) {
  const bg = tone === "primary" ? "rgba(52,211,153,0.12)"
    : tone === "danger" ? "rgba(248,113,113,0.10)" : "rgba(255,255,255,0.05)";
  const color = tone === "primary" ? "#34D399" : tone === "danger" ? "#F87171" : "#8888A0";
  return (
    <button onClick={onClick} disabled={disabled} style={{
      padding: "7px 13px", borderRadius: 8, fontSize: 12, fontWeight: 600,
      cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.4 : 1,
      border: `1px solid ${tone ? color + "40" : "rgba(255,255,255,0.1)"}`,
      background: bg, color, fontFamily: "inherit",
    }}>{children}</button>
  );
}

export function Chip({ active, onClick, children, title }: {
  active: boolean; onClick: () => void; children: React.ReactNode; title?: string;
}) {
  return (
    <button onClick={onClick} title={title} style={{
      padding: "5px 11px", borderRadius: 999, fontSize: 11.5, fontWeight: 600, cursor: "pointer",
      border: `1px solid ${active ? "rgba(52,211,153,0.35)" : "rgba(255,255,255,0.1)"}`,
      background: active ? "rgba(52,211,153,0.10)" : "#11141A",
      color: active ? "#34D399" : "#555568", fontFamily: "inherit",
    }}>{children}</button>
  );
}

/** « 2026-09-25 19:07:21 » (UTC, SQLite) → « 26/09 03:07 » en UTC+8. */
export function fmtUtc8(sql: string | null | undefined, withYear = false): string {
  if (!sql) return "—";
  const t = Date.parse(sql.replace(" ", "T") + "Z");
  if (Number.isNaN(t)) return sql;
  const d = new Date(t + 8 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}${withYear ? `/${d.getUTCFullYear()}` : ""}`;
  return `${day} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export function displayName(r: { username: string | null; first_name: string | null }): string {
  if (r.username) return `@${r.username.replace(/^@/, "")}`;
  return r.first_name || "—";
}

export function pct(n: number, d: number): string {
  if (!d) return "—";
  return `${Math.round((n / d) * 1000) / 10} %`;
}

/**
 * Aperçu du message tel que Telegram le rendra, construit depuis l'arbre du
 * validateur — jamais par innerHTML : seules les balises admises existent.
 */
export function HtmlPreview({ nodes, buttonLabel }: { nodes: HtmlNode[]; buttonLabel?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 420 }}>
      <div style={{
        background: "#182533", borderRadius: "12px 12px 12px 4px", padding: "8px 12px",
        fontSize: 13.5, color: "#E8E8EE", whiteSpace: "pre-wrap", lineHeight: 1.45, wordBreak: "break-word",
      }}>
        {renderNodes(nodes)}
      </div>
      {buttonLabel?.trim() && (
        <div style={{
          background: "#1F2F3F", borderRadius: 8, padding: "7px 12px", textAlign: "center",
          fontSize: 13, color: "#E8E8EE", fontWeight: 500,
        }}>{buttonLabel} ↗</div>
      )}
    </div>
  );
}

function renderNodes(nodes: HtmlNode[]): React.ReactNode[] {
  return nodes.map((n, i) => {
    if (n.type === "text") return n.text;
    const kids = renderNodes(n.children);
    switch (n.tag) {
      case "b": case "strong": return <strong key={i}>{kids}</strong>;
      case "i": case "em": return <em key={i}>{kids}</em>;
      case "u": case "ins": return <u key={i}>{kids}</u>;
      case "s": case "strike": case "del": return <s key={i}>{kids}</s>;
      case "tg-spoiler": case "span":
        return <span key={i} style={{ background: "#3A4A5A", color: "transparent", borderRadius: 3, textShadow: "0 0 6px #9AA" }}>{kids}</span>;
      case "a": return <span key={i} style={{ color: "#6AB3F3", textDecoration: "underline" }}>{kids}</span>;
      case "code": return <code key={i} style={{ fontFamily: "monospace", color: "#F0B90B" }}>{kids}</code>;
      case "pre": return <pre key={i} style={{ fontFamily: "monospace", background: "#0F1A24", padding: 8, borderRadius: 6, margin: "4px 0" }}>{kids}</pre>;
      case "blockquote": return <blockquote key={i} style={{ borderLeft: "3px solid #6AB3F3", margin: "4px 0", paddingLeft: 8 }}>{kids}</blockquote>;
      default: return <span key={i}>{kids}</span>;
    }
  });
}
