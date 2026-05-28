export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import GrindhouseClient from "./GrindhouseClient";

export default function GrindhousePage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);

  const sessions = db.prepare(`
    SELECT gs.*, p.name AS player_name, g.name AS game_name
    FROM grindhouse_sessions gs
    JOIN players p ON p.id = gs.player_id
    JOIN games g ON g.id = gs.game_id
    WHERE gs.session_date = ?
    ORDER BY gs.created_at DESC
  `).all(today) as any[];

  const grinders = db.prepare(`
    SELECT gg.player_id, gg.status, gg.deal_percentage, p.name, p.telegram_handle
    FROM grindhouse_grinders gg
    JOIN players p ON p.id = gg.player_id
    WHERE gg.status = 'active'
    ORDER BY p.name
  `).all() as any[];

  const allPlayers = db.prepare(`SELECT id, name, telegram_handle FROM players WHERE status IN ('active', 'signed') ORDER BY name`).all() as any[];
  const games = db.prepare(`SELECT id, name FROM games WHERE status = 'active' ORDER BY id`).all() as any[];

  return (
    <>
      <PageHeader title="Grindhouse" subtitle="Sessions de grind quotidiennes" />
      <GrindhouseClient initialSessions={sessions} initialDate={today} grinders={grinders} allPlayers={allPlayers} games={games} />
    </>
  );
}
