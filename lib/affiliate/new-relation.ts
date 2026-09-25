import { getDb } from "@/lib/db";
import { seedDefaultRatesOn, DEFAULT_AGENT_PCT } from "./agent-rates-schema";

// Nouvelle relation d'affiliation (décision Baki 2026-09-26) : 50 % « par défaut — à
// confirmer » sur chaque game actif, et Baki est notifié sur Telegram (chat agent).
// Appelé juste APRÈS l'INSERT de la relation, à chacun des points de création. Ne
// bloque jamais la création : un échec est journalisé (l'agent restera « bloqué »
// sur ses games sans taux, visible dans le CRM — jamais un zéro silencieux).
export async function afterRelationCreated(relationshipId: number): Promise<void> {
  try {
    const db = getDb();
    const seeded = seedDefaultRatesOn(db, relationshipId);
    if (!seeded.length) return;
    const rel = db.prepare(`
      SELECT a.name AS agent, r.name AS filleul FROM affiliate_relationships ar
      JOIN players a ON a.id = ar.affiliate_player_id JOIN players r ON r.id = ar.referred_player_id WHERE ar.id = ?
    `).get(relationshipId) as { agent: string; filleul: string } | undefined;
    const { notifyOps } = await import("@/lib/ops-notifications");
    await notifyOps(
      `🆕 <b>Nouveau filleul</b> ${rel?.filleul ?? `#${relationshipId}`} (agent <b>${rel?.agent ?? "?"}</b>) : ` +
      `taux agent <b>${DEFAULT_AGENT_PCT} % par défaut</b> posé sur ${seeded.length} game(s) (${seeded.map(g => g.game_name).join(", ")}). ` +
      `À confirmer dans /crm/affiliates.`,
    );
  } catch (e: any) {
    console.error(`[AFFILIATE] taux par défaut de la relation #${relationshipId} : échec —`, e?.message ?? e);
  }
}
