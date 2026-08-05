// Règlement de la PART D'ACTION NEXAPOKER.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QUI SE RÈGLE, ET RIEN D'AUTRE : la part d'action des semaines sélectionnées.
//   amount_due_usdt = Σ action_amount des semaines couvertes.
// Pas la position nette, pas les mouvements, pas le rakeback. Les buy-ins et
// cash-outs restent de la trésorerie : ils sont affichés dans la vue joueur, ils
// ne deviennent jamais une ligne de règlement et ne sont jamais flaggés
// `settled = 1`. (Arbitrage d'Hugo, 2026-08-05.)
//
// LE MONTANT EST RECALCULÉ PAR LE MOTEUR AU LOCK. L'écran envoie des semaines,
// jamais des montants : ce qu'il affichait a pu être calculé sur un report qui a
// changé depuis. computeRakeback est rejoué ici, dans la transaction, et c'est son
// résultat qui est écrit.
//
// UNE SEMAINE RÉGLÉE NE REVIENT JAMAIS. Le moteur n'a aucune notion de règlement :
// il rejoue toujours toute la chaîne. C'est nexa_action_settlement_weeks qui porte
// la mémoire, et son UNIQUE(player_id, week_start) qui rend le double règlement
// impossible au niveau du schéma. Le figement vit là aussi : le win/loss, le % et
// le montant sont recopiés au règlement et ne bougent plus, même si la semaine est
// corrigée ensuite.
//
// SENS DU MONTANT : positif = le joueur doit au Cercle. Même convention que
// manual_settlements.amount_due_usdt et que le hub /payments.
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import { NEXA_GAME_NAME } from "./affiliate-ingest";
import { getNexaPlayerDetailOn } from "./players";

type DB = BetterSqlite3.Database;

const EPS = 0.0000001;

function gameId(db: DB): number {
  const g = db.prepare(`SELECT id FROM games WHERE name = ?`).get(NEXA_GAME_NAME) as { id: number } | undefined;
  if (!g) throw new Error(`Game ${NEXA_GAME_NAME} absent — la migration add_nexa_affiliate_v1 n'a pas tourné.`);
  return g.id;
}

/** Semaines déjà réglées d'un joueur → le règlement qui les porte. */
export function getSettledWeeksOn(db: DB, playerId: number): Map<string, number> {
  const rows = db.prepare(
    `SELECT week_start, settlement_id FROM nexa_action_settlement_weeks WHERE player_id = ?`
  ).all(playerId) as { week_start: string; settlement_id: number }[];
  return new Map(rows.map(r => [r.week_start, r.settlement_id]));
}

export type SettleableWeek = {
  week_start: string;
  winloss: number;
  action_pct: number;
  action_amount: number;
};

/**
 * Semaines effectivement réglables aujourd'hui.
 *
 * Exclues : les semaines déjà réglées, celles dont le contrôle a échoué (assiette
 * non fiable), celles dont le win/loss n'est pas saisi (on ne règle pas un montant
 * qu'on a inventé), et celles dont la part d'action est nulle — un règlement à zéro
 * n'est pas un règlement, c'est du bruit dans le hub.
 */
export function getSettleableActionWeeksOn(db: DB, playerId: number): SettleableWeek[] {
  const d = getNexaPlayerDetailOn(db, playerId);
  if (!d) return [];
  const settled = getSettledWeeksOn(db, playerId);
  return d.weeks
    .filter(w => w.status === "ok"
              && w.winloss !== null
              && w.action_amount !== null
              && Math.abs(w.action_amount) > EPS
              && !settled.has(w.week_start))
    .map(w => ({
      week_start: w.week_start,
      winloss: w.winloss!,
      action_pct: w.action_pct,
      action_amount: w.action_amount!,
    }));
}

export function getSettleableActionWeeks(playerId: number): SettleableWeek[] {
  return getSettleableActionWeeksOn(getDb(), playerId);
}

export type SettlementWarning = { code: string; message: string };

/**
 * Ce qu'il faut avoir VU avant de régler une part d'action.
 *
 * La part d'action s'appuie sur les win/loss SAISIS À LA MAIN. Une semaine sans
 * win/loss est silencieusement écartée par getSettleableActionWeeksOn — c'est
 * correct (on ne règle pas un montant inventé), mais dangereux si personne ne le
 * dit : on croit régler « la période », on ne règle que les semaines renseignées.
 * D'où cet avertissement sur les TROUS À L'INTÉRIEUR de la plage réglée, et sur
 * les semaines en échec de contrôle qui la traversent.
 * (Règle tranchée par Hugo, 2026-08-05.)
 */
export function getActionSettlementWarningsOn(
  db: DB, playerId: number, weekStarts: string[],
): SettlementWarning[] {
  const d = getNexaPlayerDetailOn(db, playerId);
  if (!d || weekStarts.length === 0) return [];
  const asked = [...weekStarts].sort();
  const from = asked[0], to = asked[asked.length - 1];
  const settled = getSettledWeeksOn(db, playerId);
  const out: SettlementWarning[] = [];

  // Semaines de la PLAGE que le règlement n'emporte pas, et pourquoi.
  const inSpan = d.weeks.filter(w => w.week_start >= from && w.week_start <= to);
  const manquantes = inSpan.filter(
    w => w.status === "ok" && w.winloss === null && !settled.has(w.week_start)
         && !asked.includes(w.week_start),
  );
  if (manquantes.length > 0) {
    out.push({
      code: "missing_winloss",
      message: `${manquantes.length} semaine(s) de la plage ${from} → ${to} n'ont pas de win/loss saisi `
             + `et ne seront PAS réglées : ${manquantes.map(w => w.week_start).join(", ")}. `
             + `Saisis-les d'abord si tu veux solder toute la période.`,
    });
  }

  const bloquees = inSpan.filter(w => w.status === "blocked");
  if (bloquees.length > 0) {
    out.push({
      code: "blocked_weeks",
      message: `${bloquees.length} semaine(s) en échec de contrôle dans la plage : `
             + `${bloquees.map(w => w.week_start).join(", ")}. Elles sont hors calcul et ne `
             + `seront pas réglées — l'assiette de rake n'est pas fiable sur ces semaines.`,
    });
  }
  return out;
}

export function getActionSettlementWarnings(playerId: number, weekStarts: string[]): SettlementWarning[] {
  return getActionSettlementWarningsOn(getDb(), playerId, weekStarts);
}

export type LockResult =
  | { ok: true; settlement_id: number; amount_due_usdt: number; weeks: SettleableWeek[]; warnings: SettlementWarning[] }
  | { ok: false; error: string; warnings?: SettlementWarning[] };

/**
 * Verrouille le règlement de la part d'action sur les semaines demandées.
 *
 * Tout est recalculé ici : les semaines envoyées ne servent qu'à choisir QUOI régler,
 * jamais COMBIEN. Une semaine qui n'est plus réglable au moment du lock fait échouer
 * l'opération entière — mieux vaut refuser que régler un sous-ensemble silencieux.
 */
export function lockNexaActionSettlementOn(
  db: DB,
  args: { player_id: number; week_starts: string[]; acknowledge_warnings?: boolean; notes?: string | null },
): LockResult {
  const { player_id } = args;
  const asked = [...new Set(args.week_starts)].sort();
  if (asked.length === 0) return { ok: false, error: "Aucune semaine sélectionnée." };
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(player_id)) {
    return { ok: false, error: `Joueur ${player_id} introuvable.` };
  }

  // Refus EXPLICITE du double règlement, avant même la contrainte SQL : le message
  // doit dire quelle semaine et où elle a déjà été réglée, pas jeter un code d'erreur.
  const settled = getSettledWeeksOn(db, player_id);
  const already = asked.filter(w => settled.has(w));
  if (already.length > 0) {
    return {
      ok: false,
      error: `Déjà réglé : ${already.join(", ")} (règlement #${settled.get(already[0])}). `
           + `Déverrouille-le si tu veux le refaire.`,
    };
  }

  const settleable = new Map(getSettleableActionWeeksOn(db, player_id).map(w => [w.week_start, w]));
  const notSettleable = asked.filter(w => !settleable.has(w));
  if (notSettleable.length > 0) {
    return {
      ok: false,
      error: `Non réglable : ${notSettleable.join(", ")} — semaine inconnue, contrôle en échec, `
           + `win/loss non saisi, ou part d'action nulle.`,
    };
  }

  // Les avertissements se calculent APRÈS les refus durs : inutile de détailler
  // des trous sur une plage qu'on va de toute façon rejeter.
  const warnings = getActionSettlementWarningsOn(db, player_id, asked);
  if (warnings.length > 0 && !args.acknowledge_warnings) {
    return {
      ok: false,
      error: "Règlement non verrouillé : des avertissements doivent être vus et confirmés.",
      warnings,
    };
  }

  const rows = asked.map(w => settleable.get(w)!);
  const due = rows.reduce((s, w) => s + w.action_amount, 0);
  const netSelected = rows.reduce((s, w) => s + w.winloss, 0);
  // Le % n'est reporté que s'il est le même sur toute la sélection : une colonne
  // unique ne peut pas représenter deux taux, et en inventer un serait mentir.
  const pcts = [...new Set(rows.map(w => w.action_pct))];
  const uniformPct = pcts.length === 1 ? pcts[0] : 0;
  const gid = gameId(db);

  try {
    const run = db.transaction((): number => {
      const ins = db.prepare(`
        INSERT INTO manual_settlements
          (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, notes, locked_at, kind)
        VALUES (@game_id, @player_id, @net, @pct, @due, 'locked', @notes, datetime('now'), 'action')
      `).run({
        game_id: gid, player_id, net: netSelected, pct: uniformPct, due,
        notes: [
          args.notes,
          pcts.length > 1 ? `Taux d'action multiples : ${pcts.join(" / ")} %` : null,
          warnings.length > 0 ? `⚠️ ${warnings.length} avertissement(s) confirmé(s)` : null,
        ].filter(Boolean).join(" — ") || null,
      });
      const settlementId = Number(ins.lastInsertRowid);

      const insWeek = db.prepare(`
        INSERT INTO nexa_action_settlement_weeks
          (settlement_id, player_id, week_start, winloss, action_pct, action_amount)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const w of rows) {
        insWeek.run(settlementId, player_id, w.week_start, w.winloss, w.action_pct, w.action_amount);
      }
      return settlementId;
    });
    const settlementId = run();
    return { ok: true, settlement_id: settlementId, amount_due_usdt: due, weeks: rows, warnings };
  } catch (e: any) {
    // La contrainte UNIQUE est le dernier rempart si deux locks se croisent : la
    // transaction est annulée, aucune semaine n'est à moitié réglée.
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function lockNexaActionSettlement(
  args: { player_id: number; week_starts: string[]; acknowledge_warnings?: boolean; notes?: string | null },
) {
  return lockNexaActionSettlementOn(getDb(), args);
}
