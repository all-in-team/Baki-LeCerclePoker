import { getDb } from "@/lib/db";
import { renamePlayerGroup } from "@/lib/telegram-userbot";

// Title format for an affiliated player's group: "{nom} x LeCercle [{agent}]".
// Built from scratch (player name + agent name) so it's idempotent — re-applying yields the
// same title, and any stale trailing "[...]" tag is replaced rather than stacked.
export function buildAffiliatedTitle(playerName: string, agentName: string): string {
  const base = playerName.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  return `${base} x LeCercle [${agentName}]`;
}

// Base (untagged) title for a player's group: "{nom} x LeCercle".
// Built from scratch (player name only) and strips any trailing "[...]" tag so terminating an
// affiliation cleanly reverts to the untagged title with no residue.
export function buildBaseTitle(playerName: string): string {
  const base = playerName.replace(/\s*\[[^\]]*\]\s*$/, "").trim();
  return `${base} x LeCercle`;
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

// Inverse of the going-forward rename: called AFTER an affiliate relationship is terminated.
// Reverts the referred player's group title to the untagged base "{nom} x LeCercle".
// Multi-agent edge case: if the player is STILL tied to another active agent after this
// termination, re-tag with that remaining agent instead of stripping to base. (The schema's
// UNIQUE(referred_player_id) makes >1 active relation effectively impossible today, but this
// stays correct if that ever changes.) Single rename, never a burst. Caller must wrap in
// try/catch and never let a rename failure block the termination.
export async function retagAffiliatedGroupForReferred(referredPlayerId: number): Promise<RenameResult> {
  const db = getDb();
  const referred = db.prepare(`SELECT name, telegram_group_id FROM players WHERE id = ?`).get(referredPlayerId) as
    | { name: string; telegram_group_id: string | null }
    | undefined;
  if (!referred) return { status: "referred_not_found" };
  if (!referred.telegram_group_id) return { status: "no_group" };

  // Any remaining active agent for this filleul? (multi-agent guard)
  const remaining = db.prepare(
    `SELECT a.name AS agent_name
     FROM affiliate_relationships ar
     JOIN players a ON a.id = ar.affiliate_player_id
     WHERE ar.referred_player_id = ? AND ar.status = 'active'
     ORDER BY ar.start_date DESC LIMIT 1`
  ).get(referredPlayerId) as { agent_name: string } | undefined;

  const title = remaining?.agent_name
    ? buildAffiliatedTitle(referred.name, remaining.agent_name)
    : buildBaseTitle(referred.name);

  const res = await renamePlayerGroup(String(referred.telegram_group_id), title);
  if (res.ok) return { status: "renamed", title };
  return { status: "failed", title, error: res.error, flood_wait: res.flood_wait };
}
