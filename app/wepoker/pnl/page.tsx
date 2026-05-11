export const dynamic = "force-dynamic";
import PageHeader from "@/components/PageHeader";
import FinanceClient from "./FinanceClient";
import { getDb } from "@/lib/db";

export default async function WepokerPnlPage({ searchParams }: { searchParams: Promise<{ player?: string }> }) {
  const params = await searchParams;
  const playerFilter = params.player ? parseInt(params.player) : undefined;
  let filterPlayerName: string | null = null;
  if (playerFilter) {
    const row = getDb().prepare(`SELECT name FROM players WHERE id = ?`).get(playerFilter) as { name: string } | undefined;
    filterPlayerName = row?.name ?? `#${playerFilter}`;
  }

  return (
    <>
      <PageHeader title="WEPOKER — P&L" subtitle="Rakeback, insurance & winnings par joueur" />
      {filterPlayerName && (
        <div style={{ padding: "0 28px 12px", display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ background: "rgba(16,185,129,0.15)", color: "#10B981", padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: 600 }}>
            Filtré : {filterPlayerName}
          </span>
          <a href="/wepoker/pnl" style={{ fontSize: 11, color: "var(--text-muted)", textDecoration: "none" }}>✕ Retirer le filtre</a>
        </div>
      )}
      <FinanceClient />
    </>
  );
}
