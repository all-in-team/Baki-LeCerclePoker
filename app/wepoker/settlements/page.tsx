export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import ReportsClient from "./ReportsClient";

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ player?: string }> }) {
  const params = await searchParams;
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  const db = getDb();
  const games = db.prepare(`SELECT id, name, default_action_pct FROM games ORDER BY name`).all() as { id: number; name: string; default_action_pct: number | null }[];
  const players = db.prepare(`SELECT id, name FROM players WHERE status = 'active' ORDER BY name`).all() as { id: number; name: string }[];

  let filterPlayerName: string | null = null;
  if (playerFilter) {
    const row = players.find(p => p.id === playerFilter);
    filterPlayerName = row?.name ?? `#${playerFilter}`;
  }

  return (
    <div style={{ padding: "32px 32px 32px 252px" }}>
      <div style={{ marginBottom: 28 }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", margin: 0 }}>WEPOKER — Settlements</h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 4 }}>
          Uploade un screenshot — Claude extrait les joueurs et montants automatiquement
        </p>
      </div>
      {filterPlayerName && (
        <div style={{ marginBottom: 12, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "rgba(16,185,129,0.15)", color: "#10B981", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            Filtré : {filterPlayerName}
          </span>
          <a href="/wepoker/settlements" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
        </div>
      )}
      <ReportsClient games={games} players={players} />
    </div>
  );
}
