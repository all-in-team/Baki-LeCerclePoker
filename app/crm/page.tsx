export const dynamic = "force-dynamic";
import { getTopContributors } from "@/lib/queries";
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
    SELECT p.id, p.name, p.telegram_handle, p.status, p.tier,
      (SELECT MAX(created_at) FROM crm_notes WHERE player_id = p.id) AS last_note_at
    FROM players p WHERE p.status IN ('active', 'signed', 'inactive', 'churned')
    ORDER BY p.name
  `).all() as any[];

  const gameRows = db.prepare(`
    SELECT pgd.player_id, GROUP_CONCAT(g.name, ',') AS game_names
    FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id GROUP BY pgd.player_id
  `).all() as any[];
  const gamesByPlayer: Record<number, string[]> = {};
  gameRows.forEach((g: any) => { gamesByPlayer[g.player_id] = (g.game_names as string).split(","); });

  const dealRows = db.prepare(`
    SELECT pgd.id AS deal_id, pgd.player_id, pgd.game_id, pgd.action_pct, pgd.rakeback_pct, pgd.start_date
    FROM player_game_deals pgd
  `).all() as any[];
  const dealsByPlayer: Record<number, any[]> = {};
  dealRows.forEach((d: any) => { (dealsByPlayer[d.player_id] ??= []).push(d); });

  const activeGames = db.prepare(`SELECT id, name, default_action_pct FROM games WHERE status = 'active' ORDER BY id`).all() as any[];

  const contributors = getTopContributors({ from: d30, to: today }, 100);
  const agencyByPlayer: Record<number, number> = {};
  contributors.forEach(c => { agencyByPlayer[c.player_id] = c.agency_usdt; });

  const sorted = [...allPlayers].sort((a, b) => (agencyByPlayer[b.id] ?? 0) - (agencyByPlayer[a.id] ?? 0));

  return (
    <>
      <PageHeader title="CRM Joueurs" subtitle="Vue d'ensemble des joueurs et leur contribution" />
      <CRMViewToggle
        players={sorted}
        gamesByPlayer={gamesByPlayer}
        dealsByPlayer={dealsByPlayer}
        agencyByPlayer={agencyByPlayer}
        activeGames={activeGames}
      />
    </>
  );
}
