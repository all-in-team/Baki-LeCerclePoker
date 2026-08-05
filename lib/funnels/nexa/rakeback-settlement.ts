// Règlement du RAKEBACK NEXAPOKER — second flux de règlement de la room.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QUI SE RÈGLE : le rakeback dû au joueur sur une PLAGE CONTIGUË de semaines.
//   amount_due_usdt = Σ due des semaines couvertes.
// Pas la part d'action (flux séparé, ./action-settlement), pas les mouvements.
//
// LE MONTANT EST RECALCULÉ PAR LE MOTEUR AU LOCK. L'écran envoie une plage, jamais
// des montants : ce qu'il affichait a pu être calculé sur un report corrigé depuis.
//
// ── DÉCISION 1 : LA PLAGE EST CONTIGUË, ET COMMENCE À LA PREMIÈRE SEMAINE NON
// RÉGLÉE. ────────────────────────────────────────────────────────────────────
// Le rakeback n'est pas une somme de semaines indépendantes : le makeup d'une
// semaine ENTRE dans l'assiette de la suivante. Régler la semaine 5 en laissant la
// 4 ouverte n'a donc pas de sens — la 5 a été calculée avec un makeup venu de la 4,
// et « remettre le makeup à zéro sur la période réglée » deviendrait indéfinissable
// (à zéro à partir d'où ?). On exige donc une plage qui part de la plus ancienne
// semaine non réglée. Le règlement d'action, lui, accepte des semaines éparses :
// il n'a pas de chaînage. (Écart assumé entre les deux flux, il vient du domaine.)
//
// ── DÉCISION 2 : LES SEMAINES À DÛ NUL SONT COUVERTES, ET ENREGISTRÉES. ──────
// Une semaine à 0 ne produit pas de règlement à elle seule — c'est la règle du
// module action, et elle tient. Mais À L'INTÉRIEUR d'une plage, une semaine à dû
// nul DOIT être enregistrée : c'est elle qui porte le makeup consommé, et sans sa
// ligne la plage aurait un trou que rien n'expliquerait à la relecture. On refuse
// en revanche un règlement dont le TOTAL est nul : ce n'est pas un paiement.
//
// SENS DU MONTANT : positif = à verser au joueur. Le rakeback est de l'argent qui
// SORT — c'est l'inverse de la part d'action, où positif = le joueur doit au
// Cercle. Le hub /payments distingue les deux par `kind`, jamais par le signe.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import { NEXA_GAME_NAME } from "./affiliate-ingest";
import { getNexaPlayerDetailOn } from "./players";
import type { WeekResult } from "./rakeback-engine";

type DB = BetterSqlite3.Database;

const EPS = 0.0000001;

function gameId(db: DB): number {
  const g = db.prepare(`SELECT id FROM games WHERE name = ?`).get(NEXA_GAME_NAME) as { id: number } | undefined;
  if (!g) throw new Error(`Game ${NEXA_GAME_NAME} absent — la migration add_nexa_affiliate_v1 n'a pas tourné.`);
  return g.id;
}

/** Semaines de rakeback déjà réglées → le règlement qui les porte. */
export function getSettledRbWeeksOn(db: DB, playerId: number): Map<string, number> {
  const rows = db.prepare(
    `SELECT week_start, settlement_id FROM nexa_rakeback_settlement_weeks WHERE player_id = ?`
  ).all(playerId) as { week_start: string; settlement_id: number }[];
  return new Map(rows.map(r => [r.week_start, r.settlement_id]));
}

/**
 * Dernière semaine dont le rakeback est réglé — la borne de remise à zéro du
 * makeup, passée au moteur. C'est CETTE fonction qui ferme la boucle entre le
 * règlement et le calcul.
 */
export function getRbSettledThroughOn(db: DB, playerId: number): string | null {
  const r = db.prepare(
    `SELECT MAX(week_start) AS w FROM nexa_rakeback_settlement_weeks WHERE player_id = ?`
  ).get(playerId) as { w: string | null } | undefined;
  return r?.w ?? null;
}

export type RbSettleableWeek = {
  week_start: string;
  basis: string;
  rakeback_pct: number;
  base: number;
  makeup_in: number;
  base_net: number;
  due: number;
  makeup_out: number;
};

function toSettleable(w: WeekResult): RbSettleableWeek {
  return {
    week_start: w.week_start, basis: w.basis, rakeback_pct: w.rakeback_pct,
    base: w.base, makeup_in: w.makeup_in, base_net: w.base_net,
    due: w.due, makeup_out: w.makeup_out,
  };
}

/**
 * Semaines de rakeback ouvertes, dans l'ordre — la plage réglable commence
 * forcément à la première d'entre elles (décision 1).
 *
 * Exclues : les semaines déjà réglées et celles dont le contrôle a échoué (le
 * moteur les sort du calcul, elles n'ont pas de dû fiable). Les semaines à dû nul
 * RESTENT : elles portent le makeup.
 */
export function getOpenRbWeeksOn(db: DB, playerId: number): RbSettleableWeek[] {
  const d = getNexaPlayerDetailOn(db, playerId);
  if (!d) return [];
  const settled = getSettledRbWeeksOn(db, playerId);
  return d.weeks
    .filter(w => w.status === "ok" && !settled.has(w.week_start))
    .map(toSettleable);
}

export function getOpenRbWeeks(playerId: number): RbSettleableWeek[] {
  return getOpenRbWeeksOn(getDb(), playerId);
}

// ── Avertissements ────────────────────────────────────────────────────────────

export type SettlementWarning = { code: string; message: string };

/**
 * Ce qu'il faut avoir VU avant de régler.
 *
 * Un règlement ne doit jamais passer en silence au-dessus d'un contrôle en échec :
 * une semaine dont le recalcul ne retombe pas sur le report a une assiette dont on
 * sait qu'elle est fausse, et régler la suite revient à bâtir sur elle. On
 * n'INTERDIT pas — un écart accepté avec motif (arrondi NEXA) est un cas réel et
 * ne doit pas bloquer le joueur à vie — mais on exige que ce soit vu et confirmé.
 *
 * « Contient OU SUIT » : une semaine en échec ANTÉRIEURE à la plage compte aussi.
 * C'est elle qui a coupé la chaîne de makeup en amont ; régler ce qui vient après
 * sans le savoir, c'est régler sur une chaîne rompue sans le savoir.
 */
export function getRbSettlementWarningsOn(
  db: DB, playerId: number, rangeEnd: string,
): SettlementWarning[] {
  const d = getNexaPlayerDetailOn(db, playerId);
  if (!d) return [];
  const out: SettlementWarning[] = [];

  const blocked = d.weeks.filter(w => w.status === "blocked" && w.week_start <= rangeEnd);
  if (blocked.length > 0) {
    out.push({
      code: "blocked_weeks",
      message: `${blocked.length} semaine(s) en échec de contrôle jusqu'au ${rangeEnd} : `
             + `${blocked.map(w => w.week_start).join(", ")}. Leur assiette n'est pas fiable, `
             + `elles sont hors du calcul, et elles ont coupé la chaîne de makeup — `
             + `ce qui est réglé après elles repose sur une chaîne repartie de zéro. `
             + `Corrige-les d'abord si l'écart n'est pas assumé.`,
    });
  }

  // Le moteur signale lui-même les reports de makeup douteux (changement d'assiette,
  // makeup abandonné). Ces avertissements-là valent pour le règlement aussi.
  for (const w of d.warnings) {
    if (w.week_start <= rangeEnd) {
      out.push({ code: "engine_warning", message: `${w.week_start} — ${w.message}` });
    }
  }
  return out;
}

export type RbLockResult =
  | { ok: true; settlement_id: number; amount_due_usdt: number;
      weeks: RbSettleableWeek[]; warnings: SettlementWarning[] }
  | { ok: false; error: string; warnings?: SettlementWarning[] };

/**
 * Verrouille un règlement de rakeback sur la plage [première semaine ouverte → through].
 *
 * `acknowledge_warnings` doit valoir true s'il y a des avertissements : c'est le
 * « j'ai vu » exigé par Hugo. Sans lui, l'opération est refusée et rend la liste —
 * un règlement ne passe jamais au-dessus d'un échec sans qu'il ait été montré.
 */
export function lockNexaRakebackSettlementOn(
  db: DB,
  args: { player_id: number; through_week: string; acknowledge_warnings?: boolean; notes?: string | null },
): RbLockResult {
  const { player_id, through_week } = args;
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(player_id)) {
    return { ok: false, error: `Joueur ${player_id} introuvable.` };
  }

  const open = getOpenRbWeeksOn(db, player_id);
  if (open.length === 0) {
    return { ok: false, error: "Aucune semaine de rakeback ouverte pour ce joueur." };
  }
  if (through_week < open[0].week_start) {
    return {
      ok: false,
      error: `La plage doit commencer à la première semaine non réglée (${open[0].week_start}) — `
           + `le makeup se chaîne, on ne règle pas en sautant des semaines.`,
    };
  }

  // Plage CONTIGUË depuis la première semaine ouverte, décision 1.
  const rows = open.filter(w => w.week_start <= through_week);
  if (rows.length === 0) {
    return { ok: false, error: `Aucune semaine ouverte jusqu'au ${through_week}.` };
  }

  const warnings = getRbSettlementWarningsOn(db, player_id, rows[rows.length - 1].week_start);
  if (warnings.length > 0 && !args.acknowledge_warnings) {
    return {
      ok: false,
      error: "Règlement non verrouillé : des avertissements doivent être vus et confirmés.",
      warnings,
    };
  }

  const due = rows.reduce((s, w) => s + w.due, 0);
  if (due <= EPS) {
    return {
      ok: false,
      error: `Rien à payer sur cette plage (total ${due.toFixed(2)}). Un règlement à zéro `
           + `n'est pas un règlement — élargis la plage ou attends la semaine suivante.`,
      warnings,
    };
  }

  // Le taux et l'assiette ne sont reportés sur la ligne de règlement que s'ils sont
  // les MÊMES sur toute la plage : une colonne unique ne peut pas représenter deux
  // paramètres, et en inventer un serait mentir. Le détail par semaine, lui, est
  // toujours complet dans nexa_rakeback_settlement_weeks.
  const pcts = [...new Set(rows.map(w => w.rakeback_pct))];
  const bases = [...new Set(rows.map(w => w.basis))];
  const uniformPct = pcts.length === 1 ? pcts[0] : 0;
  const makeupConsumed = rows.reduce((s, w) => s + w.makeup_in, 0);
  const gid = gameId(db);

  const autoNote = [
    `Rakeback ${rows[0].week_start} → ${rows[rows.length - 1].week_start} (${rows.length} sem.)`,
    pcts.length > 1 ? `taux multiples : ${pcts.join(" / ")} %` : `taux ${uniformPct} %`,
    bases.length > 1 ? `assiettes multiples : ${bases.join(" / ")}` : `assiette ${bases[0]}`,
    makeupConsumed < -EPS ? `makeup consommé ${makeupConsumed.toFixed(2)}` : null,
    warnings.length > 0 ? `⚠️ ${warnings.length} avertissement(s) confirmé(s)` : null,
  ].filter(Boolean).join(" · ");

  try {
    const run = db.transaction((): number => {
      const ins = db.prepare(`
        INSERT INTO manual_settlements
          (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt,
           status, notes, locked_at, kind)
        VALUES (@game_id, @player_id, @base, @pct, @due, 'locked', @notes, datetime('now'), 'rakeback')
      `).run({
        game_id: gid, player_id,
        // net_selected_usdt porte ici l'ASSIETTE totale — l'équivalent du « net
        // sélectionné » de l'action : la grandeur sur laquelle le taux s'applique.
        base: rows.reduce((s, w) => s + w.base, 0),
        pct: uniformPct, due,
        notes: args.notes ? `${args.notes} — ${autoNote}` : autoNote,
      });
      const settlementId = Number(ins.lastInsertRowid);

      const insWeek = db.prepare(`
        INSERT INTO nexa_rakeback_settlement_weeks
          (settlement_id, player_id, week_start, basis, rakeback_pct, base,
           makeup_in, base_net, due, makeup_out)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const w of rows) {
        insWeek.run(settlementId, player_id, w.week_start, w.basis, w.rakeback_pct,
                    w.base, w.makeup_in, w.base_net, w.due, w.makeup_out);
      }
      return settlementId;
    });
    const settlementId = run();
    return { ok: true, settlement_id: settlementId, amount_due_usdt: due, weeks: rows, warnings };
  } catch (e: any) {
    // UNIQUE(player_id, week_start) est le dernier rempart si deux locks se
    // croisent : la transaction est annulée, aucune semaine n'est à moitié réglée.
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function lockNexaRakebackSettlement(
  args: { player_id: number; through_week: string; acknowledge_warnings?: boolean; notes?: string | null },
) {
  return lockNexaRakebackSettlementOn(getDb(), args);
}
