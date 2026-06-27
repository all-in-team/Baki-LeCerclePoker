import { getDb } from "@/lib/db";

/**
 * Resolve the Onboarding forum-topic thread id for a player's group, so that EVERY
 * onboarding flow (NUTSPK / AKS / A5 / KK / AAPK / QQPK) posts its pitch + prompts in
 * the dedicated "Onboarding" topic instead of silently falling into General.
 *
 * Order of resolution:
 *   1) players.onboarding_topic_id already set → use it (fast path, no userbot call).
 *   2) NULL → run repairGroupTopics (userbot find-or-create of all topics + authoritative
 *      DB backfill), then re-read the column.
 *   3) Still NULL after repair (userbot down, bot not admin, etc.) → return undefined
 *      (General) but ONLY as a last resort, with a loud log. Never throws.
 *
 * Onboarding is an OPEN topic (TOPIC_DEFS `onboarding` has closed:false in telegram-userbot.ts),
 * so the player can reply during onboarding.
 */
export async function getOnboardingThreadId(
  chatId: number,
  playerId: number,
  label: string,
): Promise<number | undefined> {
  const db = getDb();
  const read = (): number | null =>
    (db.prepare(`SELECT onboarding_topic_id FROM players WHERE id = ?`).get(playerId) as { onboarding_topic_id: number | null } | undefined)?.onboarding_topic_id ?? null;

  let tid = read();
  if (tid != null) return tid;

  // NULL → attempt to find-or-create the topics via the userbot and backfill the DB.
  // Dynamic import keeps gramjs out of the module graph until actually needed.
  console.warn(`[${label}] onboarding_topic_id NULL for player ${playerId} (chat ${chatId}) — running group-repair before posting...`);
  try {
    const { repairGroupTopics } = await import("@/lib/group-repair");
    const res = await repairGroupTopics(chatId, playerId);
    if (!res.sessionOk) {
      console.warn(`[${label}] group-repair could not run (userbot session invalid): ${res.errors.join("; ")}`);
    } else if (res.topicsMissing.includes("onboarding")) {
      console.warn(`[${label}] group-repair ran but Onboarding topic still missing: ${res.errors.join("; ")}`);
    }
  } catch (e: any) {
    console.error(`[${label}] group-repair threw: ${e?.message ?? e}`);
  }

  tid = read();
  if (tid != null) {
    console.log(`[${label}] onboarding_topic_id resolved to ${tid} after repair for player ${playerId}`);
    return tid;
  }

  console.warn(`[${label}] onboarding_topic_id STILL NULL after repair — falling back to General for player ${playerId}`);
  return undefined;
}
