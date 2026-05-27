"use client";

import { useState, useEffect } from "react";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        initData: string;
        themeParams: Record<string, string>;
      };
    };
  }
}

interface DashboardData {
  affiliate: { name: string; handle: string | null; joined_at: string | null };
  summary: { lifetime_usdt: number; paid_usdt: number; pending_usdt: number };
  filleuls: {
    name: string; handle: string | null;
    games: { game_name: string; rate_label: string; rate_pct: number; earned: number; due_now: number }[];
    total_earned: number;
  }[];
  payments: { paid_at: string; game_name: string; amount_usdt: number; tx_hash: string | null; notes: string | null }[];
}

const fmt = (n: number) => n.toFixed(2);

const GAME_COLORS: Record<string, string> = {
  KKPOKER: "#3B82F6", A5POKER: "#F59E0B", Wepoker: "#8B5CF6", TELE: "#D4AF37",
};

export default function PortalClient() {
  const [state, setState] = useState<"loading" | "no-auth" | "forbidden" | "error" | "ok">("loading");
  const [data, setData] = useState<DashboardData | null>(null);

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.ready(); tg.expand(); }

    const initData = tg?.initData || "";
    if (!initData) { setState("no-auth"); return; }

    fetch("/api/portal/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData }),
    })
      .then(async res => {
        if (res.status === 401) { setState("no-auth"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        if (!res.ok) { setState("error"); return; }
        setData(await res.json());
        setState("ok");
      })
      .catch(() => setState("error"));
  }, []);

  const s: React.CSSProperties = {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: "var(--tg-theme-bg-color, #0f0f0f)",
    color: "var(--tg-theme-text-color, #fff)",
    minHeight: "100vh",
    padding: "16px",
    maxWidth: 720,
    margin: "0 auto",
  };
  const card: React.CSSProperties = {
    background: "var(--tg-theme-secondary-bg-color, #1a1a1a)",
    borderRadius: 12,
    padding: "14px 16px",
  };
  const hint: React.CSSProperties = { color: "var(--tg-theme-hint-color, #707579)", fontSize: 12 };
  const accent = "var(--tg-theme-button-color, #2ea043)";
  const link = "var(--tg-theme-link-color, #2ea043)";

  if (state === "loading") return <div style={{ ...s, display: "flex", justifyContent: "center", alignItems: "center" }}><div style={hint}>Chargement...</div></div>;

  if (state === "no-auth") return (
    <div style={{ ...s, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 16, textAlign: "center", paddingTop: 80 }}>
      <div style={{ fontSize: 40 }}>🔒</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Cette page doit être ouverte depuis le bot Telegram</div>
      <div style={hint}>DM @LeCercle_Lebot et tape <b>/myaffi</b></div>
    </div>
  );

  if (state === "forbidden") return (
    <div style={{ ...s, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 16, textAlign: "center", paddingTop: 80 }}>
      <div style={{ fontSize: 40 }}>🚫</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Tu n'es pas affilié</div>
      <div style={hint}>Contacte @baki77777 pour rejoindre le programme affiliate.</div>
    </div>
  );

  if (state === "error" || !data) return (
    <div style={{ ...s, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 16, textAlign: "center", paddingTop: 80 }}>
      <div style={{ fontSize: 40 }}>⚠️</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Erreur de chargement</div>
      <div style={hint}>Réessaie dans quelques minutes.</div>
    </div>
  );

  const { affiliate, summary, filleuls, payments } = data;

  return (
    <div style={s}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Bonjour {affiliate.name} 👋</div>
        <div style={hint}>Affilié depuis {affiliate.joined_at ?? "—"}</div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 24 }}>
        {[
          { label: "Lifetime", icon: "💰", value: summary.lifetime_usdt },
          { label: "Payé", icon: "✅", value: summary.paid_usdt },
          { label: "En attente", icon: "⏳", value: summary.pending_usdt },
        ].map(s => (
          <div key={s.label} style={card}>
            <div style={{ ...hint, marginBottom: 4 }}>{s.icon} {s.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: s.value > 0 ? accent : "var(--tg-theme-text-color, #fff)" }}>{fmt(s.value)} USDT</div>
          </div>
        ))}
      </div>

      {/* Filleuls */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Mes filleuls ({filleuls.length})</div>
        {filleuls.length === 0 ? (
          <div style={{ ...card, textAlign: "center" }}>
            <div style={hint}>Aucun filleul pour le moment.</div>
            <div style={{ ...hint, marginTop: 4 }}>Tape <b>/affiliation</b> dans ton groupe pour ramener des joueurs.</div>
          </div>
        ) : filleuls.map((f, i) => (
          <div key={i} style={{ ...card, marginBottom: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{f.name}</span>
                {f.handle && <span style={{ ...hint, marginLeft: 6 }}>@{f.handle}</span>}
              </div>
              <span style={{ fontSize: 13, fontWeight: 600, color: accent }}>{fmt(f.total_earned)} USDT</span>
            </div>
            {f.games.map(g => (
              <div key={g.game_name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
                <span style={{ background: `${GAME_COLORS[g.game_name] ?? "#666"}22`, color: GAME_COLORS[g.game_name] ?? "#999", padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                  {g.game_name.slice(0, 2).toUpperCase()}
                </span>
                <span style={hint}>{g.rate_label} {g.rate_pct}%</span>
                <span style={{ marginLeft: "auto", fontWeight: 500 }}>{fmt(g.earned)} USDT</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* Payments */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Paiements reçus</div>
        {payments.length === 0 ? (
          <div style={{ ...card, textAlign: "center" }}><div style={hint}>Aucun paiement encore.</div></div>
        ) : (
          <div style={card}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  <th style={{ textAlign: "left", padding: "6px 4px", ...hint, fontWeight: 600 }}>Date</th>
                  <th style={{ textAlign: "center", padding: "6px 4px", ...hint, fontWeight: 600 }}>Game</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", ...hint, fontWeight: 600 }}>Montant</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", ...hint, fontWeight: 600 }}>TX</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <td style={{ padding: "8px 4px", color: "var(--tg-theme-hint-color, #707579)" }}>{p.paid_at?.slice(0, 10)}</td>
                    <td style={{ textAlign: "center", padding: "8px 4px" }}>{p.game_name}</td>
                    <td style={{ textAlign: "right", padding: "8px 4px", fontWeight: 600, color: accent }}>{fmt(p.amount_usdt)}</td>
                    <td style={{ textAlign: "right", padding: "8px 4px" }}>
                      {p.tx_hash ? (
                        <a href={`https://tronscan.org/#/transaction/${p.tx_hash}`} target="_blank" rel="noopener" style={{ color: link, textDecoration: "none" }}>
                          {p.tx_hash.slice(0, 8)}...
                        </a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{ textAlign: "center", padding: "16px 0", ...hint }}>
        <div>Questions ? Contacte @baki77777</div>
        <div style={{ marginTop: 4, fontSize: 10, opacity: 0.5 }}>LeCerclePoker</div>
      </div>
    </div>
  );
}
