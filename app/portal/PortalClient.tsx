"use client";

import React, { useState, useEffect, Component, type ReactNode } from "react";

declare global {
  interface Window {
    Telegram?: {
      WebApp?: {
        ready: () => void;
        expand: () => void;
        initData: string;
        themeParams: Record<string, string>;
        openTelegramLink?: (url: string) => void;
      };
    };
  }
}

interface AgentSummary {
  player_id: number; name: string; handle: string | null; joined_at: string | null;
  filleuls_count: number;
  summary: { lifetime: number; paid: number; pending: number };
}

interface OwnerData {
  mode: "owner";
  total_due_all_agents: number;
  total_paid_all_agents: number;
  agents: AgentSummary[];
}

interface FilleulGame { game_name: string; rate_label: string; rate_pct: number; agency_pnl: number; currency: string; }
interface Filleul {
  name: string; handle: string | null;
  window_status: { is_open: boolean; days_remaining?: number; days_elapsed?: number };
  games: FilleulGame[];
  part_agence_eligible: number;
}
interface DashboardData {
  mode?: "agent";
  affiliate: { name: string; handle: string | null; joined_at: string | null };
  summary: { lifetime_usdt: number; paid_usdt: number; pending_usdt: number; cumul_agence: number };
  share_link: string;
  filleuls: Filleul[];
  payments: { paid_at: string; game_name: string; amount_usdt: number; tx_hash: string | null; notes: string | null }[];
}

type ApiResponse = OwnerData | DashboardData;

// Defensive — a missing/NaN money field renders as 0.00 instead of throwing (no more white-screen crash).
const num = (n: unknown): number => (typeof n === "number" && isFinite(n) ? n : 0);
const fmt = (n: unknown) => num(n).toFixed(2);
const GREEN = "#22C55E", RED = "#EF4444", GREY = "#9CA3AF";
const signedColor = (n: number) => (n > 0.005 ? GREEN : n < -0.005 ? RED : GREY);
const signedText = (n: number, cur = "USDT") => `${num(n) > 0.005 ? "+" : ""}${fmt(n)} ${cur}`;

const GAME_COLORS: Record<string, string> = {
  KKPOKER: "#3B82F6", A5POKER: "#F59E0B", Wepoker: "#8B5CF6", TELE: "#D4AF37",
};

const cardStyle: React.CSSProperties = { background: "var(--tg-theme-secondary-bg-color, #1a1a1a)", borderRadius: 12, padding: "14px 16px" };
const hintStyle: React.CSSProperties = { color: "var(--tg-theme-hint-color, #707579)", fontSize: 12 };

// ── Error boundary: any render error → clean degraded state, never a blank crash ──
class PortalErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  constructor(props: { children: ReactNode }) { super(props); this.state = { hasError: false }; }
  static getDerivedStateFromError() { return { hasError: true }; }
  componentDidCatch(err: unknown) { console.error("[portal] render error:", err); }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, textAlign: "center", color: "var(--tg-theme-text-color, #fff)" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>⚠️</div>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Affichage indisponible</div>
          <div style={hintStyle}>Réessaie dans un instant, ou contacte @baki77777.</div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function PortalClient() {
  const [state, setState] = useState<"loading" | "no-auth" | "forbidden" | "error" | "ok">("loading");
  const [response, setResponse] = useState<ApiResponse | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<number | null>(null);
  const [initDataStr, setInitDataStr] = useState("");

  function fetchDashboard(initData: string, agentId?: number | null) {
    setState("loading");
    fetch("/api/portal/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ initData, ...(agentId ? { agent_id: agentId } : {}) }),
    })
      .then(async res => {
        if (res.status === 401) { setState("no-auth"); return; }
        if (res.status === 403) { setState("forbidden"); return; }
        if (!res.ok) { setState("error"); return; }
        setResponse(await res.json());
        setState("ok");
      })
      .catch(() => setState("error"));
  }

  useEffect(() => {
    const tg = window.Telegram?.WebApp;
    if (tg) { tg.ready(); tg.expand(); }
    const initData = tg?.initData || "";
    setInitDataStr(initData);
    if (!initData) { setState("no-auth"); return; }
    fetchDashboard(initData);
  }, []);

  function selectAgent(agentId: number) { setSelectedAgentId(agentId); fetchDashboard(initDataStr, agentId); }
  function backToOverview() { setSelectedAgentId(null); fetchDashboard(initDataStr); }

  const s: React.CSSProperties = {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: "var(--tg-theme-bg-color, #0f0f0f)",
    color: "var(--tg-theme-text-color, #fff)",
    minHeight: "100vh", padding: "16px", maxWidth: 720, margin: "0 auto",
  };
  const accent = "var(--tg-theme-button-color, #2ea043)";

  if (state === "loading") return <div style={{ ...s, display: "flex", justifyContent: "center", alignItems: "center" }}><div style={hintStyle}>Chargement...</div></div>;

  if (state === "no-auth") return (
    <div style={{ ...s, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 16, textAlign: "center", paddingTop: 80 }}>
      <div style={{ fontSize: 40 }}>🔒</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Cette page doit être ouverte depuis le bot Telegram</div>
      <div style={hintStyle}>DM @LeCercle_Lebot et tape <b>/myaffi</b></div>
    </div>
  );

  if (state === "forbidden") return (
    <div style={{ ...s, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 16, textAlign: "center", paddingTop: 80 }}>
      <div style={{ fontSize: 40 }}>🚫</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Tu n'es pas agent</div>
      <div style={hintStyle}>Contacte @baki77777 pour rejoindre le programme.</div>
    </div>
  );

  if (state === "error" || !response) return (
    <div style={{ ...s, display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", gap: 16, textAlign: "center", paddingTop: 80 }}>
      <div style={{ fontSize: 40 }}>⚠️</div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>Erreur de chargement</div>
      <div style={hintStyle}>Réessaie dans quelques minutes.</div>
    </div>
  );

  // Owner overview mode
  if (response.mode === "owner") {
    const ow = response as OwnerData;
    return (
      <div style={s}>
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>👑 Vue Owner</div>
          <div style={hintStyle}>{ow.agents.length} agents · {fmt(ow.total_due_all_agents)} USDT en attente · {fmt(ow.total_paid_all_agents)} USDT payé</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {ow.agents.length === 0 && <div style={{ ...cardStyle, textAlign: "center" }}><div style={hintStyle}>Aucun agent activé.</div></div>}
          {ow.agents.map(a => (
            <div key={a.player_id} onClick={() => selectAgent(a.player_id)} style={{ ...cardStyle, cursor: "pointer", display: "flex", alignItems: "center", gap: 14 }}>
              <div style={{ width: 40, height: 40, borderRadius: "50%", background: accent, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16, fontWeight: 700, color: "var(--tg-theme-button-text-color, #fff)", flexShrink: 0 }}>
                {a.name.slice(0, 2).toUpperCase()}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{a.name} {a.handle && <span style={hintStyle}>@{a.handle}</span>}</div>
                <div style={{ ...hintStyle, fontSize: 11 }}>Filleuls: {a.filleuls_count} · Depuis {a.joined_at ?? "—"}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 14, color: num(a.summary?.pending) > 0 ? accent : "var(--tg-theme-text-color, #fff)" }}>{fmt(a.summary?.pending)}</div>
                <div style={{ ...hintStyle, fontSize: 10 }}>USDT dû</div>
              </div>
            </div>
          ))}
        </div>
        <div style={{ textAlign: "center", padding: "24px 0", ...hintStyle }}><div>LeCerclePoker</div></div>
      </div>
    );
  }

  // Agent dashboard mode — wrapped so any render error degrades gracefully
  return (
    <PortalErrorBoundary>
      <AgentDashboard data={response as DashboardData} selectedAgentId={selectedAgentId} onBack={backToOverview} containerStyle={s} />
    </PortalErrorBoundary>
  );
}

function ShareSection({ shareLink, compact }: { shareLink: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const accent = "var(--tg-theme-button-color, #2ea043)";
  async function copy() {
    try { await navigator.clipboard.writeText(shareLink); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch {}
  }
  function share() {
    const text = "Rejoins-moi sur LeCerclePoker 🎰 — action couverte, cashout direct.";
    const url = `https://t.me/share/url?url=${encodeURIComponent(shareLink)}&text=${encodeURIComponent(text)}`;
    try { window.Telegram?.WebApp?.openTelegramLink?.(url); } catch { window.open(url, "_blank"); }
  }
  return (
    <div style={{ ...cardStyle, marginBottom: 24 }}>
      <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>📣 Partage ton lien de recrutement</div>
      <div onClick={share} style={{ padding: "10px 12px", background: "rgba(255,255,255,0.05)", borderRadius: 8, fontFamily: "monospace", fontSize: 12, wordBreak: "break-all", marginBottom: 12, color: "var(--tg-theme-link-color, #2ea043)", cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
        {shareLink}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button onClick={share} style={{ flex: 1, padding: "10px 16px", borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: "pointer", background: accent, color: "var(--tg-theme-button-text-color, #fff)", border: "none" }}>
          📤 Partager maintenant
        </button>
        <button onClick={copy} style={{ padding: "10px 16px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", background: "transparent", color: accent, border: `1px solid ${accent}` }}>
          {copied ? "✅ Copié" : "📋 Copier"}
        </button>
      </div>
      {!compact && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 14 }}>
          {[
            { step: "1️⃣", text: "Partage ton lien" },
            { step: "2️⃣", text: "Ton contact s'inscrit" },
            { step: "3️⃣", text: "Tu gagnes 50% lifetime" },
          ].map(x => (
            <div key={x.step} style={{ background: "rgba(255,255,255,0.03)", borderRadius: 8, padding: "10px 8px", textAlign: "center" }}>
              <div style={{ fontSize: 18, marginBottom: 4 }}>{x.step}</div>
              <div style={{ fontSize: 11, ...hintStyle }}>{x.text}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AgentDashboard({ data, selectedAgentId, onBack, containerStyle }: { data: DashboardData; selectedAgentId: number | null; onBack: () => void; containerStyle: React.CSSProperties }) {
  const { affiliate, summary, filleuls, payments, share_link } = data;
  const cumul = num(summary?.cumul_agence);
  const accent = "var(--tg-theme-button-color, #2ea043)";
  const link = "var(--tg-theme-link-color, #2ea043)";
  const list = filleuls ?? [];

  return (
    <div style={containerStyle}>
      {selectedAgentId && (
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", borderRadius: 8, fontSize: 13, cursor: "pointer", background: "transparent", border: "1px solid var(--tg-theme-hint-color, #707579)", color: "var(--tg-theme-hint-color, #707579)", marginBottom: 16 }}>
          ← Retour overview
        </button>
      )}

      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{selectedAgentId ? affiliate.name : `Bienvenue ${affiliate.name}`} 🎰</div>
        <div style={hintStyle}>Agent depuis {affiliate.joined_at ?? "—"}</div>
      </div>

      {/* Stats (agent-level, cross-makeup) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 10, marginBottom: 16 }}>
        {[
          { label: "Commission (lifetime)", icon: "💰", value: num(summary?.lifetime_usdt) },
          { label: "Payé", icon: "✅", value: num(summary?.paid_usdt) },
          { label: "Dû maintenant", icon: "⏳", value: num(summary?.pending_usdt) },
        ].map(st => (
          <div key={st.label} style={cardStyle}>
            <div style={{ ...hintStyle, marginBottom: 4 }}>{st.icon} {st.label}</div>
            <div style={{ fontSize: 18, fontWeight: 700, color: st.value > 0 ? accent : "var(--tg-theme-text-color, #fff)" }}>{fmt(st.value)} USDT</div>
          </div>
        ))}
      </div>

      {/* Cumul croisé (mirrors CRM drawer) */}
      <div style={{ ...cardStyle, marginBottom: cumul < 0 ? 10 : 24 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
          <span style={hintStyle}>Cumul agence global (tous tes filleuls)</span>
          <span style={{ fontWeight: 700, fontSize: 15, color: signedColor(cumul) }}>{signedText(cumul)}</span>
        </div>
        <div style={{ ...hintStyle, fontSize: 11 }}>
          Ta commission = max(0, cumul) × 50% = <b style={{ color: "var(--tg-theme-text-color,#fff)" }}>{fmt(summary?.lifetime_usdt)} USDT</b>
        </div>
      </div>
      {cumul < 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 12px", borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", color: RED, fontSize: 12, fontWeight: 600, marginBottom: 24 }}>
          ⚠️ Ton portefeuille filleuls est en négatif. Comble {fmt(-cumul)} USDT (gains futurs) avant de toucher une commission.
        </div>
      )}

      {/* Share — permanent (compact when the agent already has filleuls) */}
      <ShareSection shareLink={share_link} compact={list.length > 0} />

      {/* Filleuls */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Mes filleuls ({list.length})</div>
        {list.length === 0 ? (
          <div style={{ ...cardStyle, textAlign: "center" }}>
            <div style={hintStyle}>Aucun filleul pour l'instant — partage ton lien pour démarrer !</div>
          </div>
        ) : list.map((f, i) => {
          const part = num(f.part_agence_eligible);
          return (
            <div key={i} style={{ ...cardStyle, marginBottom: 8 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                <div>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{f.name}</span>
                  {f.handle && <span style={{ ...hintStyle, marginLeft: 6 }}>@{f.handle}</span>}
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: signedColor(part) }}>{signedText(part)}</span>
              </div>
              <div style={{ marginBottom: 8 }}>
                {f.window_status?.is_open
                  ? <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(34,197,94,0.12)", color: GREEN, fontWeight: 600 }}>🟢 Fenêtre ouverte — J+{30 - num(f.window_status.days_remaining)}/30</span>
                  : <span style={{ fontSize: 10, padding: "2px 6px", borderRadius: 4, background: "rgba(156,163,175,0.12)", color: GREY, fontWeight: 600 }}>🔒 Fenêtre fermée depuis {f.window_status?.days_elapsed ?? "?"}j</span>
                }
              </div>
              {(f.games ?? []).map(g => (
                <div key={g.game_name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12 }}>
                  <span style={{ background: `${GAME_COLORS[g.game_name] ?? "#666"}22`, color: GAME_COLORS[g.game_name] ?? "#999", padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>
                    {g.game_name.slice(0, 2).toUpperCase()}
                  </span>
                  {g.rate_label === "éligible"
                    ? <span style={{ fontSize: 10, color: GREEN, fontWeight: 600 }}>✅ compte (50%)</span>
                    : <span style={{ fontSize: 10, color: GREY }}>⏰ hors fenêtre — non compté</span>
                  }
                  <span style={{ marginLeft: "auto", fontWeight: 600, color: signedColor(num(g.agency_pnl)) }}>{signedText(num(g.agency_pnl), g.currency || "USDT")}</span>
                </div>
              ))}
            </div>
          );
        })}
      </div>

      {/* Payments */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>Paiements reçus</div>
        {(payments ?? []).length === 0 ? (
          <div style={{ ...cardStyle, textAlign: "center" }}><div style={hintStyle}>Aucun paiement encore.</div></div>
        ) : (
          <div style={cardStyle}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                  <th style={{ textAlign: "left", padding: "6px 4px", ...hintStyle, fontWeight: 600 }}>Date</th>
                  <th style={{ textAlign: "center", padding: "6px 4px", ...hintStyle, fontWeight: 600 }}>Game</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", ...hintStyle, fontWeight: 600 }}>Montant</th>
                  <th style={{ textAlign: "right", padding: "6px 4px", ...hintStyle, fontWeight: 600 }}>TX</th>
                </tr>
              </thead>
              <tbody>
                {(payments ?? []).map((p, i) => (
                  <tr key={i} style={{ borderBottom: "1px solid rgba(255,255,255,0.05)" }}>
                    <td style={{ padding: "8px 4px", ...hintStyle }}>{p.paid_at?.slice(0, 10)}</td>
                    <td style={{ textAlign: "center", padding: "8px 4px" }}>{p.game_name}</td>
                    <td style={{ textAlign: "right", padding: "8px 4px", fontWeight: 600, color: accent }}>{fmt(p.amount_usdt)}</td>
                    <td style={{ textAlign: "right", padding: "8px 4px" }}>
                      {p.tx_hash ? (
                        <a href={`https://tronscan.org/#/transaction/${p.tx_hash}`} target="_blank" rel="noopener" style={{ color: link, textDecoration: "none" }}>{p.tx_hash.slice(0, 8)}...</a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Comment ça marche — makeup CROISÉ */}
      <div style={{ ...cardStyle, marginBottom: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>🎯 Comment ça marche</div>
        <div style={{ fontSize: 12, display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          <div><span style={{ color: GREEN, fontWeight: 600 }}>50% lifetime</span> <span style={hintStyle}>— sur les games où ton filleul est onboardé dans les 30 premiers jours</span></div>
          <div><span style={{ color: GREY, fontWeight: 600 }}>Après 30j</span> <span style={hintStyle}>— les nouveaux games ne comptent plus</span></div>
        </div>
        <div style={{ fontSize: 12, marginBottom: 8 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>💡 Makeup croisé</div>
          <div style={hintStyle}>On additionne le résultat agence de <b>tous tes filleuls</b> (gains ET pertes). Tu touches 50% du <b>cumul total</b> seulement s'il est positif. Un filleul en perte réduit ton cumul ; tes filleuls gagnants le comblent. Tant que le cumul global est négatif, tu touches 0 — et ça se reporte automatiquement.</div>
        </div>
        <div style={{ fontSize: 12 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>⚠️ Responsabilité</div>
          <div style={hintStyle}>Tu réponds de tes filleuls. Si l'un part avec ses gains sans régler son action (scam), le montant est déduit de ton cumul. Choisis bien qui tu ramènes.</div>
        </div>
      </div>

      <div style={{ textAlign: "center", padding: "16px 0", ...hintStyle }}>
        <div>Questions ? @baki77777</div>
        <div style={{ marginTop: 4, fontSize: 10, opacity: 0.5 }}>LeCerclePoker</div>
      </div>
    </div>
  );
}
