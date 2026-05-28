import { getDb } from "@/lib/db";
import GrindersBar from "./GrindersBar";

export default function GrindhouseLayout({ children }: { children: React.ReactNode }) {
  const db = getDb();

  const grinders = db.prepare(`
    SELECT gg.player_id, p.name, p.telegram_handle
    FROM grindhouse_grinders gg JOIN players p ON p.id = gg.player_id
    WHERE gg.status = 'active' ORDER BY p.name
  `).all() as any[];

  const allPlayers = db.prepare(`SELECT id, name, telegram_handle FROM players WHERE status IN ('active', 'signed') ORDER BY name`).all() as any[];

  return (
    <>
      <GrindersBar initialGrinders={grinders} allPlayers={allPlayers} />
      {children}
    </>
  );
}
