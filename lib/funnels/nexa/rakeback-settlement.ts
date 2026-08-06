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
// semaine ENTRE dans l'assiette de la suivante. Régler la 5 en laissant la 4
// ouverte laisserait une semaine non réglée derrière une semaine réglée, et le
// « déjà réglé » cesserait d'être un préfixe de la chaîne — impossible à relire.
// On exige donc une plage qui part de la plus ancienne semaine non réglée. Le
// règlement d'action, lui, accepte des semaines éparses : il n'a pas de chaînage.
// (Écart assumé entre les deux flux, il vient du domaine.)
//
// ── CE QUE LE RÈGLEMENT NE FAIT PAS : SOLDER LE MAKEUP. ──────────────────────
// Régler PAIE ce qui est dû, il n'efface pas le déficit restant. Le makeup non
// récupéré continue de courir sur les semaines suivantes. Une première version
// remettait le makeup à zéro après la dernière semaine réglée ; l'audit a montré
// que sa justification était fausse (makeup_in et makeup_out sont disjoints, la
// chaîne ne double-compte jamais) et qu'elle faisait donc simplement cadeau du
// déficit, pour un surcoût de |makeup restant| × taux. Arbitrage d'Hugo : retirée.
// Corollaire : régler ne modifie AUCUN montant des semaines à venir.
//
// ── DÉCISION 2 : LES SEMAINES À DÛ NUL SONT COUVERTES, ET ENREGISTRÉES. ──────
// Une semaine à 0 ne produit pas de règlement à elle seule — c'est la règle du
// module action, et elle tient. Mais À L'INTÉRIEUR d'une plage, une semaine à dû
// nul DOIT être enregistrée : c'est elle qui porte le makeup consommé, et sans sa
// ligne la plage aurait un trou que rien n'expliquerait à la relecture. On refuse
// en revanche un règlement dont le TOTAL est nul : ce n'est pas un paiement.
//
// ── SENS DU MONTANT : LE RAKEBACK EST STOCKÉ NÉGATIF. ────────────────────────
// `manual_settlements.amount_due_usdt` a UNE convention dans tout le repo :
// positif = le joueur doit au Cercle (ça rentre), négatif = on doit au joueur
// (ça sort). Le rakeback SORT, il est donc écrit en négatif.
//
// Ce n'est pas un détail de présentation. Cinq consommateurs lisent ce signe et
// AUCUN ne lit `kind` : getPaymentsTotals, groupPendingByPlayer, direction() du
// hub, le résumé Telegram quotidien, et l'outil agent. Une première version
// écrivait le rakeback en positif en supposant que `kind` suffirait à distinguer
// les deux flux — il ne suffit pas. Avec une action à +750 et un rakeback à +350
// sur le même joueur, le hub annonçait « il nous doit 1 100 » au lieu de +400 :
// 700 d'erreur sur le net à virer, dès le premier règlement. (Constat
// money-auditor, verdict NO-GO.)
//
// Le signe négatif rend justes les cinq consommateurs d'un coup, sans en modifier
// aucun. `kind` reste utile pour ÉTIQUETER la ligne, jamais pour la compter.
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
 * Dernière semaine dont le rakeback est réglé. INFORMATIF — ne pilote aucun
 * calcul : le moteur ignore les règlements, il rejoue toujours toute la chaîne.
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

  // LA PLAGE S'ARRÊTE À LA PREMIÈRE SEMAINE EN ÉCHEC DE CONTRÔLE.
  //
  // Décision d'Hugo (2026-08-05) après l'audit : on ne règle pas AU-DELÀ d'une
  // semaine bloquée. Régler par-dessus la faisait disparaître pour toujours — son
  // déficit était absorbé par des semaines déjà payées, et si elle était corrigée
  // ensuite elle ne pouvait plus être ni réglée ni soldée. Un cas mesuré à
  // 350 USDT payés pour des semaines qui rejouaient ensuite à 0.
  //
  // DEUX SORTIES, ET SEULEMENT DEUX (arbitrage d'Hugo, 2026-08-06, après le second
  // audit adverse) :
  //   1. corriger le report — le recalcul revient dans ±0,02, check_ok repasse à 1,
  //      la semaine cesse d'être bloquée et redevient réglable normalement ;
  //   2. l'ACTER À 0 — ackBlockedRbWeekOn ci-dessous.
  //
  // Renseigner `override_reason` n'est PAS une sortie, et c'est le piège que
  // l'audit a trouvé : `check_ok` est une colonne GÉNÉRÉE depuis le seul
  // `check_delta` (lib/db.ts), le motif n'y entre pas. Or le schéma EXIGE un motif
  // sur toute ligne hors tolérance — donc toute semaine bloquée en a déjà un, et
  // s'il suffisait à débloquer, le plafond n'existerait jamais. Sans la sortie 2,
  // une semaine dont le report NEXA est durablement incohérent — le cas même pour
  // lequel `override_reason` a été créé — gelait le rakeback de toutes les
  // semaines suivantes sans aucune issue. Mesuré : 400 USDT immobilisés.
  const firstBlocked = d.weeks.find(w => w.status === "blocked" && !settled.has(w.week_start));
  const stop = firstBlocked?.week_start ?? null;

  return d.weeks
    .filter(w => w.status === "ok" && !settled.has(w.week_start)
              && (stop === null || w.week_start < stop))
    .map(toSettleable);
}

/**
 * La semaine en échec qui borne la plage, s'il y en a une. L'écran doit pouvoir
 * dire POURQUOI il ne propose pas d'aller plus loin.
 */
export function getBlockingWeekOn(db: DB, playerId: number): string | null {
  const d = getNexaPlayerDetailOn(db, playerId);
  if (!d) return null;
  const settled = getSettledRbWeeksOn(db, playerId);
  return d.weeks.find(w => w.status === "blocked" && !settled.has(w.week_start))?.week_start ?? null;
}

export function getOpenRbWeeks(playerId: number): RbSettleableWeek[] {
  return getOpenRbWeeksOn(getDb(), playerId);
}

/**
 * Détail de la semaine qui plafonne, pour que l'écran puisse la MONTRER avant de
 * proposer de l'acter : l'écart constaté et le motif saisi. Sans eux, « acter à 0 »
 * serait un bouton qu'on presse sans savoir sur quoi.
 */
export type BlockingWeekDetail = {
  week_start: string;
  check_delta: number;
  override_reason: string | null;
  /** Rake brut de la semaine — l'ordre de grandeur de ce qu'on renonce à percevoir. */
  base: number;
  rakeback_pct: number;
  makeup_in: number;
};

export function getBlockingWeekDetailOn(db: DB, playerId: number): BlockingWeekDetail | null {
  const week = getBlockingWeekOn(db, playerId);
  if (week === null) return null;
  const d = getNexaPlayerDetailOn(db, playerId);
  const w = d?.weeks.find(x => x.week_start === week);
  if (!w) return null;
  const row = db.prepare(
    `SELECT check_delta, override_reason FROM nexa_affiliate_weeks WHERE player_id = ? AND week_start = ?`
  ).get(playerId, week) as { check_delta: number; override_reason: string | null } | undefined;
  return {
    week_start: week,
    check_delta: row?.check_delta ?? 0,
    override_reason: row?.override_reason ?? null,
    base: w.base, rakeback_pct: w.rakeback_pct, makeup_in: w.makeup_in,
  };
}

export type RbAckResult =
  | { ok: true; settlement_id: number; week_start: string; check_delta: number;
      override_reason: string | null; notes: string }
  | { ok: false; error: string };

/**
 * ACTER À 0 une semaine en échec de contrôle — la seconde sortie du plafond.
 *
 * ── CE QUE ÇA FAIT, ET CE QUE ÇA COÛTE ───────────────────────────────────────
 * La semaine est inscrite dans nexa_rakeback_settlement_weeks à dû 0. Elle cesse
 * donc d'être « bloquée non réglée », le plafond de getOpenRbWeeksOn tombe, et les
 * semaines suivantes redeviennent réglables.
 *
 * Le prix est réel et il est définitif : si le report de cette semaine est corrigé
 * plus tard, elle sera déjà réglée et son rakeback ne sera plus jamais versé. C'est
 * exactement la perte que le plafond avait été posé pour empêcher (350 USDT sur le
 * cas mesuré). La différence, et c'est toute la différence : ici elle est un ACTE
 * VOLONTAIRE, daté, motivé et relisible, et non l'effet de bord silencieux d'un
 * règlement de plage qui enjambait la semaine sans le dire.
 *
 * ── POURQUOI UNE LIGNE DE RÈGLEMENT PLUTÔT QU'UN SIMPLE MARQUEUR ─────────────
 * Exigence d'Hugo : l'acte doit apparaître dans l'HISTORIQUE DES RÈGLEMENTS du
 * joueur, avec qui, quand, quelle semaine, quel écart et quel motif. Un booléen
 * dans un coin de table ne se relit pas six mois plus tard ; une ligne dans
 * manual_settlements se relit au même endroit que les paiements, dans le même
 * ordre chronologique, à côté de ce qu'elle a débloqué.
 *
 * D'où :
 *   kind   = 'rakeback_ack'  — étiquette, jamais comptée (voir l'en-tête du module)
 *   amount = 0               — rien ne sort, rien ne rentre : ce n'est pas un paiement
 *   status = 'paid'          — sinon la ligne s'installerait dans /payments comme un
 *                              dû à honorer, et il n'y a rien à honorer.
 *
 * ── LA CONFIRMATION SE RETAPE ────────────────────────────────────────────────
 * `confirm_week` doit être la date de la semaine, retapée. Un `OK` se clique par
 * réflexe ; une date se retape en regardant laquelle. Vérifié ici ET dans l'écran :
 * l'API est atteignable sans passer par le bouton (agent, curl), et la friction ne
 * vaut que si elle est du côté qui décide.
 */
export function ackBlockedRbWeekOn(
  db: DB,
  args: { player_id: number; week_start: string; confirm_week: string; actor?: string; notes?: string | null },
): RbAckResult {
  const { player_id, week_start } = args;
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(player_id)) {
    return { ok: false, error: `Joueur ${player_id} introuvable.` };
  }
  if (args.confirm_week !== week_start) {
    return {
      ok: false,
      error: `Confirmation invalide : retape exactement la date de la semaine (${week_start}) `
           + `pour acter cet écart. L'opération est irréversible.`,
    };
  }

  // ON N'ACTE QUE LA SEMAINE QUI PLAFONNE ACTUELLEMENT, pas n'importe quelle
  // semaine bloquée. Acter une semaine bloquée plus lointaine ne débloquerait rien
  // (le plafond resterait sur la plus ancienne) tout en brûlant son rakeback :
  // un acte irréversible au prix fort, pour zéro effet. On traite dans l'ordre.
  const blocking = getBlockingWeekDetailOn(db, player_id);
  if (!blocking) {
    return { ok: false, error: "Aucune semaine ne plafonne la plage de ce joueur — il n'y a rien à acter." };
  }
  if (blocking.week_start !== week_start) {
    return {
      ok: false,
      error: `La semaine qui plafonne est le ${blocking.week_start}, pas le ${week_start}. `
           + `Les écarts s'actent dans l'ordre : acter une semaine plus récente ne débloquerait rien `
           + `et brûlerait son rakeback pour rien.`,
    };
  }

  const d = getNexaPlayerDetailOn(db, player_id);
  const w = d?.weeks.find(x => x.week_start === week_start);
  // Ceinture et bretelles : getBlockingWeekDetailOn l'a déjà établi, mais on écrit
  // un snapshot à partir de `w` — on ne l'écrit pas sans l'avoir sous la main.
  if (!w || w.status !== "blocked") {
    return { ok: false, error: `La semaine ${week_start} n'est pas en échec de contrôle.` };
  }

  const gid = gameId(db);
  const notes = [
    `Écart ACTÉ À 0 — semaine ${week_start}`,
    `contrôle en échec (écart ${blocking.check_delta.toFixed(2)}, tolérance ±0,02)`,
    `motif du report : ${blocking.override_reason ?? "(aucun)"}`,
    `rake brut ${w.base.toFixed(2)} · taux ${w.rakeback_pct} % · makeup entrant ${w.makeup_in.toFixed(2)}`,
    `acté par ${args.actor ?? "Baki"}`,
    `le rakeback de cette semaine ne sera plus jamais réglable ; la plage reprend après elle`,
  ].join(" · ");

  try {
    const run = db.transaction((): number => {
      const ins = db.prepare(`
        INSERT INTO manual_settlements
          (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt,
           status, notes, locked_at, paid_at, kind)
        VALUES (@game_id, @player_id, 0, 0, 0, 'paid', @notes, datetime('now'), datetime('now'), 'rakeback_ack')
      `).run({ game_id: gid, player_id, notes: args.notes ? `${args.notes} — ${notes}` : notes });
      const settlementId = Number(ins.lastInsertRowid);

      // Le snapshot de la semaine reprend les valeurs que le MOTEUR lui donne
      // en échec de contrôle : assiette brute et makeup entrant réels, mais
      // base_net / due / makeup_out à 0 — la semaine est hors calcul, sa chaîne
      // ne se propage pas. Rien n'est inventé pour faire joli.
      db.prepare(`
        INSERT INTO nexa_rakeback_settlement_weeks
          (settlement_id, player_id, week_start, basis, rakeback_pct, base,
           makeup_in, base_net, due, makeup_out)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
      `).run(settlementId, player_id, week_start, w.basis, w.rakeback_pct, w.base, w.makeup_in);
      return settlementId;
    });
    const settlementId = run();
    return {
      ok: true, settlement_id: settlementId, week_start,
      check_delta: blocking.check_delta, override_reason: blocking.override_reason, notes,
    };
  } catch (e: any) {
    // UNIQUE(player_id, week_start) : si la semaine a été actée entre-temps, la
    // transaction est annulée en bloc — pas de ligne de règlement orpheline.
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function ackBlockedRbWeek(
  args: { player_id: number; week_start: string; confirm_week: string; actor?: string; notes?: string | null },
) {
  return ackBlockedRbWeekOn(getDb(), args);
}

// ── Avertissements ────────────────────────────────────────────────────────────

export type SettlementWarning = { code: string; message: string };

/**
 * Ce qu'il faut avoir VU avant de régler.
 *
 * Depuis que la plage s'ARRÊTE à la première semaine en échec (voir
 * getOpenRbWeeksOn), un règlement ne peut plus enjamber un contrôle raté : le cas
 * est traité en amont, par un plafond, et non par une case à cocher. Ce qui reste
 * ici, ce sont les avertissements du MOTEUR sur la plage réglée — changement
 * d'assiette avec makeup reporté, makeup abandonné au passage d'une semaine
 * bloquée. Ils ne bloquent pas le calcul mais ils changent ce qui est payé, donc
 * ils doivent être vus.
 *
 * Le plafond lui-même n'est pas un avertissement : c'est une information, rendue
 * par getBlockingWeekOn et affichée en permanence par l'écran.
 */
export function getRbSettlementWarningsOn(
  db: DB, playerId: number, rangeEnd: string,
): SettlementWarning[] {
  const d = getNexaPlayerDetailOn(db, playerId);
  if (!d) return [];
  const out: SettlementWarning[] = [];
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

  // `due` est le montant BRUT calculé par le moteur (positif = dû au joueur).
  // Il devient négatif au moment de l'écriture, jamais avant : le moteur, les
  // snapshots et l'écran raisonnent tous en « montant dû », c'est la colonne du
  // hub qui porte la convention de sens.
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
        pct: uniformPct,
        // NÉGATIF : de l'argent qui sort. Voir l'en-tête du module.
        due: -due,
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
