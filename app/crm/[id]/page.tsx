export const dynamic = "force-dynamic";
import { getPlayerById, getCrmNotes, getWalletTransactions, getPlayerPnLAllGames, type PlayerGamePnL } from "@/lib/queries";
import { getCnyRate } from "@/lib/currency";
import { getDb } from "@/lib/db";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";

function fmtAmt(n: number, currency = "USDT"): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} ${currency}`;
}

const GAME_COLOR: Record<string, string> = {
  AKPOKER: "#D4AF37", KKPOKER: "#3B82F6", A5POKER: "#8B5CF6", AKS: "#F59E0B", WEPOKER: "#10B981",
};

export default async function CrmPlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const playerId = parseInt(id);
  if (isNaN(playerId)) return <div>Invalid player ID</div>;

  const db = getDb();
  const player = getPlayerById(playerId) as any;
  if (!player) return <div>Player not found</div>;

  // Config-driven P&L across ALL agency games (see AGENCY_GAMES in lib/queries.ts).
  // Totals here are consistent with Top Contributors and the net worth card by construction.
  const pnl = getPlayerPnLAllGames(playerId);

  const notes = getCrmNotes(playerId) as any[];
  const recentTx = getWalletTransactions({ player_id: playerId, limit: 20 }) as any[];
  const cnyRate = getCnyRate();
  const cashoutWallets = db.prepare(`SELECT address, label FROM player_wallet_cashouts WHERE player_id = ?`).all(playerId) as { address: string; label: string | null }[];

  const accent = (label: string) => GAME_COLOR[label] ?? "#9CA3AF";

  return (
    <div>
      <PageHeader title={player.name} subtitle={`${player.telegram_handle ? `@${player.telegram_handle}` : ""} ${player.telegram_id ? `· ID ${player.telegram_id}` : ""} · ${player.status}`} />

      {/* Total agence — toutes games confondues (cohérent avec Top Contributors / net worth) */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Agency cut · toutes games</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, fontSize: 13 }}>
          <div>All-time: <b style={{ color: "#D4AF37" }}>{fmtAmt(pnl.total_agency_usdt_all)}</b></div>
          <div>30j: <b>{fmtAmt(pnl.total_agency_usdt_30d)}</b></div>
          <div>7j: <b>{fmtAmt(pnl.total_agency_usdt_7d)}</b></div>
        </div>
        {cashoutWallets.length > 0 && (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 12 }}>
            Wallet cashout: <code style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 4 }}>{cashoutWallets[0].address.slice(0, 8)}...{cashoutWallets[0].address.slice(-6)}</code>
          </div>
        )}
      </div>

      {/* Une section par game où le joueur a un deal / de l'activité */}
      {pnl.games.map((g: PlayerGamePnL) => (
        <div key={g.game_key} style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: accent(g.label) }}>{g.label}</span>
            {g.archived && <span style={{ fontSize: 10, color: "var(--text-dim)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px" }}>archivé</span>}
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
            {g.deal
              ? <>Deal · <b>{g.deal.action_pct}% action</b>{g.deal.rakeback_pct ? ` / ${g.deal.rakeback_pct}% RB` : ""}{g.deal.insurance_pct ? ` / ${g.deal.insurance_pct}% ins` : ""}{g.deal.start_date ? ` · depuis ${g.deal.start_date}` : ""}</>
              : <i>Aucun deal — activité historique</i>}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>P&L Player</div>
              <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <div>All-time: <b style={{ color: g.player_pnl_all >= 0 ? "var(--green)" : "#EF4444" }}>{fmtAmt(g.player_pnl_all, g.currency)}</b></div>
                <div>30j: <b>{fmtAmt(g.player_pnl_30d, g.currency)}</b></div>
                <div>7j: <b>{fmtAmt(g.player_pnl_7d, g.currency)}</b></div>
              </div>
            </div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Agency cut</div>
              {g.kind === "wepoker" && g.wp ? (
                <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div>Winnings: <b>{fmtAmt(g.wp.agency_winnings_cny, "CNY")}</b></div>
                  <div>Rakeback: <b>{fmtAmt(g.wp.agency_rakeback_cny, "CNY")}</b></div>
                  <div>Insurance: <b>{fmtAmt(g.wp.agency_insurance_cny, "CNY")}</b></div>
                  <div style={{ borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 4 }}>
                    Total: <b style={{ color: "#D4AF37" }}>{fmtAmt(g.wp.agency_cut_cny, "CNY")}</b>
                    <span style={{ fontSize: 11, color: "var(--text-muted)" }}> = {fmtAmt(g.wp.agency_cut_usdt)}</span>
                  </div>
                  <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>* 1 CNY = {cnyRate} USDT</div>
                </div>
              ) : (
                <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                  <div>All-time: <b style={{ color: "#D4AF37" }}>{fmtAmt(g.agency_cut_usdt_all)}</b></div>
                  <div>30j: <b>{fmtAmt(g.agency_cut_usdt_30d)}</b></div>
                  <div>7j: <b>{fmtAmt(g.agency_cut_usdt_7d)}</b></div>
                </div>
              )}
            </div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            {g.kind !== "wepoker" && (
              <Link href={`${g.basePath}/pnl?player=${playerId}`} style={{ fontSize: 12, color: "var(--green)", textDecoration: "none" }}>Voir wallet history →</Link>
            )}
            <Link href={`${g.basePath}/settlements?player=${playerId}`} style={{ fontSize: 12, color: "var(--green)", textDecoration: "none" }}>{g.kind === "wepoker" ? "Voir reports →" : "Voir settlements →"}</Link>
          </div>
        </div>
      ))}

      {pnl.games.length === 0 && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 40, textAlign: "center", color: "var(--text-muted)", marginBottom: 16 }}>
          Aucun deal ni activité pour ce joueur
        </div>
      )}

      {/* Notes */}
      {notes.length > 0 && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>Notes ({notes.length})</div>
          {notes.slice(0, 10).map((n: any) => (
            <div key={n.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{(n.created_at ?? "").slice(0, 16).replace("T", " ")}</span>
              <span style={{ marginLeft: 8, color: "var(--text)" }}>{n.content}</span>
            </div>
          ))}
        </div>
      )}

      {/* Recent Activity */}
      {recentTx.length > 0 && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>Activité récente</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {recentTx.slice(0, 20).map((tx: any) => (
                <tr key={tx.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 8px", color: "var(--text-dim)", fontSize: 11 }}>{(tx.tx_datetime ?? tx.created_at ?? "").slice(0, 10)}</td>
                  <td style={{ padding: "6px 8px" }}>{tx.game_name ?? "?"}</td>
                  <td style={{ padding: "6px 8px", color: tx.type === "withdrawal" ? "var(--green)" : "#EF4444" }}>{tx.type === "deposit" ? "↓ dep" : "↑ wdr"}</td>
                  <td style={{ padding: "6px 8px", textAlign: "right", fontFamily: "monospace" }}>{tx.amount?.toFixed(0)} USDT</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16 }}>
        <Link href="/crm" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}>← Retour au CRM</Link>
      </div>
    </div>
  );
}
