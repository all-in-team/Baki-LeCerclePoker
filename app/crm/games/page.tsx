export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import GamesConfigClient from "./GamesConfigClient";

export default function GamesConfigPage() {
  const db = getDb();
  const games = db.prepare(`
    SELECT id, name, status,
      exact_action_pct, exact_rakeback_pct, exact_insurance_pct,
      perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct
    FROM games ORDER BY status ASC, name ASC
  `).all() as any[];

  return (
    <>
      <PageHeader title="Games & Deals" subtitle="Configuration des rates exact et perceived par game" />
      <GamesConfigClient games={games} />
    </>
  );
}
