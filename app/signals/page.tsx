import { getSignals } from "@/lib/queries";
import PageHeader from "@/components/PageHeader";
import { AlertTriangle, CheckCircle, TrendingUp, Clock, Users, Zap } from "lucide-react";

export const dynamic = "force-dynamic";

function fmt(n: number) { return `€${Math.abs(n).toFixed(2)}`; }

export default function SignalsPage() {
  const { pendingReports, inactivePlayers, unsettledLedger, topPlayers } = getSignals();

  const signals: { type: "warn" | "ok" | "info"; icon: React.ReactNode; title: string; body: string }[] = [];

  if (pendingReports.length > 0) {
    for (const r of pendingReports as { name: string; last_report: string | null }[]) {
      signals.push({
        type: "warn",
        icon: <Clock size={16} />,
        title: `${r.name} — Report overdue`,
        body: r.last_report ? `Last report: ${r.last_report}` : "No report imported yet",
      });
    }
  }

  if (inactivePlayers.length > 0) {
    for (const p of inactivePlayers as { name: string; last_activity: string | null }[]) {
      signals.push({
        type: "warn",
        icon: <Users size={16} />,
        title: `${p.name} — No activity for 45+ days`,
        body: p.last_activity ? `Last seen: ${p.last_activity}` : "Never had an accounting entry",
      });
    }
  }

  if (unsettledLedger && Math.abs(unsettledLedger.balance) > 1) {
    signals.push({
      type: unsettledLedger.balance > 0 ? "info" : "warn",
      icon: <TrendingUp size={16} />,
      title: `Ledger balance: ${unsettledLedger.balance > 0 ? "+" : ""}${fmt(unsettledLedger.balance)} (last 30 days)`,
      body: unsettledLedger.balance > 0 ? "You are net positive this month." : "You have outstanding outflows this month.",
    });
  }

  if (topPlayers.length > 0) {
    const players = (topPlayers as { name: string; net: number }[]).map(p => `${p.name} (€${p.net.toFixed(0)})`).join(", ");
    signals.push({
      type: "ok",
      icon: <Zap size={16} />,
      title: "Top performers this month",
      body: players,
    });
  }

  if (signals.length === 0) {
    signals.push({
      type: "ok",
      icon: <CheckCircle size={16} />,
      title: "All clear",
      body: "No issues detected. Import more reports or add players to see insights.",
    });
  }

  const COLORS = {
    warn: { bg: "rgba(251,191,36,0.08)", border: "rgba(251,191,36,0.25)", icon: "#fbbf24", text: "#fbbf24" },
    ok: { bg: "rgba(34,197,94,0.08)", border: "rgba(34,197,94,0.2)", icon: "var(--green)", text: "var(--green)" },
    info: { bg: "rgba(96,165,250,0.08)", border: "rgba(96,165,250,0.2)", icon: "#60a5fa", text: "#60a5fa" },
  };

  const warnCount = signals.filter(s => s.type === "warn").length;

  return (
    <div>
      <PageHeader
        title="Weekly Signal"
        subtitle={`${warnCount} item${warnCount !== 1 ? "s" : ""} need your attention`}
      />

      <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 720 }}>
        {signals.map((s, i) => {
          const c = COLORS[s.type];
          return (
            <div key={i} style={{
              background: c.bg,
              border: `1px solid ${c.border}`,
              borderRadius: 10,
              padding: "14px 18px",
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
            }}>
              <span style={{ color: c.icon, marginTop: 1, flexShrink: 0 }}>{s.icon}</span>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--text)", marginBottom: 3 }}>{s.title}</div>
                <div style={{ fontSize: 13, color: "var(--text-muted)" }}>{s.body}</div>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ marginTop: 32, fontSize: 12, color: "var(--text-dim)" }}>
        Signals computed on page load — refresh for latest data.
      </div>
    </div>
  );
}
