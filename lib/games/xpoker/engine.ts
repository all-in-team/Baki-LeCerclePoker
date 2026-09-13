// XPoker Twd — MOTEUR : import d'une semaine, réconciliation, deals, résultats
// joueur, grand livre chips. Toute la math d'argent de la game vit ici et dans
// club-math.ts (invariant #2) ; les routes et l'écran n'en font aucune.
//
// Fonctions `…On(db, …)` : elles reçoivent la connexion, pour que les harnais
// (scripts/xpoker-e2e.test.ts) exercent LA MÊME SQL sur une base éphémère — même
// convention que lib/funnels/nexa/*.
//
// CE QUE CE MODULE NE FAIT PAS : le règlement joueur (manual_settlements,
// xpoker_settlement_weeks, mouvements 'action_paid' / 'rb_paid') — étape 4. Il
// ne lit pas non plus de fichier : il reçoit un bloc DÉJÀ PARSÉ (parse-sheet.ts)
// et une plage de dates CONFIRMÉE par Baki.

import type Database from "better-sqlite3";
import type { XpokerParsedBlock } from "./parse-sheet";
import { actionShareChips, rakebackChips, chipsToUsd, assertPct } from "./club-math";
import { XPOKER_CHECK_TOLERANCE } from "./schema";
import { XPOKER_GAME_NAME } from "./config";

type DB = Database.Database;

export function xpokerGameIdOn(db: DB): number {
  const g = db.prepare(`SELECT id FROM games WHERE name = ?`).get(XPOKER_GAME_NAME) as { id: number } | undefined;
  if (!g) throw new Error(`Game ${XPOKER_GAME_NAME} absent — la migration add_xpoker_twd_v1 n'a pas tourné.`);
  return g.id;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function assertIsoDate(s: string, what: string) {
  if (!ISO_DATE.test(s) || Number.isNaN(Date.parse(s + "T00:00:00Z"))) throw new Error(`${what} : date invalide « ${s} »`);
}
function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}
function isMonday(iso: string): boolean { return new Date(iso + "T00:00:00Z").getUTCDay() === 1; }

// ── Taux chips/USD ───────────────────────────────────────────────────────────

/** Taux en vigueur à une date : dernière date d'effet ≤ date. Jette s'il n'y en a aucune. */
export function rateAtOn(db: DB, iso: string): number {
  const r = db.prepare(
    `SELECT chips_per_usd FROM xpoker_chip_rates WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`
  ).get(iso) as { chips_per_usd: number } | undefined;
  if (!r) throw new Error(`Aucun taux chips/USD en vigueur au ${iso} — ajoute une date d'effet dans xpoker_chip_rates.`);
  return r.chips_per_usd;
}

/** Ajoute une date d'effet. Jamais de mise à jour en place : l'historique est la règle. */
export function addRateOn(db: DB, args: { effective_from: string; chips_per_usd: number; note?: string | null }): void {
  assertIsoDate(args.effective_from, "effective_from");
  if (!(args.chips_per_usd > 0)) throw new Error("chips_per_usd doit être > 0");
  db.prepare(`INSERT INTO xpoker_chip_rates (effective_from, chips_per_usd, note) VALUES (?, ?, ?)`)
    .run(args.effective_from, args.chips_per_usd, args.note ?? null);
}

// ── Comptes (Player ID) ──────────────────────────────────────────────────────

export type XpokerAccount = {
  id: number; player_id: number; member_id: string; nickname: string | null;
  status: "active" | "archived"; added_at: string | null; weeks_imported: number;
};

export function accountsForPlayerOn(db: DB, playerId: number): XpokerAccount[] {
  const gid = xpokerGameIdOn(db);
  return db.prepare(`
    SELECT g.id, g.player_id, g.external_id AS member_id, g.nickname, g.status, g.added_at,
           (SELECT COUNT(*) FROM xpoker_week_rows r WHERE r.member_id = g.external_id) AS weeks_imported
    FROM player_game_ids g WHERE g.player_id = ? AND g.game_id = ?
    ORDER BY g.status, g.added_at, g.id
  `).all(playerId, gid) as XpokerAccount[];
}

/**
 * Rattache un Player ID à un joueur — le SEUL chemin qui écrit ce lien, que ce
 * soit depuis la fiche (ajout manuel) ou depuis la réconciliation. Refuse un ID
 * agence, un ID déjà pris (par un autre joueur OU archivé chez ce joueur : on
 * réactive, on ne duplique pas). Relie aussi les semaines déjà importées sous cet
 * ID et encore orphelines — c'est ce qui fait qu'un ré-import ne perd rien.
 */
export function linkMemberIdOn(
  db: DB, args: { player_id: number; member_id: string; nickname?: string | null },
): { ok: true; account_id: number; rows_linked: number } | { ok: false; error: string } {
  const member_id = String(args.member_id ?? "").trim();
  if (!/^\d{5,}$/.test(member_id)) return { ok: false, error: `Player ID invalide « ${args.member_id} » (entier attendu)` };
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(args.player_id)) return { ok: false, error: `Joueur ${args.player_id} introuvable` };
  if (db.prepare(`SELECT 1 FROM xpoker_agency_accounts WHERE member_id = ?`).get(member_id)) {
    return { ok: false, error: `${member_id} est un compte agence : jamais rattaché à un joueur` };
  }
  const gid = xpokerGameIdOn(db);
  const existing = db.prepare(`SELECT id, player_id, status FROM player_game_ids WHERE game_id = ? AND external_id = ?`)
    .get(gid, member_id) as { id: number; player_id: number; status: string } | undefined;
  if (existing && existing.player_id !== args.player_id) {
    const other = db.prepare(`SELECT name FROM players WHERE id = ?`).get(existing.player_id) as { name: string } | undefined;
    return { ok: false, error: `${member_id} appartient déjà à ${other?.name ?? `#${existing.player_id}`}` };
  }
  const run = db.transaction(() => {
    let account_id: number;
    if (existing) {
      db.prepare(`UPDATE player_game_ids SET status = 'active', nickname = COALESCE(?, nickname) WHERE id = ?`)
        .run(args.nickname ?? null, existing.id);
      account_id = existing.id;
    } else {
      account_id = Number(db.prepare(
        `INSERT INTO player_game_ids (player_id, game_id, external_id, nickname, status, added_at) VALUES (?, ?, ?, ?, 'active', datetime('now'))`
      ).run(args.player_id, gid, member_id, args.nickname ?? null).lastInsertRowid);
    }
    const rows_linked = db.prepare(
      `UPDATE xpoker_week_rows SET player_id = ? WHERE member_id = ? AND player_id IS NULL AND is_agency = 0`
    ).run(args.player_id, member_id).changes;
    return { account_id, rows_linked };
  });
  const r = run();
  return { ok: true, ...r };
}

export type RelinkResult =
  | { ok: true; from_player_id: number; to_player_id: number; weeks: string[]; movements: number; log_id: number }
  | { ok: false; error: string; blocking?: { week_start: string; player_id: number; player_name: string; settlement_id: number }[] };

/**
 * R1 — Déplace un Player ID d'un joueur vers un autre, EXPLICITEMENT.
 *   • toutes les semaines importées sous cet ID changent de joueur (les résultats
 *     et parts d'action sont dérivés à la lecture : les deux côtés sont donc
 *     recalculés d'eux-mêmes, l'ancien perd, le nouveau gagne) ;
 *   • les buy-ins / cash-outs saisis sur ce compte suivent (un mouvement est
 *     rattaché à un COMPTE, et le compte change de propriétaire) ;
 *   • REFUS si une semaine concernée est déjà réglée (xpoker_settlement_weeks),
 *     chez l'ancien comme chez le nouveau : on rend la liste, Baki tranche ;
 *   • une ligne xpoker_relink_log est écrite dans la même transaction.
 */
export function relinkMemberIdOn(
  db: DB, args: { member_id: string; to_player_id: number; reason?: string | null; actor?: string },
): RelinkResult {
  const member_id = String(args.member_id ?? "").trim();
  const gid = xpokerGameIdOn(db);
  const acc = db.prepare(`SELECT id, player_id FROM player_game_ids WHERE game_id = ? AND external_id = ?`).get(gid, member_id) as { id: number; player_id: number } | undefined;
  if (!acc) return { ok: false, error: `Player ID ${member_id} n'est rattaché à personne — utilise le rattachement, pas le déplacement` };
  if (acc.player_id === args.to_player_id) return { ok: false, error: `Player ID ${member_id} est déjà chez ce joueur` };
  const to = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(args.to_player_id) as { id: number; name: string } | undefined;
  if (!to) return { ok: false, error: `Joueur ${args.to_player_id} introuvable` };
  const from = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(acc.player_id) as { id: number; name: string } | undefined;
  const weeks = (db.prepare(`SELECT DISTINCT week_start FROM xpoker_week_rows WHERE member_id = ? ORDER BY week_start`).all(member_id) as { week_start: string }[]).map(r => r.week_start);
  if (weeks.length > 0) {
    const ph = weeks.map(() => "?").join(", ");
    const blocking = db.prepare(`
      SELECT sw.week_start, sw.player_id, p.name AS player_name, sw.settlement_id
      FROM xpoker_settlement_weeks sw JOIN players p ON p.id = sw.player_id
      WHERE sw.player_id IN (?, ?) AND sw.week_start IN (${ph}) ORDER BY sw.week_start
    `).all(acc.player_id, args.to_player_id, ...weeks) as { week_start: string; player_id: number; player_name: string; settlement_id: number }[];
    if (blocking.length > 0) {
      return {
        ok: false, blocking,
        error: `${blocking.length} semaine(s) déjà réglée(s) bloquent le déplacement : `
             + blocking.map(b => `${b.week_start} (${b.player_name}, règlement #${b.settlement_id})`).join(", ")
             + ` — déverrouille-les d'abord, ou renonce.`,
      };
    }
  }
  const run = db.transaction(() => {
    db.prepare(`UPDATE player_game_ids SET player_id = ?, status = 'active' WHERE id = ?`).run(args.to_player_id, acc.id);
    db.prepare(`UPDATE xpoker_week_rows SET player_id = ? WHERE member_id = ? AND is_agency = 0`).run(args.to_player_id, member_id);
    const movements = db.prepare(`UPDATE xpoker_chip_ledger SET player_id = ? WHERE member_id = ? AND kind IN ('buyin','cashout')`).run(args.to_player_id, member_id).changes;
    const log = db.prepare(`
      INSERT INTO xpoker_relink_log (member_id, from_player_id, to_player_id, from_name, to_name, weeks, movements, reason, actor)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(member_id, acc.player_id, args.to_player_id, from?.name ?? null, to.name, JSON.stringify(weeks), movements, args.reason ?? null, args.actor ?? "baki");
    return { movements, log_id: Number(log.lastInsertRowid) };
  });
  const r = run();
  return { ok: true, from_player_id: acc.player_id, to_player_id: args.to_player_id, weeks, movements: r.movements, log_id: r.log_id };
}

export type RelinkLogRow = { id: number; member_id: string; from_player_id: number | null; to_player_id: number | null; from_name: string | null; to_name: string | null; weeks: string[]; movements: number; reason: string | null; actor: string; created_at: string };

export function relinkLogOn(db: DB, memberId?: string): RelinkLogRow[] {
  const rows = (memberId
    ? db.prepare(`SELECT * FROM xpoker_relink_log WHERE member_id = ? ORDER BY id DESC`).all(memberId)
    : db.prepare(`SELECT * FROM xpoker_relink_log ORDER BY id DESC LIMIT 100`).all()) as (Omit<RelinkLogRow, "weeks"> & { weeks: string })[];
  return rows.map(r => ({ ...r, weeks: JSON.parse(r.weeks) as string[] }));
}

/**
 * Ajout MANUEL d'un joueur depuis la page XPoker : ligne players + (optionnel)
 * premier Player ID via linkMemberIdOn + (optionnel) premier deal. Une seule
 * transaction : rien à moitié. Le nom n'est jamais un critère d'identité — deux
 * joueurs peuvent porter le même nom, c'est le Player ID qui identifie.
 */
export function createXpokerPlayerOn(
  db: DB, args: { name: string; telegram_handle?: string | null; member_id?: string | null; nickname?: string | null; action_pct?: number | null; rb_pct?: number | null; start_week?: string | null },
): { ok: true; player_id: number } | { ok: false; error: string } {
  const name = String(args.name ?? "").trim();
  if (!name) return { ok: false, error: "Nom requis" };
  try {
    const run = db.transaction(() => {
      const pid = Number(db.prepare(`INSERT INTO players (name, telegram_handle) VALUES (?, ?)`).run(name, args.telegram_handle?.trim() || null).lastInsertRowid);
      if (args.member_id && String(args.member_id).trim()) {
        const l = linkMemberIdOn(db, { player_id: pid, member_id: String(args.member_id), nickname: args.nickname ?? null });
        if (!l.ok) throw new Error(l.error);
      }
      if (args.action_pct !== null && args.action_pct !== undefined) {
        const d = setDealOn(db, { player_id: pid, action_pct: args.action_pct, rb_pct: args.rb_pct ?? 0, start_week: args.start_week ?? mondayOf(new Date().toISOString().slice(0, 10)) });
        if (!d.ok) throw new Error(d.error ?? "deal refusé");
      }
      return pid;
    });
    return { ok: true, player_id: run() };
  } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
}

function mondayOf(iso: string): string {
  const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10);
}

/** Archive (soft) un Player ID : l'historique reste, un import futur sous cet ID repart en réconciliation. */
export function archiveAccountOn(db: DB, accountId: number, playerId: number): { ok: boolean; error?: string } {
  const gid = xpokerGameIdOn(db);
  const r = db.prepare(`UPDATE player_game_ids SET status = 'archived' WHERE id = ? AND player_id = ? AND game_id = ?`)
    .run(accountId, playerId, gid);
  return r.changes === 1 ? { ok: true } : { ok: false, error: "compte introuvable pour ce joueur" };
}

/**
 * GARDE du DELETE générique (/api/players/[id]/game-ids) : un Player ID XPoker
 * qui porte des semaines importées ne se supprime pas — il s'archive. Sans cette
 * garde, le lien disparaît, et les lignes de xpoker_week_rows gardent un
 * player_id que plus rien ne justifie : un ré-import les renverrait en
 * réconciliation avec un résultat déjà compté. Les autres games ne sont pas
 * concernées : la garde ne s'applique qu'au game XPOKER_TWD.
 */
export function deleteGameIdRowOn(db: DB, rowId: number, playerId: number): { ok: true; deleted: number } | { ok: false; error: string } {
  const row = db.prepare(`SELECT id, game_id, external_id FROM player_game_ids WHERE id = ? AND player_id = ?`)
    .get(rowId, playerId) as { id: number; game_id: number; external_id: string } | undefined;
  if (!row) return { ok: true, deleted: 0 };
  const xp = db.prepare(`SELECT id FROM games WHERE name = ?`).get(XPOKER_GAME_NAME) as { id: number } | undefined;
  if (xp && row.game_id === xp.id) {
    const n = (db.prepare(`SELECT COUNT(*) AS n FROM xpoker_week_rows WHERE member_id = ?`).get(row.external_id) as { n: number }).n;
    if (n > 0) {
      return { ok: false, error: `Player ID ${row.external_id} porte ${n} semaine(s) importée(s) sur XPoker Twd : archive-le depuis la page XPoker, il ne se supprime pas.` };
    }
  }
  const deleted = db.prepare(`DELETE FROM player_game_ids WHERE id = ? AND player_id = ?`).run(rowId, playerId).changes;
  return { ok: true, deleted };
}

// ── Import d'une semaine ─────────────────────────────────────────────────────

export type CommitImportArgs = {
  block: XpokerParsedBlock;
  /** Plage CONFIRMÉE par Baki — lundi et dimanche ISO. Le libellé d'onglet n'est qu'une suggestion. */
  week_start: string;
  week_end: string;
  source: "xlsx" | "csv";
  filename?: string | null;
  file_hash?: string | null;
  /** Sortie explicite « écart acté » : obligatoire si le checksum est KO. Irréversible. */
  override_reason?: string | null;
  note?: string | null;
};

export type CommitImportResult =
  | { ok: true; import_id: number; rows: number; unlinked: string[]; agency: string[]; warnings: string[]; rate_chips_per_usd: number }
  | { ok: false; error: string; warnings?: string[] };

/**
 * Écrit UNE semaine : xpoker_imports + xpoker_week_rows, dans une transaction.
 * Refuse : checksum KO sans motif, semaine déjà importée, plage non lundi→dimanche,
 * aucun taux en vigueur. JAMAIS d'import partiel. Les lignes 'foreign' du bloc ne
 * sont pas écrites (elles ont déjà fait échouer le checksum si le pied les compte).
 * Résolution du joueur : player_game_ids (game XPOKER_TWD, status 'active') par
 * member_id — jamais par pseudo. Un ID archivé reste orphelin → réconciliation.
 */
export function commitImportOn(db: DB, a: CommitImportArgs): CommitImportResult {
  const b = a.block;
  const warnings = [...b.warnings];
  try { assertIsoDate(a.week_start, "week_start"); assertIsoDate(a.week_end, "week_end"); }
  catch (e: any) { return { ok: false, error: e.message }; }
  if (!isMonday(a.week_start) || addDays(a.week_start, 6) !== a.week_end) {
    return { ok: false, error: `Plage invalide : ${a.week_start} → ${a.week_end} (lundi → dimanche attendu)` };
  }
  if (!b.checks.checksum_ok && !a.override_reason?.trim()) {
    return {
      ok: false, warnings,
      error: `Checksum KO : recalcul ${b.recompute.total} ≠ Total du sheet ${b.footer.total} (écart ${b.checks.check_delta}). `
           + `Import refusé — aucune ligne écrite. Sortie possible : « importer quand même, écart acté » avec motif.`,
    };
  }
  if (db.prepare(`SELECT 1 FROM xpoker_imports WHERE week_start = ?`).get(a.week_start)) {
    return { ok: false, error: `La semaine ${a.week_start} est déjà importée. Supprime l'import existant avant de ré-importer.` };
  }
  if (b.rows.length === 0) return { ok: false, error: "Aucune ligne à importer." };

  let rate: number;
  try { rate = rateAtOn(db, a.week_end); } catch (e: any) { return { ok: false, error: e.message }; }
  const gid = xpokerGameIdOn(db);
  const agencyIds = new Set((db.prepare(`SELECT member_id FROM xpoker_agency_accounts`).all() as { member_id: string }[]).map(r => r.member_id));
  const resolve = db.prepare(`SELECT player_id FROM player_game_ids WHERE game_id = ? AND external_id = ? AND status = 'active'`);

  try {
    const run = db.transaction(() => {
      const ins = db.prepare(`
        INSERT INTO xpoker_imports (week_start, week_end, tab_label, source, filename, file_hash, club_name,
          chip_value, rb_fraction, tax_fraction, sheet_total_winloss, sheet_total_rake, sheet_tax, sheet_rb_amount, sheet_total, sheet_cleared,
          recomputed_rb, recomputed_tax, recomputed_total, check_delta, override_reason, sub_agent_present, rate_chips_per_usd, rows_total, note)
        VALUES (@week_start, @week_end, @tab_label, @source, @filename, @file_hash, @club,
          @chip_value, @rb_fraction, @tax_fraction, @twl, @trake, @stax, @srb, @stotal, @cleared,
          @rrb, @rtax, @rtotal, @delta, @override, @sub, @rate, @rows_total, @note)
      `).run({
        week_start: a.week_start, week_end: a.week_end, tab_label: b.tab_label, source: a.source,
        filename: a.filename ?? null, file_hash: a.file_hash ?? null, club: b.params.club,
        chip_value: b.params.chip_value, rb_fraction: b.params.rb_fraction, tax_fraction: b.params.tax_fraction,
        twl: b.footer.total_winloss, trake: b.footer.total_rake, stax: b.footer.tax, srb: b.footer.rb_amount, stotal: b.footer.total, cleared: b.cleared,
        rrb: b.recompute.rb, rtax: b.recompute.tax, rtotal: b.recompute.total, delta: b.checks.check_delta,
        override: b.checks.checksum_ok ? null : a.override_reason!.trim(), sub: b.checks.sub_agent_present ? 1 : 0,
        rate, rows_total: b.rows.length, note: a.note ?? null,
      });
      const import_id = Number(ins.lastInsertRowid);
      const insRow = db.prepare(`
        INSERT INTO xpoker_week_rows (import_id, week_start, member_id, id_label, nickname, agent_id, super_agent_id,
          winloss_chips, rake_chips, is_agency, is_sub_agent, player_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const unlinked: string[] = [], agency: string[] = [];
      for (const r of b.rows) {
        const is_agency = agencyIds.has(r.member_id);
        const player_id = is_agency ? null : (resolve.get(gid, r.member_id) as { player_id: number } | undefined)?.player_id ?? null;
        if (is_agency) agency.push(r.member_id); else if (player_id === null) unlinked.push(r.member_id);
        insRow.run(import_id, a.week_start, r.member_id, r.id_label, r.nickname, r.agent_id, r.super_agent_id,
          r.winloss, r.rake, is_agency ? 1 : 0, r.scope === "sub_agent" ? 1 : 0, player_id);
      }
      return { import_id, unlinked, agency };
    });
    const r = run();
    if (!b.checks.checksum_ok) warnings.push(`Écart acté (${b.checks.check_delta}) : ${a.override_reason!.trim()} — la semaine reste marquée en écart.`);
    return { ok: true, import_id: r.import_id, rows: b.rows.length, unlinked: r.unlinked, agency: r.agency, warnings, rate_chips_per_usd: rate };
  } catch (e: any) {
    // La contrainte du schéma (CHECK check_delta / UNIQUE) est le dernier rempart : rien n'est écrit.
    return { ok: false, error: e?.message ?? String(e), warnings };
  }
}

/** Supprime un import et ses lignes (cascade). Refusé si un règlement club est déjà passé au grand livre. */
export function deleteImportOn(db: DB, importId: number): { ok: boolean; error?: string } {
  const led = db.prepare(`SELECT COUNT(*) AS n FROM xpoker_chip_ledger WHERE import_id = ?`).get(importId) as { n: number };
  if (led.n > 0) return { ok: false, error: `Import #${importId} : ${led.n} mouvement(s) du grand livre le référencent — supprime-les d'abord.` };
  const r = db.prepare(`DELETE FROM xpoker_imports WHERE id = ?`).run(importId);
  return r.changes === 1 ? { ok: true } : { ok: false, error: "import introuvable" };
}

// ── Réconciliation ───────────────────────────────────────────────────────────

export type UnlinkedMember = {
  member_id: string;
  id_label: string | null;
  nickname: string | null;
  weeks: string[];
  /** Candidats PROPOSÉS (nom de joueur = R ou T, insensible à la casse). Jamais appliqués seuls. */
  candidates: { player_id: number; name: string; reason: string }[];
  /** L'ID existe chez un joueur mais ARCHIVÉ : réactiver, ou c'est quelqu'un d'autre. */
  archived_on: { player_id: number; name: string } | null;
};

export function unlinkedMembersOn(db: DB): UnlinkedMember[] {
  const gid = xpokerGameIdOn(db);
  const rows = db.prepare(`
    SELECT member_id, id_label, nickname, week_start FROM xpoker_week_rows
    WHERE player_id IS NULL AND is_agency = 0 ORDER BY member_id, week_start
  `).all() as { member_id: string; id_label: string | null; nickname: string | null; week_start: string }[];
  const byId = new Map<string, UnlinkedMember>();
  const byName = db.prepare(`SELECT id, name FROM players WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))`);
  const archived = db.prepare(`SELECT g.player_id, p.name FROM player_game_ids g JOIN players p ON p.id = g.player_id WHERE g.game_id = ? AND g.external_id = ? AND g.status = 'archived'`);
  for (const r of rows) {
    let m = byId.get(r.member_id);
    if (!m) {
      const candidates: UnlinkedMember["candidates"] = [];
      for (const [label, reason] of [[r.nickname, "nickname (T)"], [r.id_label, "ID (R)"]] as const) {
        if (!label || /^xp\d+$/i.test(label)) continue;   // « XP4136708 » n'est pas un nom
        for (const p of byName.all(label) as { id: number; name: string }[]) {
          if (!candidates.some(c => c.player_id === p.id)) candidates.push({ player_id: p.id, name: p.name, reason: `${reason} = « ${label} »` });
        }
      }
      const arch = archived.get(gid, r.member_id) as { player_id: number; name: string } | undefined;
      m = { member_id: r.member_id, id_label: r.id_label, nickname: r.nickname, weeks: [], candidates, archived_on: arch ?? null };
      byId.set(r.member_id, m);
    }
    m.weeks.push(r.week_start);
  }
  return [...byId.values()];
}

// ── Deals (versionnés par semaine) ───────────────────────────────────────────

export type XpokerDeal = { action_pct: number; rb_pct: number; start_week: string; end_week: string | null };

/**
 * Pose un deal à partir d'une semaine : la période en cours est fermée la
 * semaine d'avant, la nouvelle s'ouvre. Taux en POURCENT (10 = 10 %) — pas la
 * fraction du sheet (xpoker_imports.rb_fraction = 0.8) : l'unité est dans le nom,
 * assertPct refuse ]0, 1[ et le CHECK du schéma aussi (R2).
 *
 * UN DEAL NE RÉÉCRIT JAMAIS UNE SEMAINE DÉJÀ IMPORTÉE (faille F2, money-auditor
 * 2026-09-13) : sinon la part d'action affichée d'une semaine change après coup,
 * et à l'étape 4 elle divergerait du montant figé dans xpoker_settlement_weeks.
 * Donc, dès qu'un deal existe, start_week doit être STRICTEMENT après la dernière
 * semaine importée du joueur ET après le début de la période en cours. Seule
 * exception : le PREMIER deal, qui peut couvrir l'historique déjà importé (c'est
 * le geste normal après un import initial).
 */
export function setDealOn(db: DB, args: { player_id: number; action_pct: number; rb_pct: number; start_week: string; note?: string | null }): { ok: boolean; error?: string; blocking_weeks?: string[] } {
  assertIsoDate(args.start_week, "start_week");
  if (!isMonday(args.start_week)) return { ok: false, error: `start_week doit être un lundi (${args.start_week})` };
  // POURCENT (10 = 10 %). ]0, 1[ refusé : « 0.8 » serait la fraction du sheet déguisée (R2).
  try { assertPct(args.action_pct, "action_pct"); assertPct(args.rb_pct, "rb_pct"); }
  catch (e: any) { return { ok: false, error: e.message }; }
  const current = db.prepare(`SELECT id, start_week FROM xpoker_player_deals WHERE player_id = ? AND end_week IS NULL`).get(args.player_id) as { id: number; start_week: string } | undefined;
  const hasAny = !!db.prepare(`SELECT 1 FROM xpoker_player_deals WHERE player_id = ?`).get(args.player_id);
  if (hasAny) {
    // Refus NOMMÉ avec la LISTE des semaines qui bloquent (formulaire étape 3) : Baki
    // voit exactement ce qu'un changement rétroactif réécrirait, et choisit la
    // semaine d'effet en connaissance de cause.
    const blocking = (db.prepare(
      `SELECT DISTINCT week_start FROM xpoker_week_rows WHERE player_id = ? AND week_start >= ? ORDER BY week_start`
    ).all(args.player_id, args.start_week) as { week_start: string }[]).map(r => r.week_start);
    if (blocking.length > 0) {
      const last = blocking[blocking.length - 1];
      return {
        ok: false, blocking_weeks: blocking,
        error: `${blocking.length} semaine(s) déjà importée(s) à partir du ${args.start_week} garderaient leur deal : ${blocking.join(", ")} — `
             + `un nouveau deal commence après la dernière (${addDays(last, 7)} au plus tôt)`,
      };
    }
    if (current && args.start_week <= current.start_week) {
      return { ok: false, error: `la période en cours commence le ${current.start_week} — un deal ne se réécrit pas dans le passé` };
    }
    const closedAfter = db.prepare(`SELECT 1 FROM xpoker_player_deals WHERE player_id = ? AND end_week IS NOT NULL AND end_week >= ?`).get(args.player_id, args.start_week);
    if (closedAfter) return { ok: false, error: `une période de deal déjà fermée couvre ${args.start_week} — un deal ne se réécrit pas dans le passé` };
  }
  const run = db.transaction(() => {
    if (current) db.prepare(`UPDATE xpoker_player_deals SET end_week = ? WHERE id = ?`).run(addDays(args.start_week, -7), current.id);
    db.prepare(`INSERT INTO xpoker_player_deals (player_id, action_pct, rb_pct, start_week, note) VALUES (?, ?, ?, ?, ?)`)
      .run(args.player_id, args.action_pct, args.rb_pct, args.start_week, args.note ?? null);
  });
  run();
  return { ok: true };
}

/**
 * Pour le formulaire : la période EN COURS (valeur actuelle + depuis quand), les
 * périodes précédentes avec leurs bornes, et la première semaine d'effet possible
 * pour un changement (= lendemain de la dernière semaine importée, ou de la
 * période en cours). Aucun calcul d'argent ici.
 */
export type DealHistory = {
  current: (XpokerDeal & { id: number; note: string | null }) | null;
  previous: (XpokerDeal & { id: number; note: string | null })[];
  /** Lundi le plus tôt accepté par setDealOn (null = aucun deal encore : n'importe quel lundi). */
  earliest_change_week: string | null;
  last_imported_week: string | null;
};

export function dealHistoryOn(db: DB, playerId: number): DealHistory {
  const rows = db.prepare(
    `SELECT id, action_pct, rb_pct, start_week, end_week, note FROM xpoker_player_deals WHERE player_id = ? ORDER BY start_week DESC`
  ).all(playerId) as (XpokerDeal & { id: number; note: string | null })[];
  const current = rows.find(r => r.end_week === null) ?? null;
  const previous = rows.filter(r => r.end_week !== null);
  const last = (db.prepare(`SELECT MAX(week_start) AS w FROM xpoker_week_rows WHERE player_id = ?`).get(playerId) as { w: string | null }).w;
  let earliest: string | null = null;
  if (rows.length > 0) {
    const candidates = [last ? addDays(last, 7) : null, current ? addDays(current.start_week, 7) : null].filter((x): x is string => !!x);
    earliest = candidates.sort().pop() ?? null;
  }
  return { current, previous, earliest_change_week: earliest, last_imported_week: last };
}

export function dealForWeekOn(db: DB, playerId: number, weekStart: string): XpokerDeal | null {
  return (db.prepare(`
    SELECT action_pct, rb_pct, start_week, end_week FROM xpoker_player_deals
    WHERE player_id = ? AND start_week <= ? AND (end_week IS NULL OR end_week >= ?)
    ORDER BY start_week DESC LIMIT 1
  `).get(playerId, weekStart, weekStart) as XpokerDeal | undefined) ?? null;
}

// ── Résultats joueur ─────────────────────────────────────────────────────────

export type PlayerWeek = {
  week_start: string;
  /** Détail par compte, dans l'ordre des Player ID. */
  accounts: { member_id: string; nickname: string | null; winloss_chips: number; rake_chips: number }[];
  winloss_chips: number;
  rake_chips: number;
  rate_chips_per_usd: number;
  /** null = deal absent cette semaine-là : INCALCULABLE, pas zéro. */
  deal: XpokerDeal | null;
  action_chips: number | null;   // + = il doit à l'agence
  rb_chips: number | null;       // ≥ 0, dû au joueur, jamais notifié
  due_chips: number | null;      // action − rb
  winloss_usd: number;           // équivalents d'affichage, au taux figé de la semaine
  due_usd: number | null;
  /** Import en écart acté : semaine à traiter à la main, jamais réglable en un clic. */
  import_flagged: boolean;
};

/** Semaines d'un joueur, TOUS comptes confondus, du plus récent au plus ancien. */
export function playerWeeksOn(db: DB, playerId: number): PlayerWeek[] {
  const rows = db.prepare(`
    SELECT r.week_start, r.member_id, r.nickname, r.winloss_chips, r.rake_chips,
           i.rate_chips_per_usd, i.check_ok, i.override_reason
    FROM xpoker_week_rows r JOIN xpoker_imports i ON i.id = r.import_id
    WHERE r.player_id = ? AND r.is_agency = 0
    ORDER BY r.week_start DESC, r.member_id
  `).all(playerId) as { week_start: string; member_id: string; nickname: string | null; winloss_chips: number; rake_chips: number; rate_chips_per_usd: number; check_ok: number; override_reason: string | null }[];
  const out: PlayerWeek[] = [];
  let cur: PlayerWeek | null = null;
  for (const r of rows) {
    if (!cur || cur.week_start !== r.week_start) {
      cur = { week_start: r.week_start, accounts: [], winloss_chips: 0, rake_chips: 0, rate_chips_per_usd: r.rate_chips_per_usd,
              deal: null, action_chips: null, rb_chips: null, due_chips: null, winloss_usd: 0, due_usd: null, import_flagged: r.check_ok === 0 };
      out.push(cur);
    }
    cur.accounts.push({ member_id: r.member_id, nickname: r.nickname, winloss_chips: r.winloss_chips, rake_chips: r.rake_chips });
    cur.winloss_chips += r.winloss_chips;
    cur.rake_chips += r.rake_chips;
  }
  for (const w of out) {
    w.deal = dealForWeekOn(db, playerId, w.week_start);
    w.winloss_usd = chipsToUsd(w.winloss_chips, w.rate_chips_per_usd);
    if (w.deal) {
      // LIGNE PAR LIGNE puis somme — et non pct × Σ : identique par linéarité, mais on
      // garde la forme du §5 pour qu'un futur taux par compte ne casse rien.
      w.action_chips = w.accounts.reduce((s, a) => s + actionShareChips(a.winloss_chips, w.deal!.action_pct), 0);
      w.rb_chips = w.accounts.reduce((s, a) => s + rakebackChips(a.rake_chips, w.deal!.rb_pct), 0);
      w.due_chips = w.action_chips - w.rb_chips;
      w.due_usd = chipsToUsd(w.due_chips, w.rate_chips_per_usd);
    }
  }
  return out;
}

// ── Grand livre chips ────────────────────────────────────────────────────────

export type LedgerKind = "club_settlement" | "buyin" | "cashout" | "action_paid" | "rb_paid" | "adjustment";

export type LedgerLineArgs = {
  occurred_at: string;
  kind: "club_settlement" | "buyin" | "cashout" | "adjustment";
  direction: "in" | "out";
  chips: number;
  player_id?: number | null;
  member_id?: string | null;
  import_id?: number | null;
  note?: string | null;
};

/**
 * Mouvement manuel du grand livre (buy-in, cash-out, règlement club, ajustement).
 * Le sens est imposé par la nature : buy-in = 'out' (je crédite le joueur),
 * cash-out = 'in' (il me rend des chips). Le règlement club et l'ajustement
 * portent leur sens. Le taux est figé à la date du mouvement — affichage seulement.
 * 'action_paid' / 'rb_paid' ne passent PAS ici : ils naissent au markPaid (étape 4).
 */
export function addLedgerLineOn(db: DB, a: LedgerLineArgs): { ok: true; id: number } | { ok: false; error: string } {
  try { assertIsoDate(a.occurred_at.slice(0, 10), "occurred_at"); } catch (e: any) { return { ok: false, error: e.message }; }
  if (!(a.chips > 0)) return { ok: false, error: "chips doit être > 0 (le sens est porté par direction)" };
  if (a.kind === "buyin" && a.direction !== "out") return { ok: false, error: "un buy-in SORT du stock agence (direction 'out')" };
  if (a.kind === "cashout" && a.direction !== "in") return { ok: false, error: "un cash-out ENTRE dans le stock agence (direction 'in')" };
  if ((a.kind === "buyin" || a.kind === "cashout")) {
    if (!a.player_id || !a.member_id) return { ok: false, error: "buy-in / cash-out : joueur ET Player ID requis" };
    const gid = xpokerGameIdOn(db);
    const owns = db.prepare(`SELECT 1 FROM player_game_ids WHERE game_id = ? AND external_id = ? AND player_id = ?`).get(gid, a.member_id, a.player_id);
    if (!owns) return { ok: false, error: `Player ID ${a.member_id} n'appartient pas au joueur ${a.player_id}` };
  }
  if (a.kind === "club_settlement") {
    // Toujours adossé à un import (F1) : un règlement club « libre » se ressaisirait à l'infini.
    if (!a.import_id) return { ok: false, error: "un règlement club se rattache à l'import de sa semaine (import_id requis)" };
    if (!db.prepare(`SELECT 1 FROM xpoker_imports WHERE id = ?`).get(a.import_id)) return { ok: false, error: `import #${a.import_id} introuvable` };
  }
  let rate: number;
  try { rate = rateAtOn(db, a.occurred_at.slice(0, 10)); } catch (e: any) { return { ok: false, error: e.message }; }
  try {
    const r = db.prepare(`
      INSERT INTO xpoker_chip_ledger (occurred_at, kind, direction, chips, rate_chips_per_usd, player_id, member_id, import_id, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(a.occurred_at, a.kind, a.direction, a.chips, rate,
      a.kind === "club_settlement" ? null : a.player_id ?? null, a.kind === "club_settlement" ? null : a.member_id ?? null,
      a.import_id ?? null, a.note ?? null);
    return { ok: true, id: Number(r.lastInsertRowid) };
  } catch (e: any) { return { ok: false, error: e?.message ?? String(e) }; }
}

export type AgencyStock = { in_chips: number; out_chips: number; stock_chips: number; by_kind: Record<string, { in: number; out: number }> };

/** Stock de jetons de l'agence = Σ in − Σ out, toutes lignes. C'est UN compteur ; la position d'un joueur en est un autre. */
export function agencyStockOn(db: DB): AgencyStock {
  const rows = db.prepare(`SELECT kind, direction, SUM(chips) AS chips FROM xpoker_chip_ledger GROUP BY kind, direction`).all() as { kind: string; direction: "in" | "out"; chips: number }[];
  const out: AgencyStock = { in_chips: 0, out_chips: 0, stock_chips: 0, by_kind: {} };
  for (const r of rows) {
    out.by_kind[r.kind] ??= { in: 0, out: 0 };
    out.by_kind[r.kind][r.direction] += r.chips;
    if (r.direction === "in") out.in_chips += r.chips; else out.out_chips += r.chips;
  }
  out.stock_chips = out.in_chips - out.out_chips;
  return out;
}

export type PlayerMovements = { buyin_chips: number; cashout_chips: number; lines: { id: number; occurred_at: string; kind: string; direction: string; chips: number; member_id: string | null; rate_chips_per_usd: number; note: string | null }[] };

/** Mouvements d'un joueur — trésorerie, jamais dans un règlement (règle NEXA, Baki Q11). */
export function playerMovementsOn(db: DB, playerId: number): PlayerMovements {
  const lines = db.prepare(`
    SELECT id, occurred_at, kind, direction, chips, member_id, rate_chips_per_usd, note
    FROM xpoker_chip_ledger WHERE player_id = ? ORDER BY occurred_at DESC, id DESC
  `).all(playerId) as PlayerMovements["lines"];
  return {
    buyin_chips: lines.filter(l => l.kind === "buyin").reduce((s, l) => s + l.chips, 0),
    cashout_chips: lines.filter(l => l.kind === "cashout").reduce((s, l) => s + l.chips, 0),
    lines,
  };
}

/** Import : ce que le sheet dit, ce que Baki a confirmé (grand livre), et l'écart entre les deux. */
export function importSettlementStatusOn(db: DB, importId: number): { sheet_total: number; sheet_cleared: number | null; ledger_chips: number | null; matches_sheet: boolean | null } {
  const i = db.prepare(`SELECT sheet_total, sheet_cleared FROM xpoker_imports WHERE id = ?`).get(importId) as { sheet_total: number; sheet_cleared: number | null } | undefined;
  if (!i) throw new Error(`import #${importId} introuvable`);
  const l = db.prepare(`SELECT direction, chips FROM xpoker_chip_ledger WHERE import_id = ? AND kind = 'club_settlement'`).get(importId) as { direction: "in" | "out"; chips: number } | undefined;
  const ledger_chips = l ? (l.direction === "in" ? l.chips : -l.chips) : null;
  return { sheet_total: i.sheet_total, sheet_cleared: i.sheet_cleared, ledger_chips, matches_sheet: ledger_chips === null ? null : Math.abs(ledger_chips - i.sheet_total) <= XPOKER_CHECK_TOLERANCE };
}
