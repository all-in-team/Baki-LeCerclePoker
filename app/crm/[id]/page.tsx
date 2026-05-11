export const dynamic = "force-dynamic";
import { getPlayerById, getAkpokerPnL, getWepokerPnL, getPlayerDealsForGame, getCrmNotes, getWalletTransactions } from "@/lib/queries";
import { getCnyRate } from "@/lib/currency";
import { getDb } from "@/lib/db";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtAmt(n: number, currency = "USDT"): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} ${currency}`;
}

export default async function CrmPlayerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const playerId = parseInt(id);
  if (isNaN(playerId)) return <div>Invalid player ID</div>;

  const db = getDb();
  const player = getPlayerById(playerId) as any;
  if (!player) return <div>Player not found</div>;

  const today = new Date().toISOString().slice(0, 10);
  const d7 = daysAgo(7);
  const d30 = daysAgo(30);

  const akDeal = getPlayerDealsForGame(playerId, "TELE") as any;
  const wpDeal = getPlayerDealsForGame(playerId, "Wepoker") as any;

  const akAll = getAkpokerPnL(playerId);
  const ak30 = getAkpokerPnL(playerId, { from: d30, to: today });
  const ak7 = getAkpokerPnL(playerId, { from: d7, to: today });

  const wpAll = getWepokerPnL(playerId);
  const wp30 = getWepokerPnL(playerId, { from: d30, to: today });
  const wp7 = getWepokerPnL(playerId, { from: d7, to: today });

  const notes = getCrmNotes(playerId) as any[];

  const recentTx = getWalletTransactions({ player_id: playerId, limit: 20 }) as any[];

  const cnyRate = getCnyRate();

  const cashoutWallets = db.prepare(`SELECT address, label FROM player_wallet_cashouts WHERE player_id = ?`).all(playerId) as { address: string; label: string | null }[];

  return (
    <div>
      <PageHeader title={player.name} subtitle={`${player.telegram_handle ? `@${player.telegram_handle}` : ""} ${player.telegram_id ? `· ID ${player.telegram_id}` : ""} · ${player.status}`} />

      {/* AKPOKER Section */}
      {akDeal && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: "#D4AF37" }}>AKPOKER</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
            Deal · <b>{akDeal.action_pct}% action</b>{akDeal.rakeback_pct ? ` / ${akDeal.rakeback_pct}% RB` : ""}{akDeal.start_date ? ` · depuis ${akDeal.start_date}` : ""}
          </div>

          {cashoutWallets.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 16 }}>
              Wallet cashout: <code style={{ background: "var(--bg)", padding: "2px 6px", borderRadius: 4 }}>{cashoutWallets[0].address.slice(0, 8)}...{cashoutWallets[0].address.slice(-6)}</code>
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>P&L Player</div>
              <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <div>All-time: <b style={{ color: (akAll[0]?.net_usdt ?? 0) >= 0 ? "var(--green)" : "#EF4444" }}>{fmtAmt(akAll[0]?.net_usdt ?? 0)}</b></div>
                <div>30j: <b>{fmtAmt(ak30[0]?.net_usdt ?? 0)}</b></div>
                <div>7j: <b>{fmtAmt(ak7[0]?.net_usdt ?? 0)}</b></div>
              </div>
            </div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Agency cut</div>
              <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <div>All-time: <b style={{ color: "#D4AF37" }}>{fmtAmt(akAll[0]?.agency_cut_usdt ?? 0)}</b></div>
                <div>30j: <b>{fmtAmt(ak30[0]?.agency_cut_usdt ?? 0)}</b></div>
                <div>7j: <b>{fmtAmt(ak7[0]?.agency_cut_usdt ?? 0)}</b></div>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
            <Link href={`/akpoker/pnl?player=${playerId}`} style={{ fontSize: 12, color: "var(--green)", textDecoration: "none" }}>Voir wallet history →</Link>
            <Link href={`/akpoker/settlements?player=${playerId}`} style={{ fontSize: 12, color: "var(--green)", textDecoration: "none" }}>Voir settlements →</Link>
          </div>
        </div>
      )}

      {/* WEPOKER Section */}
      {wpDeal && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: "#10B981" }}>WEPOKER</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 16 }}>
            Deal · <b>{wpDeal.action_pct}% action</b>{wpDeal.rakeback_pct ? ` / ${wpDeal.rakeback_pct}% RB` : ""}{wpDeal.insurance_pct ? ` / ${wpDeal.insurance_pct}% ins` : ""}{wpDeal.start_date ? ` · depuis ${wpDeal.start_date}` : ""}
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>P&L Player</div>
              <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <div>All-time: <b style={{ color: (wpAll[0]?.player_pnl_cny ?? 0) >= 0 ? "var(--green)" : "#EF4444" }}>{fmtAmt(wpAll[0]?.player_pnl_cny ?? 0, "CNY")}</b></div>
                <div>30j: <b>{fmtAmt(wp30[0]?.player_pnl_cny ?? 0, "CNY")}</b></div>
                <div>7j: <b>{fmtAmt(wp7[0]?.player_pnl_cny ?? 0, "CNY")}</b></div>
              </div>
            </div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Agency cut</div>
              <div style={{ fontSize: 13, display: "flex", flexDirection: "column", gap: 4 }}>
                <div>Winnings: <b>{fmtAmt(wpAll[0]?.agency_winnings_split_cny ?? 0, "CNY")}</b></div>
                <div>Rakeback: <b>{fmtAmt(wpAll[0]?.agency_rakeback_split_cny ?? 0, "CNY")}</b></div>
                <div>Insurance: <b>{fmtAmt(wpAll[0]?.agency_insurance_split_cny ?? 0, "CNY")}</b></div>
                <div style={{ borderTop: "1px solid var(--border)", paddingTop: 4, marginTop: 4 }}>
                  Total: <b style={{ color: "#D4AF37" }}>{fmtAmt(wpAll[0]?.total_agency_cny ?? 0, "CNY")}</b>
                  <span style={{ fontSize: 11, color: "var(--text-muted)" }}> = {fmtAmt(wpAll[0]?.total_agency_usdt ?? 0)}</span>
                </div>
              </div>
              <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 6 }}>* 1 CNY = {cnyRate} USDT</div>
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <Link href={`/wepoker/settlements?player=${playerId}`} style={{ fontSize: 12, color: "var(--green)", textDecoration: "none" }}>Voir reports →</Link>
          </div>
        </div>
      )}

      {!akDeal && !wpDeal && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 40, textAlign: "center", color: "var(--text-muted)", marginBottom: 16 }}>
          Aucun deal configuré pour ce joueur
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
