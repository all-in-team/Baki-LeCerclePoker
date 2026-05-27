"use client";

import { useEffect, useState } from "react";
import { X, DollarSign, Pencil } from "lucide-react";

const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
};

interface GameBreakdown {
  game_id: number; game_name: string; rate: number; rate_label: string;
  agency_pnl_lifetime: number; earned_lifetime: number; paid_lifetime: number; due_now: number;
}

interface RelData {
  id: number;
  affiliate: { id: number; name: string; telegram_handle: string | null };
  referred: { id: number; name: string; telegram_handle: string | null };
  origin_game: { id: number | null; name: string | null };
  status: string; start_date: string;
  disclosed_action_pct: number | null; disclosed_rakeback_pct: number | null; disclosed_insurance_pct: number | null;
  games: GameBreakdown[];
  total_due_now: number; total_paid_lifetime: number; last_paid_at: string | null;
}

interface Payment {
  id: number; game_id: number; game_name: string; amount_usdt: number; paid_at: string;
  week_start_date: string; week_end_date: string; tx_hash: string | null; notes: string | null;
}

interface Props {
  rel: RelData;
  onClose: () => void;
  onPay: (gameId: number, gameName: string, due: number) => void;
  onEdit: () => void;
}

const fmt = (n: number) => n.toFixed(2);

export default function AffiliateDetailDrawer({ rel, onClose, onPay, onEdit }: Props) {
  const breakdown = rel.games as GameBreakdown[];
  const [payments, setPayments] = useState<Payment[]>([]);
  const [loadingPayments, setLoadingPayments] = useState(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  useEffect(() => {
    setLoadingPayments(true);
    fetch(`/api/affiliate-payments?relationship_id=${rel.id}`)
      .then(r => r.json()).then(setPayments).finally(() => setLoadingPayments(false));
  }, [rel.id]);

  const RATE_LABEL_STYLE: Record<string, { bg: string; color: string }> = {
    origin: { bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
    "grâce": { bg: "rgba(34,197,94,0.12)", color: "#22C55E" },
    passif: { bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" },
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.5)" }} />
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 201, width: "min(480px, 100vw)", background: "var(--bg-raised)", borderLeft: "1px solid var(--border)", overflowY: "auto", padding: "24px", display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text)" }}>
              {rel.affiliate.telegram_handle ? `@${rel.affiliate.telegram_handle}` : rel.affiliate.name} → {rel.referred.telegram_handle ? `@${rel.referred.telegram_handle}` : rel.referred.name}
            </div>
            <div style={{ fontSize: 13, color: "var(--text-dim)", marginTop: 4 }}>
              Depuis {rel.start_date} · {rel.status}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-dim)", padding: 4 }}><X size={18} /></button>
        </div>

        {/* Total due */}
        <div style={{ padding: "12px 16px", borderRadius: 8, background: rel.total_due_now > 0 ? "rgba(34,197,94,0.08)" : "var(--bg-surface)", border: `1px solid ${rel.total_due_now > 0 ? "rgba(34,197,94,0.3)" : "var(--border)"}` }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>Total dû</div>
          <span style={{ fontSize: 22, fontWeight: 700, color: rel.total_due_now > 0 ? "#22C55E" : "var(--text-dim)" }}>{fmt(rel.total_due_now)} USDT</span>
          <span style={{ fontSize: 12, color: "var(--text-dim)", marginLeft: 12 }}>payé: {fmt(rel.total_paid_lifetime)}</span>
        </div>

        {/* Per-game breakdown */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>Breakdown par game</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase" }}>
                <th style={{ textAlign: "left", padding: "6px 4px" }}>Game</th>
                <th style={{ textAlign: "right", padding: "6px 4px" }}>Agency</th>
                <th style={{ textAlign: "center", padding: "6px 4px" }}>Rate</th>
                <th style={{ textAlign: "right", padding: "6px 4px" }}>Earned</th>
                <th style={{ textAlign: "right", padding: "6px 4px" }}>Paid</th>
                <th style={{ textAlign: "right", padding: "6px 4px" }}>Due</th>
                <th style={{ padding: "6px 4px" }}></th>
              </tr>
            </thead>
            <tbody>
              {breakdown.length === 0 && <tr><td colSpan={7} style={{ padding: 16, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>Pas encore de deals. Assigne un game à @{rel.referred.telegram_handle ?? rel.referred.name} dans /crm pour démarrer le tracking.</td></tr>}
              {breakdown.map(b => {
                const gb = GAME_BADGES[b.game_name] ?? { short: b.game_name.slice(0, 2), bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };
                const rl = RATE_LABEL_STYLE[b.rate_label] ?? RATE_LABEL_STYLE.passif;
                return (
                  <tr key={b.game_id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "8px 4px" }}>
                      <span style={{ background: gb.bg, color: gb.color, padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 }}>{gb.short}</span>
                      <span style={{ marginLeft: 6, padding: "1px 5px", borderRadius: 3, fontSize: 9, fontWeight: 600, background: rl.bg, color: rl.color }}>{b.rate_label}</span>
                    </td>
                    <td style={{ textAlign: "right", padding: "8px 4px", color: "var(--text-muted)" }}>{fmt(b.agency_pnl_lifetime)}</td>
                    <td style={{ textAlign: "center", padding: "8px 4px" }}>{Math.round(b.rate * 100)}%</td>
                    <td style={{ textAlign: "right", padding: "8px 4px" }}>{fmt(b.earned_lifetime)}</td>
                    <td style={{ textAlign: "right", padding: "8px 4px", color: "var(--text-dim)" }}>{fmt(b.paid_lifetime)}</td>
                    <td style={{ textAlign: "right", padding: "8px 4px", fontWeight: 600, color: b.due_now > 0 ? "#22C55E" : "var(--text-dim)" }}>{fmt(b.due_now)}</td>
                    <td style={{ padding: "8px 4px" }}>
                      {b.due_now > 0 && (
                        <button onClick={() => onPay(b.game_id, b.game_name, b.due_now)} style={{ display: "flex", alignItems: "center", gap: 3, padding: "3px 8px", borderRadius: 5, fontSize: 10, fontWeight: 600, cursor: "pointer", background: "rgba(34,197,94,0.12)", border: "1px solid rgba(34,197,94,0.3)", color: "#22C55E" }}>
                          <DollarSign size={10} /> Pay
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Disclosed rates */}
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em" }}>Disclosed rates</span>
            <button onClick={onEdit} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 5, fontSize: 10, cursor: "pointer", background: "none", border: "1px solid var(--border)", color: "var(--text-muted)" }}>
              <Pencil size={10} /> Edit
            </button>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, fontSize: 12 }}>
            {[
              { label: "Action", val: rel.disclosed_action_pct },
              { label: "Rakeback", val: rel.disclosed_rakeback_pct },
              { label: "Insurance", val: rel.disclosed_insurance_pct },
            ].map(d => (
              <div key={d.label} style={{ padding: "8px 10px", background: "var(--bg-surface)", borderRadius: 6, border: "1px solid var(--border)" }}>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginBottom: 2 }}>{d.label}</div>
                <div style={{ fontWeight: 600, color: d.val != null ? "var(--text)" : "var(--text-dim)" }}>
                  {d.val != null ? `${d.val}%` : "—"}
                </div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 4 }}>Les taux à « — » utilisent les rates réels des deals.</div>
        </div>

        {/* Payment history */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 8 }}>Historique paiements</div>
          {loadingPayments ? (
            <div style={{ padding: 12, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>Chargement...</div>
          ) : payments.length === 0 ? (
            <div style={{ padding: 12, textAlign: "center", color: "var(--text-dim)", fontSize: 12 }}>Aucun paiement</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 10, textTransform: "uppercase" }}>
                  <th style={{ textAlign: "left", padding: "5px 4px" }}>Date</th>
                  <th style={{ textAlign: "center", padding: "5px 4px" }}>Game</th>
                  <th style={{ textAlign: "right", padding: "5px 4px" }}>Amount</th>
                  <th style={{ textAlign: "left", padding: "5px 4px" }}>TX</th>
                  <th style={{ textAlign: "left", padding: "5px 4px" }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {payments.map(p => (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td style={{ padding: "6px 4px", color: "var(--text-muted)" }}>{p.paid_at?.slice(0, 10)}</td>
                    <td style={{ textAlign: "center", padding: "6px 4px" }}>{p.game_name}</td>
                    <td style={{ textAlign: "right", padding: "6px 4px", fontWeight: 600, color: "#22C55E" }}>{Number(p.amount_usdt).toFixed(2)}</td>
                    <td style={{ padding: "6px 4px", color: "var(--text-dim)", maxWidth: 80, overflow: "hidden", textOverflow: "ellipsis" }}>{p.tx_hash ? p.tx_hash.slice(0, 12) + "..." : "—"}</td>
                    <td style={{ padding: "6px 4px", color: "var(--text-dim)", maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis" }}>{p.notes ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
