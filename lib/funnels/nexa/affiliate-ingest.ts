// Écriture des semaines du report d'affiliation NEXA — CHEMIN UNIQUE.
//
// Toute donnée entrant dans `nexa_affiliate_weeks` passe par `commitWeek`. La
// saisie manuelle y arrive aujourd'hui ; un import XLSX y arrivera demain sans
// une ligne de plus : les deux produisent des `RawAffiliateRow` (contrat défini
// dans ./affiliate-deal) et subissent la MÊME validation. Ne pas ouvrir de
// second chemin d'écriture — ce serait rouvrir la porte à deux vérités.
//
// Découpage volontaire :
//   ./affiliate-deal  = PUR (grammaire du deal, recalcul, tolérance). Testable seul.
//   ce fichier        = base de données (résolution des joueurs, diff, transaction).
//
// Chaque fonction publique existe en deux formes : `x()` qui prend la base de
// prod via getDb(), et `xOn(db, …)` qui prend une base explicite. La seconde
// n'est pas un détour de confort : elle permet aux tests de travailler sur une
// base jetable réelle, donc de vérifier les contraintes SQL (index UNIQUE,
// CHECK de tolérance, colonnes générées) au lieu de les supposer.
import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import {
  validateRow,
  type RawAffiliateRow,
  type RowVerdict,
  type Variant,
} from "./affiliate-deal";

type DB = BetterSqlite3.Database;

/** Le report vit sous ce game ; `player_game_ids` porte le lien joueur ↔ Member ID. */
export const NEXA_GAME_NAME = "NEXAPOKER";

// ── Clés ──────────────────────────────────────────────────────────────────
// `nickname_key` et `row_key` doivent correspondre EXACTEMENT à ce que la base
// calcule (row_key est une colonne générée). Un écart silencieux ici créerait
// des doublons que l'index UNIQUE ne verrait pas venir — d'où un test dédié qui
// compare la valeur JS à celle relue depuis SQLite.

/** Insensible à la casse et aux espaces de bord — le report n'est pas régulier. */
export function nicknameKey(nickname: string): string {
  return String(nickname ?? "").trim().toLowerCase();
}

/** Miroir JS de la colonne générée `nexa_affiliate_weeks.row_key`. */
export function computeRowKey(memberId: string | null | undefined, nickKey: string): string {
  const id = String(memberId ?? "").trim();
  return id !== "" ? id : `nick:${nickKey}`;
}

/** Semaine = date du lundi, en ISO. Refuse tout le reste plutôt que de recaler. */
export function isMondayISO(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return false;
  if (d.toISOString().slice(0, 10) !== s) return false; // rejette 2026-02-31
  return d.getUTCDay() === 1;
}

// ── Résolution des joueurs ────────────────────────────────────────────────

export type ResolvedBy = "member_id" | "nickname";

export type ResolvedRow = {
  raw: RawAffiliateRow;
  verdict: RowVerdict;
  nickname_key: string;
  row_key: string;
  player_id: number | null;
  resolved_by: ResolvedBy | null;
  /**
   * Piste pour l'écran de réconciliation quand la résolution a échoué —
   * JAMAIS appliquée automatiquement. Cas typique : un Member ID inconnu alors
   * que le pseudo, lui, est déjà rattaché.
   */
  hint: { player_id: number; via: ResolvedBy } | null;
};

/**
 * Rattache chaque ligne à un joueur, sans jamais deviner.
 *
 * Ordre : Member ID (`player_game_ids`, game NEXAPOKER) → pseudo
 * (`nexa_nickname_links`) → rien.
 *
 * Le pseudo n'est un recours QUE si la ligne n'a pas de Member ID. Un ID présent
 * mais inconnu ne bascule pas sur le pseudo : l'ID est l'identité forte, et un
 * pseudo peut changer de main. La ligne part en réconciliation avec le pseudo
 * correspondant en `hint`, à valider à la main.
 *
 * Cette fonction ne CRÉE jamais de joueur, ni de lien. Écrire dans `players`,
 * `player_game_ids` ou `nexa_nickname_links` est le rôle de l'écran de
 * réconciliation, sur action explicite.
 */
export function resolveRowsOn(db: DB, rows: RawAffiliateRow[]): ResolvedRow[] {
  const game = db.prepare(`SELECT id FROM games WHERE name = ?`).get(NEXA_GAME_NAME) as { id: number } | undefined;
  if (!game) throw new Error(`Game ${NEXA_GAME_NAME} absent — la migration add_nexa_affiliate_v1 n'a pas tourné.`);

  const byMemberId = db.prepare(
    `SELECT player_id FROM player_game_ids WHERE game_id = ? AND external_id = ?`
  );
  const byNickname = db.prepare(`SELECT player_id FROM nexa_nickname_links WHERE nickname_key = ?`);

  return rows.map(raw => {
    const nickKey = nicknameKey(raw?.nickname ?? "");
    const memberId = String(raw?.member_id ?? "").trim();
    const rowKey = computeRowKey(memberId, nickKey);

    let player_id: number | null = null;
    let resolved_by: ResolvedBy | null = null;
    let hint: ResolvedRow["hint"] = null;

    if (memberId !== "") {
      const hit = byMemberId.get(game.id, memberId) as { player_id: number } | undefined;
      if (hit) { player_id = hit.player_id; resolved_by = "member_id"; }
      else {
        const viaNick = byNickname.get(nickKey) as { player_id: number } | undefined;
        if (viaNick) hint = { player_id: viaNick.player_id, via: "nickname" };
      }
    } else {
      const hit = byNickname.get(nickKey) as { player_id: number } | undefined;
      if (hit) { player_id = hit.player_id; resolved_by = "nickname"; }
    }

    return { raw, verdict: validateRow(raw), nickname_key: nickKey, row_key: rowKey, player_id, resolved_by, hint };
  });
}

export function resolveRows(rows: RawAffiliateRow[]): ResolvedRow[] {
  return resolveRowsOn(getDb(), rows);
}

// ── Lecture d'une semaine ─────────────────────────────────────────────────

export type StoredWeekRow = {
  id: number;
  week_start: string;
  member_id: string | null;
  nickname: string;
  nickname_key: string;
  row_key: string;
  player_id: number | null;
  deal_text: string;
  nlh: number; mtt: number; plo: number; spins: number;
  rate_nlh: number; rate_mtt: number; rate_plo: number; rate_spins: number;
  affiliate_payment: number;
  affiliate_payment_recomputed: number;
  check_delta: number;
  check_ok: number;
  override_reason: string | null;
};

export function getWeekRowsOn(db: DB, weekStart: string): StoredWeekRow[] {
  return db.prepare(
    `SELECT id, week_start, member_id, nickname, nickname_key, row_key, player_id, deal_text,
            nlh, mtt, plo, spins, rate_nlh, rate_mtt, rate_plo, rate_spins,
            affiliate_payment, affiliate_payment_recomputed, check_delta, check_ok, override_reason
     FROM nexa_affiliate_weeks WHERE week_start = ? ORDER BY nickname_key`
  ).all(weekStart) as StoredWeekRow[];
}

export function getWeekRows(weekStart: string): StoredWeekRow[] {
  return getWeekRowsOn(getDb(), weekStart);
}

// ── Joueurs déjà vus — alimente l'autocomplétion de la grille ─────────────

export type KnownEntrant = {
  nickname: string;
  nickname_key: string;
  member_id: string | null;
  player_id: number | null;
  /** Dernier deal utilisé pour ce pseudo : bien meilleur défaut que le défaut global. */
  last_deal_text: string | null;
};

/**
 * Tout ce qui a déjà été saisi ou rattaché, pour proposer sans jamais imposer.
 * Union de trois sources : les lignes déjà enregistrées, les liens par pseudo et
 * les liens par Member ID. Purement indicatif — sélectionner une proposition
 * pré-remplit des champs que l'opérateur reste libre de corriger.
 */
export function getKnownEntrantsOn(db: DB): KnownEntrant[] {
  const rows = db.prepare(`
    SELECT w.nickname, w.nickname_key, w.member_id, w.player_id, w.deal_text AS last_deal_text
    FROM nexa_affiliate_weeks w
    JOIN (SELECT nickname_key, MAX(week_start) AS mx FROM nexa_affiliate_weeks GROUP BY nickname_key) last
      ON last.nickname_key = w.nickname_key AND last.mx = w.week_start
    GROUP BY w.nickname_key

    UNION

    SELECT p.name, l.nickname_key, NULL, l.player_id, NULL
    FROM nexa_nickname_links l JOIN players p ON p.id = l.player_id
    WHERE l.nickname_key NOT IN (SELECT nickname_key FROM nexa_affiliate_weeks)

    UNION

    SELECT p.name, LOWER(TRIM(p.name)), g.external_id, g.player_id, NULL
    FROM player_game_ids g
    JOIN players p ON p.id = g.player_id
    JOIN games gm ON gm.id = g.game_id AND gm.name = 'NEXAPOKER'
    WHERE g.external_id NOT IN (SELECT COALESCE(member_id, '') FROM nexa_affiliate_weeks)

    ORDER BY 2
  `).all() as KnownEntrant[];
  return rows;
}

export function getKnownEntrants(): KnownEntrant[] {
  return getKnownEntrantsOn(getDb());
}

// ── Diff & commit ─────────────────────────────────────────────────────────

export type RowRejection = {
  row_key: string | null;
  nickname: string;
  code: string;
  message: string;
};

export type WeekDiff = {
  added: string[];
  modified: { row_key: string; changes: string[] }[];
  unchanged: string[];
  /** Supprimées SUR DEMANDE EXPLICITE (opts.deletions). */
  deleted: string[];
  /**
   * En base, absentes de la soumission, et non listées en suppression.
   * BLOQUANT : une ligne ne disparaît jamais parce qu'on a oublié de la renvoyer.
   */
  orphans: string[];
  rejected: RowRejection[];
  /** row_key présents deux fois dans la soumission — les deux sont refusés. */
  duplicates: string[];
};

export type CommitOptions = {
  source?: "manual" | "xlsx";
  actor?: string;
  batchId?: string | null;
  filename?: string | null;
  fileHash?: string | null;
  note?: string | null;
  /**
   * Motifs d'écart, par row_key. SEUL `payment_mismatch` peut être forcé, et
   * seulement avec un motif non vide : le screenshot NEXA peut être incohérent
   * avec lui-même. La ligne est alors écrite avec check_ok = 0 et coupe la
   * chaîne de makeup du joueur.
   */
  overrides?: Record<string, string>;
  /** row_key à supprimer de la semaine. Suppression explicite, jamais par omission. */
  deletions?: string[];
  /**
   * Écrit les lignes valides et journalise les rejets au lieu de tout refuser.
   * Défaut false = strict, adapté à la saisie manuelle (on corrige la cellule).
   * Prévu pour un futur import XLSX de masse, où bloquer 200 lignes pour une
   * seule fautive serait absurde.
   */
  allowPartial?: boolean;
};

export type CommitFailure =
  | "invalid_week"
  | "no_game"
  | "duplicate_row_key"
  | "validation"
  | "orphans";

export type CommitResult =
  | { ok: true; entry_id: number; diff: WeekDiff; written: number }
  | { ok: false; reason: CommitFailure; message: string; diff: WeekDiff };

const MONEY_EPS = 1e-9;
const sameNum = (a: number, b: number) => Math.abs(a - b) < MONEY_EPS;

/** Champs comparés pour distinguer « modifiée » de « inchangée ». */
function diffFields(before: StoredWeekRow, after: ResolvedRow): string[] {
  const r = after.raw;
  const changes: string[] = [];
  if ((before.member_id ?? "") !== String(r.member_id ?? "").trim()) changes.push("member_id");
  if (before.nickname !== r.nickname) changes.push("nickname");
  if (before.deal_text !== r.deal_text) changes.push("deal_text");
  for (const v of ["nlh", "mtt", "plo", "spins"] as Variant[]) {
    if (!sameNum(before[v], r[v])) changes.push(v);
  }
  if (!sameNum(before.affiliate_payment, r.affiliate_payment)) changes.push("affiliate_payment");
  return changes;
}

/**
 * Calcule le diff d'une semaine SANS RIEN ÉCRIRE.
 * Alimente le récapitulatif « X modifiées · Y ajoutées · Z SUPPRIMÉES » affiché
 * avant validation, et la liste des erreurs par ligne.
 */
export function previewWeekOn(db: DB, weekStart: string, rows: RawAffiliateRow[], opts: CommitOptions = {}): WeekDiff {
  const resolved = resolveRowsOn(db, rows);
  const existing = getWeekRowsOn(db, weekStart);
  const existingByKey = new Map(existing.map(r => [r.row_key, r]));
  const deletions = new Set(opts.deletions ?? []);
  const overrides = opts.overrides ?? {};

  const diff: WeekDiff = {
    added: [], modified: [], unchanged: [], deleted: [], orphans: [], rejected: [], duplicates: [],
  };

  // Doublon de row_key DANS la soumission : deux homonymes sans Member ID. On ne
  // peut pas les distinguer, donc on ne tranche pas — les deux sont refusés.
  const seen = new Map<string, number>();
  for (const r of resolved) seen.set(r.row_key, (seen.get(r.row_key) ?? 0) + 1);
  const dupKeys = new Set([...seen.entries()].filter(([, n]) => n > 1).map(([k]) => k));
  diff.duplicates = [...dupKeys];

  const submitted = new Set<string>();
  for (const r of resolved) {
    submitted.add(r.row_key);
    if (dupKeys.has(r.row_key)) {
      diff.rejected.push({
        row_key: r.row_key, nickname: r.raw.nickname, code: "duplicate_row_key",
        message: `« ${r.raw.nickname} » apparaît deux fois pour la même clé (${r.row_key}) — ` +
                 `impossible de savoir quelle ligne est laquelle. Renseigne un Member ID pour les distinguer.`,
      });
      continue;
    }

    if (!r.verdict.ok) {
      // Un écart de recalcul est le SEUL rejet forçable, et avec motif non vide.
      const reason = overrides[r.row_key];
      const forcible = r.verdict.code === "payment_mismatch" && typeof reason === "string" && reason.trim() !== "";
      if (!forcible) {
        diff.rejected.push({
          row_key: r.row_key, nickname: r.raw.nickname, code: r.verdict.code, message: r.verdict.message,
        });
        continue;
      }
    }

    const before = existingByKey.get(r.row_key);
    if (!before) { diff.added.push(r.row_key); continue; }
    const changes = diffFields(before, r);
    if (changes.length === 0) diff.unchanged.push(r.row_key);
    else diff.modified.push({ row_key: r.row_key, changes });
  }

  for (const key of existingByKey.keys()) {
    if (deletions.has(key)) diff.deleted.push(key);
    else if (!submitted.has(key)) diff.orphans.push(key);
  }

  return diff;
}

export function previewWeek(weekStart: string, rows: RawAffiliateRow[], opts: CommitOptions = {}): WeekDiff {
  return previewWeekOn(getDb(), weekStart, rows, opts);
}

/**
 * Écrit une semaine. Tout ou rien : une seule transaction, aucun état partiel.
 *
 * Refuse (sans rien écrire) si :
 *   • la semaine n'est pas un lundi ISO ;
 *   • le game NEXAPOKER est absent ;
 *   • deux lignes partagent la même clé ;
 *   • une ligne est invalide et n'est pas forçable (hors mode allowPartial) ;
 *   • des lignes en base ne sont ni resoumises ni explicitement supprimées.
 *
 * Le dernier point est la garde anti-omission : avec une grille éditable, ne pas
 * renvoyer une ligne est indistinguable d'un oubli. Supprimer exige de le dire.
 */
export function commitWeekOn(db: DB, weekStart: string, rows: RawAffiliateRow[], opts: CommitOptions = {}): CommitResult {
  const empty: WeekDiff = { added: [], modified: [], unchanged: [], deleted: [], orphans: [], rejected: [], duplicates: [] };

  if (!isMondayISO(weekStart)) {
    return { ok: false, reason: "invalid_week", diff: empty,
      message: `Semaine « ${weekStart} » invalide — attendu la date d'un LUNDI au format YYYY-MM-DD.` };
  }
  const game = db.prepare(`SELECT id FROM games WHERE name = ?`).get(NEXA_GAME_NAME) as { id: number } | undefined;
  if (!game) {
    return { ok: false, reason: "no_game", diff: empty,
      message: `Game ${NEXA_GAME_NAME} absent — la migration add_nexa_affiliate_v1 n'a pas tourné.` };
  }

  const diff = previewWeekOn(db, weekStart, rows, opts);
  const allowPartial = opts.allowPartial === true;

  if (diff.duplicates.length > 0) {
    return { ok: false, reason: "duplicate_row_key", diff,
      message: `Clés en double dans la saisie : ${diff.duplicates.join(", ")}. Aucune ligne n'a été écrite.` };
  }
  if (diff.rejected.length > 0 && !allowPartial) {
    return { ok: false, reason: "validation", diff,
      message: `${diff.rejected.length} ligne(s) en erreur — corrige-les ou justifie l'écart. Aucune ligne n'a été écrite.` };
  }
  if (diff.orphans.length > 0) {
    return { ok: false, reason: "orphans", diff,
      message: `${diff.orphans.length} ligne(s) déjà enregistrée(s) ne sont pas dans la saisie : ` +
               `${diff.orphans.join(", ")}. Pour les retirer, demande-le explicitement — ` +
               `une ligne ne disparaît jamais par omission.` };
  }

  const resolved = resolveRowsOn(db, rows);
  const rejectedKeys = new Set(diff.rejected.map(r => r.row_key));
  const toWrite = resolved.filter(r => !rejectedKeys.has(r.row_key));
  const overrides = opts.overrides ?? {};

  const insEntry = db.prepare(`
    INSERT INTO nexa_affiliate_entries
      (week_start, source, actor, batch_id, filename, file_hash, rows_total, rows_ok, rows_rejected, rejects, note)
    VALUES (@week_start, @source, @actor, @batch_id, @filename, @file_hash, @rows_total, @rows_ok, @rows_rejected, @rejects, @note)
  `);
  const delRow = db.prepare(`DELETE FROM nexa_affiliate_weeks WHERE week_start = ? AND row_key = ?`);
  const insRow = db.prepare(`
    INSERT INTO nexa_affiliate_weeks
      (entry_id, week_start, member_id, nickname, nickname_key, player_id, affiliate, deal_text,
       nlh, mtt, plo, spins, rate_nlh, rate_mtt, rate_plo, rate_spins,
       affiliate_payment, affiliate_payment_recomputed, check_delta, override_reason)
    VALUES (@entry_id, @week_start, @member_id, @nickname, @nickname_key, @player_id, NULL, @deal_text,
            @nlh, @mtt, @plo, @spins, @rate_nlh, @rate_mtt, @rate_plo, @rate_spins,
            @affiliate_payment, @recomputed, @delta, @override_reason)
  `);

  const run = db.transaction(() => {
    const info = insEntry.run({
      week_start: weekStart,
      source: opts.source ?? "manual",
      actor: opts.actor ?? "baki",
      batch_id: opts.batchId ?? null,
      filename: opts.filename ?? null,
      file_hash: opts.fileHash ?? null,
      rows_total: rows.length,
      rows_ok: toWrite.length,
      rows_rejected: diff.rejected.length,
      rejects: diff.rejected.length ? JSON.stringify(diff.rejected) : null,
      note: opts.note ?? null,
    });
    const entryId = Number(info.lastInsertRowid);

    for (const key of diff.deleted) delRow.run(weekStart, key);

    for (const r of toWrite) {
      // Re-saisie d'une ligne existante = correction : on remplace, on n'empile pas.
      delRow.run(weekStart, r.row_key);

      // Les taux et le recalcul viennent du verdict — jamais recalculés ici, sous
      // peine d'avoir deux implémentations de la même règle.
      const v = r.verdict;
      const rates = v.ok ? v.rates : { nlh: 0, mtt: 0, plo: 0, spins: 0 };
      const recomputed = v.ok ? v.recomputed : (v.expected ?? 0);
      const delta = v.ok ? v.delta : (v.delta ?? 0);
      const memberId = String(r.raw.member_id ?? "").trim();

      insRow.run({
        entry_id: entryId,
        week_start: weekStart,
        member_id: memberId === "" ? null : memberId,
        nickname: r.raw.nickname,
        nickname_key: r.nickname_key,
        player_id: r.player_id,
        deal_text: r.raw.deal_text,
        nlh: r.raw.nlh, mtt: r.raw.mtt, plo: r.raw.plo, spins: r.raw.spins,
        rate_nlh: rates.nlh, rate_mtt: rates.mtt, rate_plo: rates.plo, rate_spins: rates.spins,
        affiliate_payment: r.raw.affiliate_payment,
        recomputed,
        delta,
        override_reason: overrides[r.row_key]?.trim() || null,
      });
    }
    return entryId;
  });

  const entry_id = run();
  return { ok: true, entry_id, diff, written: toWrite.length };
}

export function commitWeek(weekStart: string, rows: RawAffiliateRow[], opts: CommitOptions = {}): CommitResult {
  return commitWeekOn(getDb(), weekStart, rows, opts);
}
