export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import ReportsClient from "./ReportsClient";

export default function ReportsPage() {
  const db = getDb();
  const games = db.prepare(`SELECT id, name FROM games ORDER BY name`).all() as { id: number; name: string }[];
  const players = db.prepare(`SELECT id, name FROM players WHERE status = 'active' ORDER BY name`).all() as { id: number; name: string }[];

  return (
    <div style={{ padding: "32px 32px 32px 252px" }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: 0 }}>Rakeback Reports</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
          Uploade un screenshot — Claude extrait les joueurs et montants automatiquement
        </p>
      </div>
      <ReportsClient games={games} players={players} />
    </div>
  );
}
