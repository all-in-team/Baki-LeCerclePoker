"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface SettlementRow {
  id: number;
  week_start: string;
  player_id: number;
  player_name: string;
  status: string;
  pnl_player: number | null;
  pnl_operator: number | null;
  action_pct_snapshot: number | null;
  lock_anchor_tx_id: number | null;
  lock_anchor_datetime: string | null;
  locked_at: string | null;
  locked_by: string | null;
  manual_close_amount: number | null;
  note: string | null;
}

interface Period {
  id: number;
  week_start: string;
  week_end: string;
  status: string;
  computed_at: string | null;
  locked_at: string | null;
}

interface Props {
  weekStart: string;
  weekEnd: string;
  period: Period | null;
  rows: SettlementRow[];
  rangeLabel: string;
  weeks: { isoWeek: string; label: string }[];
}

export default function SettlementsClient({ weekStart, weekEnd, period, rows, rangeLabel, weeks }: Props) {
  const router = useRouter();
  const [loading, setLoading] = useState<string | null>(null);
  const [manualAmounts, setManualAmounts] = useState<Record<number, string>>({});

  const isLocked = period?.status === "locked";

  const autoSettled = rows.filter(r => r.status === "auto_settled");
  const settled = rows.filter(r => r.status === "settled");
  const pendingManual = rows.filter(r => r.status === "pending_manual");
  const carryOver = rows.filter(r => r.status === "carry_over");
  const conflict = rows.filter(r => r.status === "conflict");

  async function apiCall(url: string, body: object) {
    setLoading(url);
    try {
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) alert(data.error || "Error");
      router.refresh();
    } finally {
      setLoading(null);
    }
  }

  function fmt(n: number | null) {
    if (n === null) return "—";
    return n >= 0 ? `+${n.toFixed(2)}` : n.toFixed(2);
  }

  function fmtDate(iso: string | null) {
    if (!iso) return "—";
    return iso.replace("T", " ").replace("Z", "").slice(0, 16);
  }

  return (
    <div style={{ padding: "0 28px 40px" }}>
      {/* Week selector */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <select
          value={weekStart}
          onChange={e => router.push(`/settlements?week=${e.target.value}`)}
          style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-raised)", color: "var(--text)", fontSize: 13 }}
        >
          {weeks.map(w => {
            const wkStart = w.isoWeek;
            return <option key={wkStart} value={wkStart}>{w.label}</option>;
          })}
        </select>
        <span style={{ fontSize: 14, color: "var(--text-muted)" }}>{rangeLabel}</span>

        {isLocked && (
          <span style={{ marginLeft: "auto", background: "rgba(34,197,94,0.15)", color: "var(--green)", padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            Locked {period?.locked_at ? `on ${fmtDate(period.locked_at)}` : ""}
          </span>
        )}

        {!isLocked && period && (
          <button
            onClick={() => { if (confirm("Lock this week? No further changes possible.")) apiCall("/api/settlements/lock", { week_start: weekStart }); }}
            disabled={loading !== null || pendingManual.length > 0 || autoSettled.length > 0}
            style={{ marginLeft: "auto", padding: "8px 16px", borderRadius: 6, border: "none", background: (pendingManual.length > 0 || autoSettled.length > 0) ? "var(--bg-raised)" : "var(--green)", color: (pendingManual.length > 0 || autoSettled.length > 0) ? "var(--text-dim)" : "#000", fontWeight: 600, fontSize: 13, cursor: (pendingManual.length > 0 || autoSettled.length > 0) ? "not-allowed" : "pointer" }}
          >
            Lock week
          </button>
        )}

        {!period && (
          <button
            onClick={() => apiCall("/api/settlements/run", { week_offset: -1 })}
            style={{ marginLeft: "auto", padding: "8px 16px", borderRadius: 6, border: "none", background: "var(--gold)", color: "#000", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
          >
            Compute week
          </button>
        )}
      </div>

      {rows.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
          No settlement data for this week. Click "Compute week" to run the engine.
        </div>
      )}

      {/* Auto-settled section */}
      {autoSettled.length > 0 && (
        <Section title={`Auto-settled (${autoSettled.length})`} color="var(--green)" emoji="🟢">
          {!isLocked && (
            <button onClick={() => apiCall("/api/settlements/confirm-all", { week_start: weekStart })} disabled={loading !== null}
              style={{ padding: "6px 12px", borderRadius: 5, border: "none", background: "var(--green)", color: "#000", fontWeight: 600, fontSize: 12, cursor: "pointer", marginBottom: 12 }}>
              Confirm all
            </button>
          )}
          <Table rows={autoSettled} fmt={fmt} fmtDate={fmtDate} isLocked={isLocked}
            onAction={(pid, action) => apiCall("/api/settlements/validate", { player_id: pid, week_start: weekStart, action })} />
        </Section>
      )}

      {/* Already confirmed */}
      {settled.length > 0 && (
        <Section title={`Settled (${settled.length})`} color="var(--green)" emoji="✅">
          <Table rows={settled} fmt={fmt} fmtDate={fmtDate} isLocked={true} />
        </Section>
      )}

      {/* Pending manual */}
      {pendingManual.length > 0 && (
        <Section title={`Pending — no cashout (${pendingManual.length})`} color="var(--gold)" emoji="🟡">
          {pendingManual.map(row => (
            <div key={row.player_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontWeight: 600, minWidth: 100 }}>{row.player_name}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Dep: {fmt(row.pnl_player !== null ? -(row.pnl_player) : null)} net</span>
              {!isLocked && (
                <>
                  <button onClick={() => apiCall("/api/settlements/validate", { player_id: row.player_id, week_start: weekStart, action: "carry_over" })}
                    style={{ padding: "5px 10px", borderRadius: 5, border: "1px solid var(--border)", background: "transparent", color: "var(--text)", fontSize: 12, cursor: "pointer" }}>
                    Carry over
                  </button>
                  <input
                    type="number" placeholder="Amount USDT"
                    value={manualAmounts[row.player_id] || ""}
                    onChange={e => setManualAmounts(prev => ({ ...prev, [row.player_id]: e.target.value }))}
                    style={{ width: 100, padding: "5px 8px", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg-raised)", color: "var(--text)", fontSize: 12 }}
                  />
                  <button onClick={() => apiCall("/api/settlements/validate", { player_id: row.player_id, week_start: weekStart, action: "manual_close", payload: { amount: parseFloat(manualAmounts[row.player_id] || "0") } })}
                    style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: "var(--gold)", color: "#000", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                    Save
                  </button>
                </>
              )}
            </div>
          ))}
        </Section>
      )}

      {/* Carry over */}
      {carryOver.length > 0 && (
        <Section title={`Carry-over (${carryOver.length})`} color="var(--text-muted)" emoji="⏭️">
          <Table rows={carryOver} fmt={fmt} fmtDate={fmtDate} isLocked={true} />
        </Section>
      )}

      {/* Conflict */}
      {conflict.length > 0 && (
        <Section title={`Conflict (${conflict.length})`} color="#ef4444" emoji="🔴">
          <Table rows={conflict} fmt={fmt} fmtDate={fmtDate} isLocked={isLocked} />
        </Section>
      )}
    </div>
  );
}

function Section({ title, color, emoji, children }: { title: string; color: string; emoji: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28, background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "16px 20px" }}>
      <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600, color }}>{emoji} {title}</h3>
      {children}
    </div>
  );
}

function Table({ rows, fmt, fmtDate, isLocked, onAction }: {
  rows: SettlementRow[];
  fmt: (n: number | null) => string;
  fmtDate: (s: string | null) => string;
  isLocked: boolean;
  onAction?: (playerId: number, action: string) => void;
}) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <thead>
        <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
          <th style={{ textAlign: "left", padding: "6px 8px" }}>Player</th>
          <th style={{ textAlign: "right", padding: "6px 8px" }}>Wallet PnL</th>
          <th style={{ textAlign: "right", padding: "6px 8px" }}>Action %</th>
          <th style={{ textAlign: "right", padding: "6px 8px" }}>Op. PnL</th>
          <th style={{ textAlign: "left", padding: "6px 8px" }}>Anchor</th>
          {!isLocked && onAction && <th style={{ padding: "6px 8px" }}></th>}
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.player_id} style={{ borderBottom: "1px solid var(--border)" }}>
            <td style={{ padding: "8px", fontWeight: 500 }}>{row.player_name}</td>
            <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_player ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>{fmt(row.pnl_player)} USDT</td>
            <td style={{ padding: "8px", textAlign: "right" }}>{row.action_pct_snapshot}%</td>
            <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_operator ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>{fmt(row.pnl_operator)} USDT</td>
            <td style={{ padding: "8px", fontSize: 11, color: "var(--text-muted)" }}>{fmtDate(row.lock_anchor_datetime)}</td>
            {!isLocked && onAction && (
              <td style={{ padding: "8px" }}>
                <button onClick={() => onAction(row.player_id, "confirm")}
                  style={{ padding: "4px 8px", borderRadius: 4, border: "none", background: "var(--green)", color: "#000", fontSize: 11, fontWeight: 600, cursor: "pointer" }}>
                  Confirm
                </button>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
