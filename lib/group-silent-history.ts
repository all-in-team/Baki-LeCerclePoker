// Stock des ANCIENS groupes pour le job « groupes silencieux 7 j » (Hugo 2026-09-27).
//
// add_group_first_msg_v1 a marqué tous les groupes existants « ont déjà parlé » (source
// 'backfill') faute de savoir : ils étaient hors du job. Ici, le userbot relit l'historique de
// chacun et on tranche sur preuve :
//   • un vrai message du lead trouvé           ⇒ first_msg_at = sa date, source 'history' (protégé)
//   • historique lu EN ENTIER, rien du lead      ⇒ first_msg_at = NULL, source 'history_none'
//                                                   (redevient candidat, garde-fous du job inchangés)
//   • historique trop long pour tout lire         ⇒ source 'history_truncated' (protégé)
//   • 3 lectures en échec                         ⇒ source 'history_unreadable' (protégé)
// Dans le doute, on protège : seul un historique complet et vide rend un groupe supprimable.
//
// Module pur (type Database seulement) : la logique base est testée sans Telegram
// (scripts/group-silent-history.test.ts) ; lib/group-lifecycle.ts l'appelle avec getDb().

import type Database from "better-sqlite3";

type DB = Database.Database;

export const LEGACY_HISTORY_MAX_ATTEMPTS = 3;
export const LEGACY_DRY_RUN_FLAG = "silent_group_cleanup_legacy_dry_run_done";
export const NEW_DRY_RUN_FLAG = "silent_group_cleanup_dry_run_done";

export interface LegacyHistoryRow { chat_id: string; owner_key: number; history_attempts: number }

/** Anciens groupes encore à vérifier : rejoints, non nettoyés, marqués par le backfill. */
export function legacyHistoryBatchOn(db: DB, limit: number): LegacyHistoryRow[] {
  return db.prepare(`
    SELECT chat_id, owner_key, history_attempts FROM group_creations
    WHERE cleaned_at IS NULL AND joined_at IS NOT NULL AND first_msg_source = 'backfill'
    ORDER BY created_at
    LIMIT ?
  `).all(limit) as LegacyHistoryRow[];
}

export type HistoryVerdict = { checked: boolean; found_at: string | null; truncated: boolean; error: string | null };
export type HistoryOutcome = "spoke" | "silent" | "truncated" | "retry" | "unreadable" | "unchanged";

/**
 * Applique le verdict de lecture d'historique à UN groupe. Chaque UPDATE est gardé par
 * `first_msg_source = 'backfill'` : si le webhook a vu un message entre-temps (source
 * 'webhook'), on n'écrase rien (« unchanged »).
 */
export function applyHistoryVerdictOn(db: DB, chatId: string, v: HistoryVerdict): HistoryOutcome {
  const guard = `WHERE chat_id = ? AND first_msg_source = 'backfill'`;
  let changes: number;
  let outcome: HistoryOutcome;
  if (!v.checked) {
    const r = db.prepare(`UPDATE group_creations SET history_attempts = history_attempts + 1 ${guard}`).run(chatId);
    if (r.changes === 0) return "unchanged";
    const a = (db.prepare(`SELECT history_attempts FROM group_creations WHERE chat_id = ?`).get(chatId) as { history_attempts: number }).history_attempts;
    if (a < LEGACY_HISTORY_MAX_ATTEMPTS) return "retry";
    changes = db.prepare(`UPDATE group_creations SET first_msg_source = 'history_unreadable' ${guard}`).run(chatId).changes;
    outcome = "unreadable";
  } else if (v.found_at) {
    // Une preuve positive vaut même sur un historique tronqué : il a parlé.
    changes = db.prepare(`UPDATE group_creations SET first_msg_at = ?, first_msg_source = 'history' ${guard}`).run(v.found_at, chatId).changes;
    outcome = "spoke";
  } else if (v.truncated) {
    changes = db.prepare(`UPDATE group_creations SET first_msg_source = 'history_truncated' ${guard}`).run(chatId).changes;
    outcome = "truncated";
  } else {
    changes = db.prepare(`UPDATE group_creations SET first_msg_at = NULL, first_msg_source = 'history_none' ${guard}`).run(chatId).changes;
    outcome = "silent";
  }
  return changes === 0 ? "unchanged" : outcome;
}

/** Anciens groupes devenus candidats (historique vide) et pas encore nettoyés. */
export function legacyPendingOn(db: DB): number {
  return (db.prepare(`
    SELECT COUNT(*) AS n FROM group_creations
    WHERE cleaned_at IS NULL AND first_msg_at IS NULL AND first_msg_source = 'history_none'
  `).get() as { n: number }).n;
}

function flagOn(db: DB, key: string): boolean {
  return !!db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(key);
}

/**
 * Dry-run ou réel ? Dry-run tant que le premier passage des NOUVEAUX groupes n'a pas été
 * prévisualisé, ET tant que les ANCIENS groupes devenus candidats n'ont pas eu le leur —
 * le stock ancien ne passe jamais en réel sans aperçu, même si les nouveaux y sont déjà.
 */
export function silentCleanupModeOn(db: DB): { dryRun: boolean; legacyPending: number } {
  const legacyPending = legacyPendingOn(db);
  const dryRun = !flagOn(db, NEW_DRY_RUN_FLAG) || (legacyPending > 0 && !flagOn(db, LEGACY_DRY_RUN_FLAG));
  return { dryRun, legacyPending };
}

/** Pose les marqueurs après un dry-run qui a EXAMINÉ au moins un groupe. Rend les marqueurs posés. */
export function markSilentDryRunDoneOn(db: DB, r: { dryRun: boolean; ok: boolean; scanned: number; legacyPending: number }): string[] {
  if (!r.dryRun || !r.ok || r.scanned === 0) return [];
  const set = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  const now = new Date().toISOString();
  const out: string[] = [];
  set.run(NEW_DRY_RUN_FLAG, now); out.push(NEW_DRY_RUN_FLAG);
  // Les anciens candidats sont les plus vieux : triés par created_at, ils passent en premier
  // dans le lot du dry-run — ce dry-run les a donc bien montrés.
  if (r.legacyPending > 0) { set.run(LEGACY_DRY_RUN_FLAG, now); out.push(LEGACY_DRY_RUN_FLAG); }
  return out;
}
