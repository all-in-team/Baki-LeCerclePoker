import { getDb } from "@/lib/db";
import { renamePlayerGroup } from "@/lib/telegram-userbot";

// Title format for an affiliated player's group: "{nom} x LeCercle [{agent}]".
// Built from scratch (player name + agent name) so it's idempotent — re-applying yields the
// same title, and any stale trailing "[...]" tag is replaced rather than stacked.
export function buildAffiliatedTitle(playerName: string, agentName: string): string {
  const base = playerName.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  return `${base} x LeCercle [${agentName}]`;
}

// True if `currentTitle` already carries this exact agent tag (idempotency / skip).
export function isAlreadyTagged(currentTitle: string | null | undefined, agentName: string): boolean {
  if (!currentTitle) return false;
  return new RegExp(`\\[${agentName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s*$`).test(currentTitle.trim());
}

export interface RenameResult {
  status: "renamed" | "no_group" | "no_agent" | "referred_not_found" | "failed";
  title?: string;
  error?: string | null;
  flood_wait?: number | null;
}

// Going-forward auto-rename: called AFTER an affiliate relationship is created. Single rename,
// never a burst. Caller should wrap in try/catch and never let a rename failure block the
// relationship creation.
export async function renameAffiliatedGroupForRelationship(
  referredPlayerId: number,
  affiliatePlayerId: number,
): Promise<RenameResult> {
  const db = getDb();
  const referred = db.prepare(`SELECT name, telegram_group_id FROM players WHERE id = ?`).get(referredPlayerId) as
    | { name: string; telegram_group_id: string | null }
    | undefined;
  if (!referred) return { status: "referred_not_found" };
  if (!referred.telegram_group_id) return { status: "no_group" }; // new group will be created with the right title
  const agent = db.prepare(`SELECT name FROM players WHERE id = ?`).get(affiliatePlayerId) as { name: string } | undefined;
  if (!agent?.name) return { status: "no_agent" };

  const title = buildAffiliatedTitle(referred.name, agent.name);
  const res = await renamePlayerGroup(String(referred.telegram_group_id), title);
  if (res.ok) return { status: "renamed", title };
  return { status: "failed", title, error: res.error, flood_wait: res.flood_wait };
}
