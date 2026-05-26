export const dynamic = "force-dynamic";
import { getTopContributors, getWalletSummaryByPlayer } from "@/lib/queries";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import CRMViewToggle from "./CRMViewToggle";

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

export default function CRMPage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const d30 = daysAgo(30);

  const allPlayers = db.prepare(`
    SELECT p.id, p.name, p.telegram_handle, p.status, p.tier, p.telegram_id, p.created_at, p.joined_via,
      (SELECT MAX(created_at) FROM crm_notes WHERE player_id = p.id) AS last_note_at
    FROM players p WHERE p.status IN ('active', 'signed', 'inactive', 'churned')
    ORDER BY p.name
  `).all() as any[];

  const gameRows = db.prepare(`
    SELECT pgd.player_id, GROUP_CONCAT(g.name, ',') AS game_names
    FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id
    WHERE pgd.end_date IS NULL
    GROUP BY pgd.player_id
  `).all() as any[];
  const gamesByPlayer: Record<number, string[]> = {};
  gameRows.forEach((g: any) => { gamesByPlayer[g.player_id] = (g.game_names as string).split(","); });

  const dealRows = db.prepare(`
    SELECT pgd.id AS deal_id, pgd.player_id, pgd.game_id, pgd.action_pct, pgd.rakeback_pct, pgd.start_date, pgd.end_date
    FROM player_game_deals pgd
  `).all() as any[];
  const dealsByPlayer: Record<number, any[]> = {};
  dealRows.forEach((d: any) => { (dealsByPlayer[d.player_id] ??= []).push(d); });

  const activeGames = db.prepare(`SELECT id, name, default_action_pct, status FROM games WHERE status IN ('active', 'archived') ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, id`).all() as any[];

  const contributors = getTopContributors({ from: d30, to: today }, 100);
  const agencyByPlayer: Record<number, number> = {};
  contributors.forEach(c => { agencyByPlayer[c.player_id] = c.agency_usdt; });

  const pnl30dRows = getWalletSummaryByPlayer({ since_date: d30 + "T00:00:00Z", end_date: today + "T23:59:59Z" }) as any[];
  const pnlByPlayerGame: Record<string, { player_net: number; agency_pnl: number }> = {};
  pnl30dRows.forEach((r: any) => {
    pnlByPlayerGame[`${r.player_id}_${r.game_id}`] = { player_net: r.net ?? 0, agency_pnl: r.my_pnl ?? 0 };
  });

  const sorted = [...allPlayers].sort((a, b) => (agencyByPlayer[b.id] ?? 0) - (agencyByPlayer[a.id] ?? 0));

  return (
    <>
      <PageHeader title="CRM Joueurs" subtitle="Vue d'ensemble des joueurs et leur contribution" />
      <CRMViewToggle
        players={sorted}
        gamesByPlayer={gamesByPlayer}
        dealsByPlayer={dealsByPlayer}
        agencyByPlayer={agencyByPlayer}
        pnlByPlayerGame={pnlByPlayerGame}
        activeGames={activeGames}
      />
    </>
  );
}
