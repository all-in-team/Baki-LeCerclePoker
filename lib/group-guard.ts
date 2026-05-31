import { getDb } from "./db";

const PLAYER_GROUP_RE = /^.+\s+x\s+LeCercle$/i;

export function isPlayerGroup(title: string, chatId: string | number): boolean {
  if (PLAYER_GROUP_RE.test(title)) return true;
  const id = String(chatId);
  const row = getDb().prepare(
    `SELECT 1 FROM players WHERE telegram_group_id = ? LIMIT 1`
  ).get(id);
  return !!row;
}
