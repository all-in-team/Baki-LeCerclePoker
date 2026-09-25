import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { computeAgentCommissionOn, legacyAgentCommissionOn } from "@/lib/affiliate/agent-rates";

// PREUVE DE MIGRATION, lecture seule : pour chaque agent, le dû de l'ANCIEN calcul
// (recopié tel quel : cumul lifetime × 0.50, éligibilité relue sur created_at) contre
// le dû du nouveau (taux par filleul × game × semaine). Écart attendu : 0 au centime
// tant qu'aucun taux n'a été modifié à la main. À supprimer avec legacyAgentCommissionOn.
export async function GET() {
  const db = getDb();
  const agents = db.prepare(`
    SELECT DISTINCT id, name FROM (
      SELECT p.id, p.name FROM affiliate_profiles ap JOIN players p ON p.id = ap.affiliate_player_id
      UNION SELECT p.id, p.name FROM affiliate_relationships ar JOIN players p ON p.id = ar.affiliate_player_id
    ) ORDER BY name
  `).all() as { id: number; name: string }[];
  const manual = (db.prepare(`SELECT COUNT(*) AS n FROM affiliate_agent_rates WHERE kind = 'manual'`).get() as { n: number }).n;
  const rows = agents.map(a => {
    const legacy = legacyAgentCommissionOn(db, a.id);
    const now = computeAgentCommissionOn(db, a.id);
    const delta = now.due_now === null ? null : now.due_now - legacy.due_now;
    return {
      agent_id: a.id, agent: a.name,
      legacy_due: legacy.due_now, new_due: now.due_now,
      legacy_earned: legacy.earned, new_earned: now.earned, paid: now.paid,
      delta, same_to_the_cent: delta !== null && Math.abs(delta) < 0.005, blocked: now.blocked,
    };
  });
  return NextResponse.json({
    manual_rates: manual,
    all_same_to_the_cent: rows.every(r => r.same_to_the_cent),
    agents: rows,
  });
}
