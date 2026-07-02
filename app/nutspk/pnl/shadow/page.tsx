export const dynamic = "force-dynamic";
import { ExternalLink } from "lucide-react";
import LedgerShell from "@/components/ledger/LedgerShell";
import { loadNutspkLedger, type NutspkLedgerRow } from "@/lib/games/nutspk/ledger";
import { fmtSignedAmount } from "@/components/ledger/format";
import type { WalletMere } from "@/lib/queries";

/**
 * SHADOW route — LedgerShell pilot validation for NUTSPK.
 *
 * Renders the generic shell with live NUTSPK data for side-by-side comparison
 * against the real page (/nutspk/pnl, TELEClient), which stays untouched.
 * Read-only: no mutations, no sync buttons, not linked from the sidebar.
 * Gets deleted when NUTSPK migrates onto the shell for real.
 */

const TRONSCAN = "https://tronscan.org/#/address/";

function WalletMeresBanner({ walletMeres }: { walletMeres: WalletMere[] }) {
  if (walletMeres.length === 0) return null;
  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "12px 20px", marginBottom: 20, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: "#4ade80", textTransform: "uppercase", letterSpacing: "0.08em" }}>
        WALLET{walletMeres.length > 1 ? "S" : ""} MÈRE{walletMeres.length > 1 ? "S" : ""}
      </div>
      {walletMeres.map(wm => (
        <a key={wm.id} href={TRONSCAN + wm.address} target="_blank" rel="noreferrer"
          style={{ display: "inline-flex", alignItems: "center", gap: 6, textDecoration: "none", padding: "4px 10px", background: "rgba(74,222,128,0.08)", borderRadius: 6, border: "1px solid rgba(74,222,128,0.2)" }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", color: "#4ade80", fontWeight: 600 }}>
            {wm.label ? `${wm.label}: ` : ""}{wm.address.slice(0, 6)}…{wm.address.slice(-6)}
          </span>
          <ExternalLink size={10} color="#4ade80" />
        </a>
      ))}
    </div>
  );
}

function ShadowTable({ rows }: { rows: NutspkLedgerRow[] }) {
  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, marginBottom: 28 }}>
      <div style={{ padding: "14px 20px", borderBottom: "1px solid var(--border)" }}>
        <span style={{ fontSize: 13, fontWeight: 700, color: "var(--text)" }}>Joueurs NUTSPK</span>
        <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 10 }}>lecture seule (shadow)</span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Joueur", "Net P&L", "Agency P&L", "Action %", "RB %", "Début"].map((h, i) => (
                <th key={i} style={{ padding: "10px 16px", textAlign: "left", fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={6} style={{ padding: 32, textAlign: "center", color: "var(--text-dim)", fontSize: 13 }}>
                Aucun joueur NUTSPK — ajoute un deal à un joueur depuis son profil
              </td></tr>
            ) : rows.map(row => {
              const netC = row.net > 0 ? "var(--green)" : row.net < 0 ? "#f87171" : "rgba(255,255,255,0.15)";
              const myC = row.my_pnl > 0 ? "var(--green)" : row.my_pnl < 0 ? "#f87171" : "rgba(255,255,255,0.15)";
              return (
                <tr key={row.player_id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "var(--text)" }}>{row.player_name}</td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: netC }}>{row.net === 0 ? "—" : fmtSignedAmount(row.net)}</td>
                  <td style={{ padding: "12px 16px", fontSize: 14, fontWeight: 700, color: myC }}>{row.my_pnl === 0 ? "—" : fmtSignedAmount(row.my_pnl)}</td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "var(--gold)" }}>{row.action_pct}%</td>
                  <td style={{ padding: "12px 16px", fontSize: 13, fontWeight: 600, color: "#38bdf8" }}>{row.rakeback_pct}%</td>
                  <td style={{ padding: "12px 16px", fontSize: 12, fontWeight: 600, color: row.start_date ? "var(--text)" : "var(--text-dim)" }}>{row.start_date ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default async function NutspkShadowPage({ searchParams }: { searchParams: Promise<{ filter?: string; player?: string }> }) {
  const params = await searchParams;
  const data = loadNutspkLedger(params, "/nutspk/pnl/shadow");

  return (
    <>
      <div style={{ margin: "16px 28px 0", padding: "10px 16px", borderRadius: 8, background: "rgba(168,85,247,0.10)", border: "1px solid rgba(168,85,247,0.35)", fontSize: 12, color: "#c084fc", fontWeight: 600 }}>
        SHADOW — pilote LedgerShell (lecture seule). Compare avec la vraie page :{" "}
        <a href={`/nutspk/pnl${params.filter ? `?filter=${encodeURIComponent(params.filter)}` : ""}`} style={{ color: "#c084fc" }}>/nutspk/pnl</a>
      </div>
      <LedgerShell
        config={{ ...data.config, title: "NUTSPK — P&L (shadow)" }}
        kpiCards={data.kpiCards}
        period={data.period}
        chart={data.chart}
        headerAction={data.filterPlayerName ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            <span style={{ background: "rgba(212,175,55,0.15)", color: "#D4AF37", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
              Filtré : {data.filterPlayerName}
            </span>
            <a href="/nutspk/pnl/shadow" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
          </span>
        ) : undefined}
        walletMeresBanner={<WalletMeresBanner walletMeres={data.walletMeres} />}
      >
        {/* No AgencyExtras here: that widget carries live POST/PATCH/DELETE
            actions on the same agency_extras rows as the real page — the
            shadow route must expose zero write path. Its net is still folded
            into "Mon Total P&L" via getLockAwareKPIsWithExtras. */}
        <ShadowTable rows={data.summaryByPlayer} />
      </LedgerShell>
    </>
  );
}
