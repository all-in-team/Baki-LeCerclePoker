// Aiguillage des DM privés entre les funnels de room (QQPK, Nexa, …).
//
// Le webhook appelait directement le handler QQPK pour tout message privé ; avec
// plusieurs funnels il faut choisir, sinon un lead Nexa qui envoie son ID joueur
// se ferait intercepter par QQPK.
//
// Règle : on ne consulte que les funnels où ce telegram_id est un lead. S'il l'est
// dans plusieurs (rare mais possible — un lead peut avoir suivi deux campagnes),
// le funnel où il a été actif le plus récemment gagne.
import { getDb } from "@/lib/db";

type Candidate = { funnel: "qqpk" | "nexa"; ts: string };

function lastActivity(sql: string, tgId: number, funnel: "qqpk" | "nexa"): Candidate | null {
  try {
    const row = getDb().prepare(sql).get(tgId) as { ts: string | null } | undefined;
    if (!row) return null;
    return { funnel, ts: row.ts ?? "" };
  } catch {
    // Table absente (migration pas encore appliquée) → ce funnel ne participe pas.
    return null;
  }
}

/** Retourne true si un funnel a consommé le message. */
export async function dispatchFunnelDm(chatId: number, fromId: number, text: string): Promise<boolean> {
  const candidates: Candidate[] = [];

  const qqpk = lastActivity(
    `SELECT updated_at AS ts FROM qqpk_funnel_leads WHERE telegram_id = ?`, fromId, "qqpk",
  );
  if (qqpk) candidates.push(qqpk);

  const nexa = lastActivity(
    `SELECT COALESCE(last_interaction_at, updated_at) AS ts FROM nexa_leads WHERE tg_user_id = ?`, fromId, "nexa",
  );
  if (nexa) candidates.push(nexa);

  if (candidates.length === 0) return false;

  // Les timestamps sont tous au format SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) → l'ordre
  // lexicographique est chronologique.
  candidates.sort((a, b) => b.ts.localeCompare(a.ts));

  for (const c of candidates) {
    if (c.funnel === "nexa") {
      const { handleNexaFunnelDm } = await import("@/lib/nexa-funnel");
      if (await handleNexaFunnelDm(chatId, fromId, text)) return true;
    } else {
      const { handleQqpkFunnelDm } = await import("@/lib/qqpk-funnel");
      if (await handleQqpkFunnelDm(chatId, fromId, text)) return true;
    }
  }
  return false;
}
