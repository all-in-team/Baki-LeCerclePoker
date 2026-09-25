import { getDb } from "@/lib/db";
import { deletePlayer } from "@/lib/queries";
import {
  assertPlayersArchivableOn,
  getPlayersOpenStateOn,
  type PlayerOpenState,
} from "@/lib/queries/player-open";

// ── Archivage des joueurs : le SEUL chemin qui écrit players.archived_at ──
//
// Un seul concept d'archive (Baki 2026-09-25) : archivé = sorti de la vue principale de
// /players, consultable dans « Archivés », jamais supprimé, désarchivable d'un clic.
// Verrou (a) : on n'archive JAMAIS un joueur ouvert (lib/queries/player-open.ts) — erreur
// explicite, le lot entier est refusé. Désarchiver est toujours permis.
// Module séparé de lib/queries.ts : player-open lit le moteur NEXA, qui importe
// lib/queries.ts — y loger l'archivage créerait un import circulaire.

export function getPlayersOpenState(playerIds?: number[]): Map<number, PlayerOpenState> {
  return getPlayersOpenStateOn(getDb(), playerIds);
}

const now = () => new Date().toISOString().replace("T", " ").slice(0, 19);

/**
 * Archive un lot d'ids explicites (jamais un WHERE ouvert). Lève PlayerOpenError si un seul
 * est ouvert : rien n'est écrit. Le contrôle et l'écriture sont dans la même transaction.
 * Retourne le nombre de lignes effectivement archivées (les déjà-archivés sont ignorés).
 */
export function archivePlayers(ids: number[], reason: string): number {
  if (ids.length === 0) return 0;
  const db = getDb();
  const stmt = db.prepare(`UPDATE players SET archived_at = ?, archive_reason = ? WHERE id = ? AND archived_at IS NULL`);
  return db.transaction(() => {
    assertPlayersArchivableOn(db, ids);
    const at = now();
    let n = 0;
    for (const id of ids) n += stmt.run(at, reason, id).changes;
    return n;
  }).immediate();
}

/** Désarchive : toujours permis, retour immédiat dans la vue principale. */
export function unarchivePlayer(id: number): void {
  getDb().prepare(`UPDATE players SET archived_at = NULL, archive_reason = NULL WHERE id = ?`).run(id);
}

/**
 * Suppression définitive, refusée pour un joueur ouvert : supprimer, c'est la forme ultime de
 * « disparaître de la vue principale ». S'ajoute aux gardes d'historique de deletePlayer
 * (qui, eux, ne voient ni NEXA ni XPoker ni l'affiliation). Même transaction.
 */
export function deletePlayerChecked(id: number): void {
  const db = getDb();
  db.transaction(() => {
    assertPlayersArchivableOn(db, [id]);
    deletePlayer(id);
  }).immediate();
}

/**
 * Remise à zéro d'onboarding (route admin reset-player) : supprime la ligne joueur, ses notes
 * CRM, sa session bot et son lead pour rejouer /start. Passe par le verrou « ouvert » comme
 * toute suppression — un joueur qui a quelque chose à régler n'est jamais effacé. Même transaction.
 */
export function resetPlayerChecked(by: { telegram_id?: number; player_id?: number }):
  | { found: false }
  | { found: true; deleted_player_id: number; deleted_player_name: string; deleted_session: boolean; deleted_lead: boolean } {
  const db = getDb();
  return db.transaction(() => {
    const player = (by.telegram_id
      ? db.prepare(`SELECT id, name, telegram_chat_id FROM players WHERE telegram_id = ?`).get(by.telegram_id)
      : db.prepare(`SELECT id, name, telegram_chat_id FROM players WHERE id = ?`).get(by.player_id)) as
      { id: number; name: string; telegram_chat_id: string | null } | undefined;
    if (!player) return { found: false as const };

    assertPlayersArchivableOn(db, [player.id]);

    let deletedSession = false;
    if (player.telegram_chat_id) deletedSession = db.prepare(`DELETE FROM telegram_sessions WHERE chat_id = ?`).run(player.telegram_chat_id).changes > 0;
    db.prepare(`DELETE FROM crm_notes WHERE player_id = ?`).run(player.id);
    db.prepare(`DELETE FROM players WHERE id = ?`).run(player.id);
    // onboarding_leads nettoyé pour que /start reparte de zéro
    const deletedLead = by.telegram_id ? db.prepare(`DELETE FROM onboarding_leads WHERE telegram_id = ?`).run(by.telegram_id).changes > 0 : false;
    return { found: true as const, deleted_player_id: player.id, deleted_player_name: player.name, deleted_session: deletedSession, deleted_lead: deletedLead };
  }).immediate();
}
