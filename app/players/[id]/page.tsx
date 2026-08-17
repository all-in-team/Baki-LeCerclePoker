export const dynamic = "force-dynamic";
import { notFound } from "next/navigation";
import {
  getPlayerById, getCrmNotes, getWalletTransactions, getPlayerPnLAllGames, getPlayerAgencyCutSeries,
  getGrinderProfitability, getPlayerGameDeals, getGames, getPlayerWalletStats, getQuarantinedTransactions, getPlayerTransactionHistory, type PlayerGamePnL,
} from "@/lib/queries";
import { getPlayerAffiliation } from "@/lib/queries/affiliate";
import { getCnyRate } from "@/lib/currency";
import { getDb } from "@/lib/db";
import Link from "next/link";
import PageHeader from "@/components/PageHeader";
import NetPnlChart from "@/app/akpoker/pnl/NetPnlChart";
import PlayerDetailClient from "./PlayerDetailClient";
import PlayerDangerZone from "./PlayerDangerZone";
import QuarantinePanel from "@/components/QuarantinePanel";
import PlayerHistoryPanel from "@/components/PlayerHistoryPanel";

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtAmt(n: number, currency = "USDT"): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} ${currency}`;
}

const GAME_COLOR: Record<string, string> = {
  AKPOKER: "#D4AF37", KKPOKER: "#3B82F6", A5POKER: "#8B5CF6", AKS: "#F59E0B", NUTSPK: "#14B8A6", WEPOKER: "#10B981",
};

// Fiche joueur unique — fusion de l'ancienne fiche CRM (/crm/[id] : P&L toutes games, courbe,
// affiliation, grindhouse, notes) et de l'ancienne fiche ops (/players/[id] : deals éditables,
// IDs externes, flux wallet, transactions). /crm/[id] redirige ici.
export default async function PlayerDetailPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ range?: string }> }) {
  const { id } = await params;
  const { range: rangeParam } = await searchParams;
  const playerId = parseInt(id);
  if (isNaN(playerId)) notFound();

  const db = getDb();
  const player = getPlayerById(playerId) as any;
  if (!player) notFound();

  // Config-driven P&L across ALL agency games (see AGENCY_GAMES in lib/queries.ts).
  // Totals here are consistent with Top Contributors and the net worth card by construction.
  const pnl = getPlayerPnLAllGames(playerId);

  // Grindhouse — minimal section, shown only if this player is a grinder. Lifetime figures,
  // same per-grinder math as the /grindhouse/dashboard breakdown row.
  const grind = getGrinderProfitability(playerId);

  // Affiliation — simple eligibility line, shown only if the player is affiliated under an agent.
  const affiliation = getPlayerAffiliation(playerId);

  // Agency-cut evolution chart — period filter via ?range= (7d / 30d / lifetime, default lifetime).
  const range = rangeParam === "7d" || rangeParam === "30d" ? rangeParam : "lifetime";
  const today = new Date().toISOString().slice(0, 10);
  const seriesPeriod = range === "7d" ? { from: daysAgo(7), to: today } : range === "30d" ? { from: daysAgo(30), to: today } : undefined;
  const agencySeries = getPlayerAgencyCutSeries(playerId, seriesPeriod);
  const agencyCardNet = range === "7d" ? pnl.total_agency_usdt_7d : range === "30d" ? pnl.total_agency_usdt_30d : pnl.total_agency_usdt_all;
  const rangeLabel = range === "7d" ? "7 derniers jours" : range === "30d" ? "30 derniers jours" : "Lifetime";
  const RANGES: { key: string; label: string }[] = [
    { key: "7d", label: "7j" }, { key: "30d", label: "30j" }, { key: "lifetime", label: "Lifetime" },
  ];

  const notes = getCrmNotes(playerId) as any[];
  const cnyRate = getCnyRate();
  const cashoutWallets = db.prepare(`SELECT address, label FROM player_wallet_cashouts WHERE player_id = ?`).all(playerId) as { address: string; label: string | null }[];

  // Bloc identité : ce que la liste n'affiche plus en colonne depuis la fusion /crm + /players.
  const appStats = db.prepare(`
    SELECT COUNT(*) AS app_count, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) AS active_apps
    FROM player_app_assignments WHERE player_id = ?
  `).get(playerId) as { app_count: number; active_apps: number | null };
  const lastNote = notes[0] as { content: string; created_at: string } | undefined;

  // Partie ops (ex-/players/[id]) : deals éditables, IDs externes par game, flux wallet, transactions.
  const transactions = getWalletTransactions({ player_id: playerId, limit: 500 }) as any[];
  const gameDeals = getPlayerGameDeals(playerId) as any[];
  const allGames = getGames();
  const stats = getPlayerWalletStats(playerId) ?? { deposited: 0, withdrawn: 0, net: 0, my_pnl: 0 };
  const gameIds = db.prepare(`
    SELECT pgi.id, pgi.game_id, g.name AS game_name, pgi.external_id
    FROM player_game_ids pgi
    JOIN games g ON g.id = pgi.game_id
    WHERE pgi.player_id = ?
    ORDER BY g.name, pgi.external_id
  `).all(playerId) as { id: number; game_id: number; game_name: string; external_id: string }[];

  // Mouvements mis de côté par le sync — hors de tout solde tant qu'ils ne sont
  // pas arbitrés. Affichés en tête de fiche : c'est là qu'on regarde un solde.
  const quarantined = getQuarantinedTransactions(playerId);

  // Historique complet — toutes les lignes du joueur, réglées comprises, sans
  // borne de deal. `stats.net` (borné aux deals, cf. getPlayerWalletStats) est
  // passé pour que le panneau puisse expliquer l'écart au lieu de le subir.
  const history = getPlayerTransactionHistory(playerId);

  const accent = (label: string) => GAME_COLOR[label] ?? "#9CA3AF";

  return (
    <div>
      <PageHeader title={player.name} subtitle={`${player.telegram_handle ? `@${player.telegram_handle}` : ""} ${player.telegram_id ? `· ID ${player.telegram_id}` : ""} · ${player.status}`} />

      <QuarantinePanel transactions={quarantined} />

      {/* Affiliation — éligibilité du deal affilié (texte simple), seulement si affilié */}
      {affiliation.affiliated && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8, marginBottom: 16,
          background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 10, padding: "10px 14px", fontSize: 13,
        }}>
          <span>{affiliation.is_open ? "🟢" : "⚪"}</span>
          <span style={{ color: "var(--text)" }}>
            Affilié sous <b>{affiliation.agent?.name ?? "—"}</b>
            {affiliation.agent?.telegram_handle && <span style={{ color: "var(--text-dim)" }}> @{affiliation.agent.telegram_handle}</span>}
            {" · "}
            {affiliation.is_open
              ? <span style={{ color: "#22C55E" }}>deal éligible jusqu&apos;au {affiliation.expires_on}</span>
              : <span style={{ color: "var(--text-dim)" }}>éligibilité expirée le {affiliation.expires_on}</span>}
          </span>
        </div>
      )}

      {/* Identité — repris de la liste après la fusion /crm + /players */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 12 }}>Identité</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "10px 20px", fontSize: 13 }}>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Tier</div>
            <div style={{ color: "var(--text)", fontWeight: 600 }}>{player.tier ?? "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Apps</div>
            <div style={{ color: "var(--text)", fontWeight: 600 }}>
              <span style={{ color: (appStats?.active_apps ?? 0) > 0 ? "var(--green)" : "var(--text-dim)" }}>{appStats?.active_apps ?? 0} active</span>
              <span style={{ color: "var(--text-dim)", fontWeight: 400 }}> / {appStats?.app_count ?? 0}</span>
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Inscrit le</div>
            <div style={{ color: "var(--text)", fontWeight: 600 }}>{player.created_at ? String(player.created_at).slice(0, 10) : "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Source</div>
            <div style={{ color: "var(--text)", fontWeight: 600 }}>{player.joined_via ?? "— (avant tracking)"}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Telegram</div>
            <div style={{ color: "var(--text)" }}>
              {player.telegram_handle ? `@${String(player.telegram_handle).replace(/^@/, "")}` : "—"}
              {player.telegram_phone ? ` · ${player.telegram_phone}` : ""}
              {player.telegram_id ? <span style={{ color: "var(--text-dim)", fontFamily: "monospace", fontSize: 11 }}> · ID {player.telegram_id}</span> : null}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Dernière note</div>
            <div style={{ color: "var(--text)" }}>
              {lastNote
                ? <>{(lastNote.created_at ?? "").slice(0, 10)} — <span style={{ color: "var(--text-muted)" }}>{lastNote.content.length > 60 ? lastNote.content.slice(0, 60) + "…" : lastNote.content}</span></>
                : "—"}
            </div>
          </div>
        </div>
        {player.notes && (
          <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid var(--border)", fontSize: 12, color: "var(--text-muted)" }}>
            <span style={{ color: "var(--text-dim)" }}>Notes fiche : </span>{player.notes}
          </div>
        )}
      </div>

      {/* Total agence — toutes games confondues (cohérent avec Top Contributors / net worth) */}
      <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Agency cut · total joueur (games{grind.is_grinder ? " + grindhouse" : ""})</div>
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

      {/* Évolution Agency Cut — toutes games confondues, cumulé. Filtres période via ?range= */}
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 4, marginBottom: 8 }}>
        {RANGES.map((r) => (
          <Link key={r.key} href={`/players/${playerId}?range=${r.key}`} style={{
            padding: "3px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, textDecoration: "none",
            background: range === r.key ? "rgba(255,255,255,0.07)" : "transparent",
            color: range === r.key ? "var(--text)" : "var(--text-dim)",
            border: "1px solid " + (range === r.key ? "var(--border)" : "transparent"),
          }}>{r.label}</Link>
        ))}
      </div>
      <NetPnlChart
        series={agencySeries}
        cardNet={agencyCardNet}
        currency="USDT"
        title={`Évolution Agency Cut — ${player.name}`}
        rangeLabel={`Agency cut cumulé (toutes games) · ${rangeLabel}`}
      />

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

      {/* Grindhouse — visible uniquement si le joueur est grinder. 2 chiffres essentiels (lifetime). */}
      {grind.is_grinder && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginBottom: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <span style={{ fontSize: 18, fontWeight: 700, color: "#EC4899" }}>GRINDHOUSE</span>
            <span style={{ fontSize: 11, color: "var(--text-dim)" }}>lifetime</span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Winnings grindhouse</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: grind.sessions_pnl_usdt >= 0 ? "var(--green)" : "#EF4444" }}>{fmtAmt(grind.sessions_pnl_usdt)}</div>
            </div>
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>P&L agence (grindhouse)</div>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#D4AF37" }}>{fmtAmt(grind.agency_share_usdt)}</div>
            </div>
          </div>
          {grind.unconverted.length > 0 && (
            <div style={{ fontSize: 11, color: "#F59E0B", marginTop: 10 }}>
              ⚠️ Exclu (taux manquant) : {grind.unconverted.map((u) => `${u.pnl.toLocaleString("fr-FR", { maximumFractionDigits: 0 })} ${u.currency}`).join(", ")}
            </div>
          )}
        </div>
      )}

      {/* Ops — deals éditables, IDs externes, flux wallet, transactions (ex-fiche /players/[id]) */}
      <PlayerDetailClient
        player={player}
        transactions={transactions}
        gameDeals={gameDeals}
        allGames={allGames as any}
        stats={stats}
        gameIds={gameIds}
      />

      <PlayerHistoryPanel
        playerId={playerId}
        playerName={player.name}
        transactions={history}
        dealBoundedNet={stats.net ?? null}
      />

      {/* Notes */}
      {notes.length > 0 && (
        <div style={{ background: "var(--bg-raised)", border: "1px solid var(--border)", borderRadius: 12, padding: 20, marginTop: 24 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)", marginBottom: 12 }}>Notes ({notes.length})</div>
          {notes.slice(0, 10).map((n: any) => (
            <div key={n.id} style={{ padding: "8px 0", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
              <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{(n.created_at ?? "").slice(0, 16).replace("T", " ")}</span>
              <span style={{ marginLeft: 8, color: "var(--text)" }}>{n.content}</span>
            </div>
          ))}
        </div>
      )}

      <PlayerDangerZone playerId={playerId} playerName={player.name} status={player.status} />

      <div style={{ marginTop: 16 }}>
        <Link href="/players" style={{ fontSize: 12, color: "var(--text-muted)", textDecoration: "none" }}>← Retour aux joueurs</Link>
      </div>
    </div>
  );
}
