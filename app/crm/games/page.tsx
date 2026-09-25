export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import GamesConfigClient from "./GamesConfigClient";
import { currentPerceivedOn, perceivedPeriodsOn } from "@/lib/affiliate/agent-rates";

export default function GamesConfigPage() {
  const db = getDb();
  const games = db.prepare(`
    SELECT id, name, status, COALESCE(currency, 'USDT') AS currency,
      exact_action_pct, exact_rakeback_pct, exact_insurance_pct
    FROM games ORDER BY status ASC, name ASC
  `).all() as any[];
  // Perçu = la période EN VIGUEUR cette semaine (game_perceived_deals), plus son historique.
  // Les colonnes games.perceived_* ne sont plus qu'une photo de la migration.
  for (const g of games) {
    const cur = currentPerceivedOn(db, g.id);
    g.perceived_action_pct = cur?.action_pct ?? null;
    g.perceived_rakeback_pct = cur?.rakeback_pct ?? null;
    g.perceived_insurance_pct = cur?.insurance_pct ?? null;
    g.perceived_periods = perceivedPeriodsOn(db, g.id);
  }

  return (
    <>
      <PageHeader title="Games & Deals" subtitle="Configuration des rates exact et perceived par game" />
      <GamesConfigClient games={games} />
    </>
  );
}
