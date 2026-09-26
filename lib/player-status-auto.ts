import type Database from "better-sqlite3";
import { unarchivePlayerOn } from "@/lib/players-archive";

type DB = Database.Database;

// ── Statut active / inactive automatique (règle Baki, 2026-09-25) ──────────────
//
//   • active  = une activité de JEU dans les 21 derniers jours ; inactive sinon.
//   • nouveau joueur (créé il y a moins de 21 jours) : active d'office.
//   • archivé + activité POSTÉRIEURE à son archivage → désarchivé automatiquement.
//   • players.status_manual = 1 : l'automate ne touche pas à son STATUT.
//   • recalcul chaque nuit (04:30 Paris) et juste avant l'envoi du dimanche (11:45 Paris,
//     cf. lib/cron.ts) ; interrupteur PLAYER_STATUS_AUTO_ENABLED.
//   • chaque bascule est tracée dans player_status_changes (joueur, ancien → nouveau,
//     date, motif avec la source et la date de l'activité).
//
// « Activité » = UNIQUEMENT du jeu (Baki) — PAS les règlements payés, ni les semaines
// TELE reçues, ni les commissions d'affiliation payées, ni notes / deals / wallets /
// messages du bot. Pour une donnée hebdomadaire, la date retenue est la FIN de semaine.
// L'automate ne manipule que active ⇄ inactive : `signed` compte comme actif (il peut
// passer inactive), `churned` comme inactif (il peut repasser active).
// Uniquement des statuts et l'archive : aucun calcul d'argent, règlement, P&L ou sync.

export const WINDOW_DAYS = 21;

// Garde-fou (audit C4) : une sync ou un import en panne ferait passer en masse de vrais
// joueurs en inactive. Au-delà de ce nombre de joueurs VISIBLES (non archivés) qui
// passeraient inactive en une passe, le cron n'écrit RIEN et alerte l'ops ; seul un
// déclenchement « manual » passe outre. Premier passage mesuré sur le dump du 25/09 : 6.
export const MAX_VISIBLE_DEACTIVATIONS = 10;

// Garde-fou de fraîcheur (Baki 2026-09-26) : si la dernière sync wallet d'une room ENCORE
// ACTIVE (games.status = 'active' avec une wallet mère active) date de plus de
// STALE_SYNC_DAYS jours, ses joueurs ne passent PAS inactive sur cette base : ils sont
// « retenus » et le cron alerte l'ops. « Dernière sync » = dernière tx insérée par la sync
// (created_at), comme l'indicateur « Dernière sync wallet » de l'agent. Rooms qu'on ne
// joue plus, dont la sync arrêtée est normale : SYNC_GUARD_EXCLUDED_ROOMS.
export const STALE_SYNC_DAYS = 3;
export const SYNC_GUARD_EXCLUDED_ROOMS = ["KKPOKER", "AKS"];

export type StaleRoom = { game_id: number; room: string; last_sync: string | null };

/** Rooms encore actives dont la sync wallet est en retard de plus de STALE_SYNC_DAYS jours. */
export function staleSyncRoomsOn(db: DB, now: Date): StaleRoom[] {
  const limit = sqlNow(new Date(now.getTime() - STALE_SYNC_DAYS * 86_400_000));
  const rooms = db.prepare(`
    SELECT g.id AS game_id, g.name AS room,
      (SELECT MAX(t.created_at) FROM wallet_transactions t WHERE t.game_id = g.id AND t.source = 'sync') AS last_sync
    FROM games g
    WHERE g.status = 'active'
      AND g.name NOT IN (${SYNC_GUARD_EXCLUDED_ROOMS.map(() => "?").join(", ")})
      AND EXISTS (SELECT 1 FROM wallet_meres w WHERE w.game_id = g.id AND w.status = 'active')
    ORDER BY g.name
  `).all(...SYNC_GUARD_EXCLUDED_ROOMS) as StaleRoom[];
  return rooms.filter(r => !r.last_sync || normalizeTs(r.last_sync) < limit);
}

const WEEK_END = (col: string) => `date(${col}, '+6 days')`;

// Chaque source rend (player_id, at, start) :
//   • at    = date qui compte pour la fenêtre des 21 jours (FIN de période) ;
//   • start = date qui compte pour le désarchivage (DÉBUT de période) : un report de la
//     semaine où le joueur a été archivé ne prouve pas qu'il a joué APRÈS l'archivage.
// Règlements payés EXCLUS partout (règle Baki) : versement de part BR NEXA (tx manuelle
// liée à nexa_player_bankroll_weeks.transfer_movement_id), mouvement pool 'settlement',
// versements action/RB XPoker et leurs contre-passations.
export const ACTIVITY_SOURCES: { label: string; sql: string }[] = [
  { label: "tx wallet", sql: `SELECT player_id, COALESCE(tx_datetime, tx_date), COALESCE(tx_datetime, tx_date) FROM wallet_transactions
      WHERE (source IS NULL OR source IN ('sync','manual')) AND (status IS NULL OR status = 'active')
        AND id NOT IN (SELECT transfer_movement_id FROM nexa_player_bankroll_weeks WHERE transfer_movement_id IS NOT NULL)` },
  { label: "rake NEXA (report du club)", sql: `SELECT player_id, ${WEEK_END("week_start")}, week_start FROM nexa_affiliate_weeks
      WHERE player_id IS NOT NULL AND (COALESCE(nlh,0) <> 0 OR COALESCE(mtt,0) <> 0 OR COALESCE(plo,0) <> 0 OR COALESCE(spins,0) <> 0)` },
  { label: "rake / win-loss NEXA par compte", sql: `SELECT g.player_id, ${WEEK_END("s.week_start")}, s.week_start FROM nexa_weekly_stats s
      JOIN player_game_ids g ON g.external_id = s.member_id JOIN games gm ON gm.id = g.game_id AND gm.name = 'NEXAPOKER'
      WHERE COALESCE(s.rake,0) <> 0 OR COALESCE(s.winloss,0) <> 0` },
  { label: "win/loss NEXA saisi", sql: `SELECT player_id, ${WEEK_END("week_start")}, week_start FROM nexa_player_weekly_winloss
      WHERE COALESCE(amount,0) <> 0` },
  { label: "BR NEXA", sql: `SELECT player_id, ${WEEK_END("week_start")}, week_start FROM nexa_player_bankroll_weeks` },
  { label: "rake / win-loss XPoker", sql: `SELECT player_id, ${WEEK_END("week_start")}, week_start FROM xpoker_week_rows
      WHERE player_id IS NOT NULL AND (COALESCE(rake_chips,0) <> 0 OR COALESCE(winloss_chips,0) <> 0)` },
  { label: "chips XPoker", sql: `SELECT player_id, occurred_at, occurred_at FROM xpoker_chip_ledger l WHERE player_id IS NOT NULL
      AND kind IN ('buyin','cashout','adjustment')
      AND NOT (kind = 'adjustment' AND reverses_id IN (SELECT id FROM xpoker_chip_ledger WHERE kind IN ('action_paid','rb_paid','club_settlement')))` },
  { label: "pool AK multi-Account", sql: `SELECT player_id, COALESCE(closed_at, opened_at), opened_at FROM pool_periods
      UNION ALL SELECT player_id, occurred_at, occurred_at FROM pool_external_movements WHERE player_id IS NOT NULL AND kind = 'declared'` },
  { label: "bloc de staking QQPK", sql: `SELECT player_id, block_end, block_start FROM qqpk_staking_blocks
      WHERE COALESCE(mains,0) > 0 OR COALESCE(resultat_periode,0) <> 0` },
  { label: "session grindhouse", sql: `SELECT player_id, session_date, session_date FROM grindhouse_sessions` },
  { label: "report rakeback", sql: `SELECT re.player_id, COALESCE(rr.report_date, rr.created_at), COALESCE(rr.report_date, rr.created_at)
      FROM rakeback_entries re JOIN rakeback_reports rr ON rr.id = re.report_id
      WHERE re.player_id IS NOT NULL
        AND (COALESCE(re.amount,0) <> 0 OR COALESCE(re.insurance_amount,0) <> 0 OR COALESCE(re.winnings_amount,0) <> 0)` },
];

/**
 * Date texte → « YYYY-MM-DD HH:MM:SS » UTC comparable. Une date seule vaut son DÉBUT de
 * journée : prudent pour le désarchivage (une activité datée du jour de l'archivage ne
 * compte pas comme « nouvelle »).
 */
export function normalizeTs(raw: string): string {
  const s = String(raw).replace("T", " ").replace(/Z$/, "").slice(0, 19);
  return s.length === 10 ? `${s} 00:00:00` : s;
}

const sqlNow = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19);

type Seen = { at: string; source: string };

/**
 * Dernière activité de JEU par joueur (toutes sources) :
 *   • last      — date de FIN, plafonnée à `nowS` (une semaine en cours ou un bloc QQPK
 *                 pas encore clos ne datent pas une activité future) → fenêtre des 21 jours ;
 *   • lastStart — date de DÉBUT, seulement si elle n'est pas dans le futur → désarchivage.
 * Lève si une source est illisible (l'automate ne tourne alors pas, rien n'est écrit).
 */
export function lastActivityOn(db: DB, nowS: string): { last: Map<number, Seen>; lastStart: Map<number, Seen> } {
  const last = new Map<number, Seen>(), lastStart = new Map<number, Seen>();
  const keep = (m: Map<number, Seen>, pid: number, at: string, source: string) => {
    const cur = m.get(pid);
    if (!cur || at > cur.at) m.set(pid, { at, source });
  };
  for (const src of ACTIVITY_SOURCES) {
    for (const [pid, rawEnd, rawStart] of db.prepare(src.sql).raw().all() as [number | null, string | null, string | null][]) {
      if (pid == null || rawEnd == null) continue;
      const end = normalizeTs(rawEnd);
      keep(last, pid, end > nowS ? nowS : end, src.label);
      const start = normalizeTs(rawStart ?? rawEnd);
      if (start <= nowS) keep(lastStart, pid, start, src.label);
    }
  }
  return { last, lastStart };
}

export type StatusChange = {
  player_id: number; name: string;
  kind: "status" | "unarchive";
  old_value: string | null; new_value: string | null;
  reason: string;
  last_activity_at: string | null; last_activity_source: string | null;
};

const isActive = (s: string) => s === "active" || s === "signed";

export type HeldChange = StatusChange & { rooms: string[] };

/**
 * Bascules que l'automate ferait maintenant — sans rien écrire (test à blanc). `held` = les
 * passages en inactive retenus parce qu'une room du joueur a une sync en retard (`staleRooms`).
 */
export function planStatusAutoOn(db: DB, now: Date = new Date()):
  { now: string; cutoff: string; changes: StatusChange[]; held: HeldChange[]; staleRooms: StaleRoom[] } {
  const nowS = sqlNow(now);
  const cutoff = sqlNow(new Date(now.getTime() - WINDOW_DAYS * 86_400_000));
  const { last, lastStart } = lastActivityOn(db, nowS);
  const staleRooms = staleSyncRoomsOn(db, now);
  // Joueurs d'une room en retard : deal ouvert ou wallet de jeu sur cette room.
  const staleRoomsOf = new Map<number, string[]>();
  if (staleRooms.length) {
    const ph = staleRooms.map(() => "?").join(", ");
    const ids = staleRooms.map(r => r.game_id);
    const rows = db.prepare(`
      SELECT player_id, game_id FROM player_game_deals WHERE end_date IS NULL AND game_id IN (${ph})
      UNION SELECT player_id, game_id FROM player_wallet_games WHERE game_id IN (${ph})
    `).all(...ids, ...ids) as { player_id: number; game_id: number }[];
    for (const r of rows) {
      const room = staleRooms.find(x => x.game_id === r.game_id)!.room;
      const cur = staleRoomsOf.get(r.player_id) ?? [];
      if (!cur.includes(room)) staleRoomsOf.set(r.player_id, [...cur, room]);
    }
  }
  const held: HeldChange[] = [];
  const players = db.prepare(`SELECT id, name, status, archived_at, created_at, COALESCE(status_manual, 0) AS status_manual FROM players`).all() as
    { id: number; name: string; status: string; archived_at: string | null; created_at: string | null; status_manual: number }[];
  const changes: StatusChange[] = [];
  for (const p of players) {
    const la = last.get(p.id) ?? null;
    const recent = !!la && la.at >= cutoff;
    const isNew = !!p.created_at && normalizeTs(p.created_at) >= cutoff;
    const base = { player_id: p.id, name: p.name, last_activity_at: la?.at ?? null, last_activity_source: la?.source ?? null };

    if (!p.status_manual) {
      if ((recent || isNew) && !isActive(p.status)) {
        changes.push({ ...base, kind: "status", old_value: p.status, new_value: "active",
          reason: recent ? `activité de jeu le ${la!.at} (${la!.source})` : `nouveau joueur (créé le ${normalizeTs(p.created_at!).slice(0, 10)})` });
      } else if (!recent && !isNew && isActive(p.status)) {
        const c: StatusChange = { ...base, kind: "status", old_value: p.status, new_value: "inactive",
          reason: la ? `aucune activité de jeu depuis ${WINDOW_DAYS} jours (dernière : ${la.at}, ${la.source})` : "aucune activité de jeu enregistrée" };
        const rooms = staleRoomsOf.get(p.id);
        if (rooms) held.push({ ...c, rooms });
        else changes.push(c);
      }
    }
    // Désarchivage : une NOUVELLE activité, c'est-à-dire dont le DÉBUT est postérieur à l'archivage.
    const ls = lastStart.get(p.id);
    if (p.archived_at && ls && ls.at > normalizeTs(p.archived_at)) {
      changes.push({ ...base, kind: "unarchive", old_value: p.archived_at, new_value: null,
        last_activity_at: ls.at, last_activity_source: ls.source,
        reason: `nouvelle activité de jeu le ${ls.at} (${ls.source}), postérieure à l'archivage` });
    }
  }
  return { now: nowS, cutoff, changes, held, staleRooms };
}

export class StatusAutoGuardError extends Error {}

/** Joueurs visibles (non archivés) que le plan ferait passer inactive. */
export function visibleDeactivations(db: DB, changes: StatusChange[]): StatusChange[] {
  const archived = db.prepare(`SELECT archived_at FROM players WHERE id = ?`);
  return changes.filter(c => c.kind === "status" && c.new_value === "inactive"
    && !(archived.get(c.player_id) as { archived_at: string | null } | undefined)?.archived_at);
}

/**
 * Calcule ET applique les bascules dans UNE transaction .immediate() (tout ou rien, aucune
 * écriture d'un autre processus ne s'intercale entre le calcul et l'écriture), et les trace.
 * Rejouable : une seconde passe à la même heure ne trouve plus rien à changer.
 * Hors déclenchement « manual », refuse (StatusAutoGuardError, rien d'écrit) si plus de
 * MAX_VISIBLE_DEACTIVATIONS joueurs visibles passeraient inactive.
 */
export function applyStatusAutoOn(db: DB, trigger: "nightly" | "sunday" | "manual", now: Date = new Date()) {
  const setStatus = db.prepare(`UPDATE players SET status = ? WHERE id = ? AND status = ? AND COALESCE(status_manual, 0) = 0`);
  const log = db.prepare(`INSERT INTO player_status_changes
    (player_id, kind, old_value, new_value, reason, last_activity_at, last_activity_source, trigger, changed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  return db.transaction(() => {
    const plan = planStatusAutoOn(db, now);
    if (trigger !== "manual") {
      const vis = visibleDeactivations(db, plan.changes);
      if (vis.length > MAX_VISIBLE_DEACTIVATIONS) {
        throw new StatusAutoGuardError(`${vis.length} joueurs visibles passeraient inactive (plafond ${MAX_VISIBLE_DEACTIVATIONS}) — `
          + `sync ou import en panne ? Rien n'a été écrit. Ids : ${vis.map(c => c.player_id).join(", ")}`);
      }
    }
    let status = 0, unarchived = 0;
    for (const c of plan.changes) {
      if (c.kind === "status") {
        if (setStatus.run(c.new_value, c.player_id, c.old_value).changes !== 1) continue;
        status++;
      } else {
        if (unarchivePlayerOn(db, c.player_id, c.old_value!) !== 1) continue;
        unarchived++;
      }
      log.run(c.player_id, c.kind, c.old_value, c.new_value, c.reason, c.last_activity_at, c.last_activity_source, trigger, plan.now);
    }
    return { ...plan, applied: { status, unarchived } };
  }).immediate();
}
