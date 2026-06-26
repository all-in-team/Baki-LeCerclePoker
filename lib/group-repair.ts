/**
 * Group repair core — shared by /fixgroup, /linkgroup, and /api/admin/fix-group-topics.
 *
 * Robust, idempotent: verifies the userbot session FIRST (no false success if it's dead),
 * then find-or-creates all 7 forum topics (+ invites/promotes the bot) via syncGroupStructure,
 * and writes every discovered topic id AUTHORITATIVELY into players.*_topic_id (corrects stale
 * ids; never writes NULL over a value). The caller decides the user-facing message AFTER this
 * returns — fixing the original bug where "✅" was shown before the backfill was attempted.
 */

import { getDb } from "./db";
import { checkUserbotHealth, syncGroupStructure } from "./telegram-userbot";

// key (forum topic) → players column. Same mapping linkgroup/sync use.
const TOPIC_COLUMN_MAP: Record<string, string> = {
  accounting: "accounting_topic_id",
  deals: "deals_topic_id",
  clubs: "clubs_topic_id",
  depot: "depot_topic_id",
  liveplay: "liveplay_topic_id",
  onboarding: "onboarding_topic_id",
  alertes: "alertes_topic_id",
};
const ALL_KEYS = Object.keys(TOPIC_COLUMN_MAP);

export interface GroupRepairResult {
  ok: boolean;                 // session ok AND all 7 topics present
  sessionOk: boolean;          // userbot session valid
  botInvited: boolean;
  botPromoted: boolean;
  topicsWritten: string[];     // keys whose id was written to DB
  topicsCreated: string[];     // titles newly created in Telegram
  topicsMissing: string[];     // keys sync could neither find nor create
  errors: string[];
}

export async function repairGroupTopics(chatId: number, playerId: number): Promise<GroupRepairResult> {
  const res: GroupRepairResult = {
    ok: false, sessionOk: false, botInvited: false, botPromoted: false,
    topicsWritten: [], topicsCreated: [], topicsMissing: [], errors: [],
  };

  // 1) Session alive? If not, bail out cleanly — caller must NOT claim success.
  const health = await checkUserbotHealth();
  if (!health.session_valid) {
    res.errors.push(health.error ?? "Userbot session invalid");
    return res; // sessionOk stays false
  }
  res.sessionOk = true;

  // 2) Find-or-create all topics + invite/promote bot.
  const sync = await syncGroupStructure(chatId);
  res.botInvited = sync.bot_invited;
  res.botPromoted = sync.bot_promoted;
  res.topicsCreated = sync.topics_created;
  if (sync.errors.length) res.errors.push(...sync.errors);

  // 3) Authoritative write of every discovered topic id (fixes stale; never writes NULL).
  const db = getDb();
  for (const key of ALL_KEYS) {
    const id = sync.topic_ids[key];
    if (id != null) {
      db.prepare(`UPDATE players SET ${TOPIC_COLUMN_MAP[key]} = ? WHERE id = ?`).run(id, playerId);
      res.topicsWritten.push(key);
    } else {
      res.topicsMissing.push(key);
    }
  }

  res.ok = res.sessionOk && res.topicsMissing.length === 0;
  return res;
}
