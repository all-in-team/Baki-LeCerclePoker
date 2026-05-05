"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { runSettlement } from "./actions";

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
  const [isPending, startTransition] = useTransition();
  const [manualAmounts, setManualAmounts] = useState<Record<number, string>>({});

  const isLocked = period?.status === "locked";

  const settled = rows.filter(r => r.status === "settled" || r.status === "carry_over");
  const pendingManual = rows.filter(r => r.status === "pending_manual");
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

  async function handleCompute() {
    setLoading("compute");
    try {
      await runSettlement(weekStart);
      startTransition(() => router.refresh());
    } catch (e: any) {
      alert(e.message || "Error computing week");
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
      {/* Week selector + status */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <select
          value={weekStart}
          onChange={e => router.push(`/settlements?week=${e.target.value}`)}
          style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg-raised)", color: "var(--text)", fontSize: 13 }}
        >
          {weeks.map(w => (
            <option key={w.isoWeek} value={w.isoWeek}>{w.label}</option>
          ))}
        </select>
        <span style={{ fontSize: 14, color: "var(--text-muted)" }}>{rangeLabel}</span>

        {isLocked && (
          <span style={{ marginLeft: "auto", background: "rgba(34,197,94,0.15)", color: "var(--green)", padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            {"🔒"} Période lockée {period?.locked_at ? `le ${fmtDate(period.locked_at)}` : ""}
          </span>
        )}

        {!isLocked && period && pendingManual.length > 0 && (
          <span style={{ marginLeft: "auto", background: "rgba(234,179,8,0.15)", color: "var(--gold)", padding: "6px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            {"🟡"} {pendingManual.length} joueur(s) en attente de validation
          </span>
        )}

        {!period && (
          <button
            onClick={handleCompute}
            disabled={loading !== null || isPending}
            style={{ marginLeft: "auto", padding: "8px 16px", borderRadius: 6, border: "none", background: "var(--gold)", color: "#000", fontWeight: 600, fontSize: 13, cursor: loading ? "wait" : "pointer" }}
          >
            {loading === "compute" ? "Computing..." : "Compute week"}
          </button>
        )}
      </div>

      {rows.length === 0 && !loading && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text-muted)" }}>
          No settlement data for this week. Click &quot;Compute week&quot; to run the engine.
        </div>
      )}

      {/* Settled section (auto-locked + manually resolved) */}
      {settled.length > 0 && (
        <Section title={`Settled (${settled.length})`} color="var(--green)" emoji="✅">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Player</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Wallet PnL</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Action %</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>Op. PnL</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Lock anchor</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Locked</th>
              </tr>
            </thead>
            <tbody>
              {settled.map(row => (
                <tr key={row.player_id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px", fontWeight: 500 }}>
                    {row.status === "carry_over" ? "⏭️ " : "🟢 "}{row.player_name}
                  </td>
                  <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_player ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>{fmt(row.pnl_player)} USDT</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{row.action_pct_snapshot}%</td>
                  <td style={{ padding: "8px", textAlign: "right", color: (row.pnl_operator ?? 0) >= 0 ? "var(--green)" : "#ef4444" }}>{fmt(row.pnl_operator)} USDT</td>
                  <td style={{ padding: "8px", fontSize: 11, color: "var(--text-muted)" }}>{fmtDate(row.lock_anchor_datetime)}</td>
                  <td style={{ padding: "8px", fontSize: 11, color: "var(--text-muted)" }}>{row.locked_by === "auto" ? "Auto" : row.locked_by ?? "—"} {fmtDate(row.locked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      )}

      {/* Pending manual */}
      {pendingManual.length > 0 && (
        <Section title={`Pending — no cashout (${pendingManual.length})`} color="var(--gold)" emoji="🟡">
          {pendingManual.map(row => (
            <div key={row.player_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid var(--border)" }}>
              <span style={{ fontWeight: 600, minWidth: 100 }}>{row.player_name}</span>
              <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Dep: {fmt(row.pnl_player !== null ? -(row.pnl_player) : null)} net</span>
              <button onClick={() => apiCall("/api/settlements/validate", { player_id: row.player_id, week_start: weekStart, action: "carry_over" })}
                disabled={loading !== null}
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
                disabled={loading !== null}
                style={{ padding: "5px 10px", borderRadius: 5, border: "none", background: "var(--gold)", color: "#000", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
                Save
              </button>
            </div>
          ))}
        </Section>
      )}

      {/* Conflict */}
      {conflict.length > 0 && (
        <Section title={`Conflict (${conflict.length})`} color="#ef4444" emoji="🔴">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11 }}>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Player</th>
                <th style={{ textAlign: "right", padding: "6px 8px" }}>PnL</th>
                <th style={{ textAlign: "left", padding: "6px 8px" }}>Note</th>
              </tr>
            </thead>
            <tbody>
              {conflict.map(row => (
                <tr key={row.player_id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "8px" }}>{row.player_name}</td>
                  <td style={{ padding: "8px", textAlign: "right" }}>{fmt(row.pnl_player)}</td>
                  <td style={{ padding: "8px", fontSize: 11, color: "var(--text-muted)" }}>{row.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
