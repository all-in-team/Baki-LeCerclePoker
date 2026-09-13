// XPoker Twd — RÈGLEMENT JOUEUR (étape 4). Toute la math d'argent du règlement
// vit ici (invariant #2) ; la route et l'écran ne font qu'appeler.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QUI SE RÈGLE : le DÛ NET des semaines choisies, en CHIPS.
//   dû semaine = part d'action (action_pct × Σ winloss des comptes)
//              − rakeback     (rb_pct × Σ rake des comptes)
//   dû > 0 : le joueur me doit (il a gagné) · dû < 0 : je lui dois (il a perdu).
//   Symétrique, pas de plancher, pas de makeup (Baki 2026-09-13).
// Buy-ins et cash-outs restent de la trésorerie : jamais réglés ici (Q11).
//
// JE VERSE EN CHIPS (Q1bis = A). Une ligne manual_settlements XPoker porte le
// montant réglé dans amount_due_native ('TWD') ; amount_due_usdt n'est qu'un
// ÉQUIVALENT D'AFFICHAGE au taux figé, jamais un montant à payer, et le hub
// /payments EXCLUT ces lignes de la compensation inter-rooms (Q1). Aucune jambe
// USDT sur ce chemin.
//
// LE MONTANT EST RECALCULÉ PAR LE MOTEUR AU LOCK (playerWeeksOn), jamais repris
// de l'appelant. Tout est FIGÉ dans xpoker_settlement_weeks : chips, taux du
// deal, taux chips/USD. Une semaine réglée ne peut plus changer de deal (F2 —
// setDealOn refuse toute semaine importée, a fortiori réglée) ni de joueur (R1 —
// relinkMemberIdOn refuse). UNIQUE(player_id, week_start) rend le double
// règlement impossible au niveau du schéma.
//
// JAMAIS LOCKÉ : une semaine INCALCULABLE (joueur sans deal), une semaine d'un
// import EN ÉCART NON ACTÉ — et aussi en écart acté : « jamais réglable en un
// clic » (Q6). Ces semaines se règlent à la main, par un ajustement motivé.
//
// L'ARGENT S'INSCRIT AU GRAND LIVRE AU markPaid, jamais au lock (même doctrine
// que NEXA bankroll) : action_paid (in s'il me règle, out si je lui verse) et
// rb_paid (out), datés de la date RÉELLE du transfert — obligatoire.
// ─────────────────────────────────────────────────────────────────────────────

import type Database from "better-sqlite3";
import { playerWeeksOn, rateAtOn, xpokerGameIdOn, type PlayerWeek } from "./engine";
import { chipsToUsd } from "./club-math";

type DB = Database.Database;

/** manual_settlements.kind des règlements XPoker — le hub les reconnaît à ça (et à native_currency). */
export const XPOKER_SETTLEMENT_KIND = "xpoker";
export const XPOKER_NATIVE_CURRENCY = "TWD";
const EPS = 0.005;

export type SettleableWeek = {
  week_start: string;
  winloss_chips: number;
  rake_chips: number;
  action_pct: number;
  rb_pct: number;
  action_chips: number;
  rb_chips: number;
  due_chips: number;
  rate_chips_per_usd: number;
  due_usd: number;
};

export type BlockedWeek = { week_start: string; reason: "no_deal" | "flagged" | "settled"; settlement_id?: number };

/** Semaines déjà réglées d'un joueur → le règlement qui les porte. */
export function getSettledWeeksOn(db: DB, playerId: number): Map<string, number> {
  const rows = db.prepare(`SELECT week_start, settlement_id FROM xpoker_settlement_weeks WHERE player_id = ?`).all(playerId) as { week_start: string; settlement_id: number }[];
  return new Map(rows.map(r => [r.week_start, r.settlement_id]));
}

function classify(w: PlayerWeek, settled: Map<string, number>): BlockedWeek | null {
  if (settled.has(w.week_start)) return { week_start: w.week_start, reason: "settled", settlement_id: settled.get(w.week_start) };
  if (w.deal === null || w.action_chips === null || w.rb_chips === null || w.due_chips === null) return { week_start: w.week_start, reason: "no_deal" };
  if (w.import_flagged) return { week_start: w.week_start, reason: "flagged" };
  return null;
}

/** Semaines réglables aujourd'hui et semaines bloquées (avec la raison), du plus récent au plus ancien. */
export function getSettleableWeeksOn(db: DB, playerId: number): { settleable: SettleableWeek[]; blocked: BlockedWeek[] } {
  const settled = getSettledWeeksOn(db, playerId);
  const settleable: SettleableWeek[] = [], blocked: BlockedWeek[] = [];
  for (const w of playerWeeksOn(db, playerId)) {
    const b = classify(w, settled);
    if (b) { blocked.push(b); continue; }
    settleable.push({
      week_start: w.week_start, winloss_chips: w.winloss_chips, rake_chips: w.rake_chips,
      action_pct: w.deal!.action_pct, rb_pct: w.deal!.rb_pct,
      action_chips: w.action_chips!, rb_chips: w.rb_chips!, due_chips: w.due_chips!,
      rate_chips_per_usd: w.rate_chips_per_usd, due_usd: w.due_usd!,
    });
  }
  return { settleable, blocked };
}

export type LockResult =
  | { ok: true; settlement_id: number; due_chips: number; due_usd: number; weeks: SettleableWeek[] }
  | { ok: false; error: string };

const REASON_LABEL: Record<BlockedWeek["reason"], string> = {
  no_deal: "incalculable (aucun deal cette semaine-là)",
  flagged: "import en écart (acté ou non) — jamais réglable en un clic",
  settled: "déjà réglée",
};

/**
 * Verrouille un règlement sur des semaines. L'écran envoie des semaines, jamais
 * des montants. Refus explicites AVANT la contrainte SQL : semaine inconnue,
 * incalculable, en écart, déjà réglée. Tout est figé dans la même transaction.
 */
export function lockXpokerSettlementOn(db: DB, args: { player_id: number; week_starts: string[]; notes?: string | null }): LockResult {
  const asked = [...new Set(args.week_starts)].sort();
  if (asked.length === 0) return { ok: false, error: "Aucune semaine sélectionnée." };
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(args.player_id)) return { ok: false, error: `Joueur ${args.player_id} introuvable.` };

  const { settleable, blocked } = getSettleableWeeksOn(db, args.player_id);
  const byWeek = new Map(settleable.map(w => [w.week_start, w]));
  const blockedBy = new Map(blocked.map(b => [b.week_start, b]));
  const refused = asked.filter(w => !byWeek.has(w));
  if (refused.length > 0) {
    return {
      ok: false,
      error: "Non réglable : " + refused.map(w => {
        const b = blockedBy.get(w);
        return b ? `${w} — ${REASON_LABEL[b.reason]}${b.settlement_id ? ` (règlement #${b.settlement_id})` : ""}` : `${w} — semaine inconnue pour ce joueur`;
      }).join(" ; "),
    };
  }

  const weeks = asked.map(w => byWeek.get(w)!);
  const due_chips = weeks.reduce((s, w) => s + w.due_chips, 0);
  const due_usd = weeks.reduce((s, w) => s + w.due_usd, 0);                       // Σ des équivalents, chacun à SON taux figé
  const winloss_usd = weeks.reduce((s, w) => s + chipsToUsd(w.winloss_chips, w.rate_chips_per_usd), 0);
  const pcts = [...new Set(weeks.map(w => w.action_pct))];
  const rates = [...new Set(weeks.map(w => w.rate_chips_per_usd))];
  const gid = xpokerGameIdOn(db);

  try {
    const run = db.transaction((): number => {
      const ins = db.prepare(`
        INSERT INTO manual_settlements
          (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, notes, locked_at, kind,
           amount_due_native, native_currency, fx_rate_applied)
        VALUES (@game_id, @player_id, @net, @pct, @due_usd, 'locked', @notes, datetime('now'), @kind, @due_chips, @cur, @fx)
      `).run({
        game_id: gid, player_id: args.player_id,
        // net_selected_usdt / amount_due_usdt : ÉQUIVALENTS d'affichage au(x) taux figé(s), jamais un montant à payer.
        net: winloss_usd, pct: pcts.length === 1 ? pcts[0] : 0, due_usd, due_chips,
        kind: XPOKER_SETTLEMENT_KIND, cur: XPOKER_NATIVE_CURRENCY, fx: rates.length === 1 ? rates[0] : null,
        notes: [
          args.notes?.trim() || null,
          pcts.length > 1 ? `Taux d'action multiples : ${pcts.join(" / ")} %` : null,
          rates.length > 1 ? `Taux chips/USD multiples : ${rates.join(" / ")}` : null,
        ].filter(Boolean).join(" — ") || null,
      });
      const settlementId = Number(ins.lastInsertRowid);
      const insWeek = db.prepare(`
        INSERT INTO xpoker_settlement_weeks
          (settlement_id, player_id, week_start, winloss_chips, rake_chips, action_pct, rb_pct, action_chips, rb_chips, due_chips, rate_chips_per_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const w of weeks) {
        insWeek.run(settlementId, args.player_id, w.week_start, w.winloss_chips, w.rake_chips, w.action_pct, w.rb_pct, w.action_chips, w.rb_chips, w.due_chips, w.rate_chips_per_usd);
      }
      return settlementId;
    });
    const settlement_id = run();
    return { ok: true, settlement_id, due_chips, due_usd, weeks };
  } catch (e: any) {
    // UNIQUE(player_id, week_start) : le dernier rempart si deux locks se croisent — rien à moitié réglé.
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Appelé PAR markPaid (lib/manual-settlement-engine.ts), dans SA transaction, une
 * fois le statut passé à 'paid'. No-op pour tout règlement qui n'est pas XPoker.
 *
 * Écrit au grand livre chips, datés de la date RÉELLE du transfert (obligatoire :
 * une date absente n'est pas « aujourd'hui », c'est une information manquante,
 * et on la refuse — même garde que le règlement de bankroll NEXA) :
 *   • action_paid : |Σ action_chips| — 'in' s'il me règle (gagnant), 'out' si je verse (perdant)
 *   • rb_paid     :  Σ rb_chips      — 'out' (jamais notifié au joueur)
 * Une ligne à zéro n'est pas écrite (CHECK chips > 0). Le taux porté par les lignes
 * n'est qu'un équivalent d'affichage : celui figé au lock s'il est unique, sinon
 * celui en vigueur à la date du paiement.
 * Jette sur toute erreur : la transaction est annulée et le règlement ne passe
 * pas payé sans ses mouvements.
 */
export function writeXpokerLedgerOnPaidOn(db: DB, settlementId: number, paidDate: string | null): { written: number } {
  let ms: { id: number; player_id: number; kind: string; native_currency: string | null; fx_rate_applied: number | null } | undefined;
  try {
    ms = db.prepare(`SELECT id, player_id, kind, native_currency, fx_rate_applied FROM manual_settlements WHERE id = ?`).get(settlementId) as typeof ms;
  } catch (e: any) {
    if (/no such column/i.test(e?.message ?? "")) return { written: 0 };   // migration add_xpoker_twd_v1 pas encore passée
    throw e;
  }
  if (!ms || (ms.kind !== XPOKER_SETTLEMENT_KIND && ms.native_currency !== XPOKER_NATIVE_CURRENCY)) return { written: 0 };
  if (!paidDate) throw new Error("Règlement XPoker : la date RÉELLE du transfert de chips est obligatoire pour marquer payé.");

  const agg = db.prepare(`SELECT COALESCE(SUM(action_chips), 0) AS action, COALESCE(SUM(rb_chips), 0) AS rb, COUNT(*) AS n FROM xpoker_settlement_weeks WHERE settlement_id = ?`)
    .get(settlementId) as { action: number; rb: number; n: number };
  if (agg.n === 0) throw new Error(`Règlement XPoker #${settlementId} sans semaine figée — incohérent, refus.`);
  const rate = ms.fx_rate_applied ?? rateAtOn(db, paidDate);
  const ins = db.prepare(`
    INSERT INTO xpoker_chip_ledger (occurred_at, kind, direction, chips, rate_chips_per_usd, player_id, settlement_id, note)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let written = 0;
  if (Math.abs(agg.action) >= EPS) {
    ins.run(paidDate, "action_paid", agg.action > 0 ? "in" : "out", Math.abs(agg.action), rate, ms.player_id, settlementId, `règlement #${settlementId} — part d'action`);
    written++;
  }
  if (agg.rb >= EPS) {
    ins.run(paidDate, "rb_paid", "out", agg.rb, rate, ms.player_id, settlementId, `règlement #${settlementId} — rakeback`);
    written++;
  }
  return { written };
}

export type XpokerSettlementRow = {
  id: number; status: "locked" | "paid"; kind: string;
  due_chips: number; due_usd: number; fx_rate_applied: number | null;
  weeks: { week_start: string; due_chips: number; action_pct: number; rb_pct: number }[];
  locked_at: string; paid_at: string | null; paid_date: string | null; notes: string | null;
};

/** Règlements XPoker d'un joueur, du plus récent au plus ancien — pour la page. */
export function getXpokerSettlementsOn(db: DB, playerId: number): XpokerSettlementRow[] {
  const gid = xpokerGameIdOn(db);
  const rows = db.prepare(`
    SELECT id, status, kind, amount_due_native, amount_due_usdt, fx_rate_applied, locked_at, paid_at, paid_date, notes
    FROM manual_settlements WHERE game_id = ? AND player_id = ? ORDER BY id DESC
  `).all(gid, playerId) as { id: number; status: "locked" | "paid"; kind: string; amount_due_native: number | null; amount_due_usdt: number; fx_rate_applied: number | null; locked_at: string; paid_at: string | null; paid_date: string | null; notes: string | null }[];
  const weeksStmt = db.prepare(`SELECT week_start, due_chips, action_pct, rb_pct FROM xpoker_settlement_weeks WHERE settlement_id = ? ORDER BY week_start`);
  return rows.map(r => ({
    id: r.id, status: r.status, kind: r.kind,
    due_chips: r.amount_due_native ?? 0, due_usd: r.amount_due_usdt, fx_rate_applied: r.fx_rate_applied,
    weeks: weeksStmt.all(r.id) as XpokerSettlementRow["weeks"],
    locked_at: r.locked_at, paid_at: r.paid_at, paid_date: r.paid_date, notes: r.notes,
  }));
}
