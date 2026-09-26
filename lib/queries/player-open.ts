import type Database from "better-sqlite3";
import { getNexaPlayerDetailOn } from "@/lib/funnels/nexa/players";
import { getSettleableWeeksOn } from "@/lib/games/xpoker/settlement";
import { computeAgentCommissionOn } from "@/lib/affiliate/agent-rates";

type DB = Database.Database;

// ── « Ouvert » : un joueur qui a quelque chose à régler ou un solde non nul ──
//
// UNE seule définition, lue par (règle Baki du 2026-09-25, seconde version) :
//   - l'affichage : dans « Archivés », les joueurs ouverts passent en tête avec le badge
//     « à régler » et leur motif ; le bouton compte « Archivés (N · X à régler) » ;
//   - les SUPPRESSIONS (reset-player, suppression définitive) : refusées pour un joueur
//     ouvert (assertPlayersNotOpenOn) — une suppression efface de la donnée.
// L'archivage, lui, est toujours permis : il ne masque qu'une vue, rien ne s'efface.
// Rien de ce module ne touche un calcul d'argent, un règlement, le P&L ou un sync.
//
// Fail-closed partout : une source inconnue, incalculable ou en erreur rend ouvert.
// Ce qui N'EST PAS « ouvert » (décision Baki) : un deal en cours, une wallet enregistrée —
// c'est du réglage, pas de l'argent. Ils remontent en `links` (indicateur « lien actif »).
// Un dépôt reçu sur une wallet d'archivé crée une tx non réglée → le joueur redevient
// ouvert et passe en tête d'« Archivés » avec « à régler » : le sync ne regarde ni le
// statut ni l'archive.
//
// Le « solde » n'est PAS le Lifetime (indicatif, retarifé aux deals actuels) ni le net P&L
// des cartes : c'est ce qui reste à régler, source par source (sections ci-dessous).

export type OpenReason = { code: string; label: string };
export type PlayerLink = { code: "deal" | "wallet" | "wallet_legacy" | "xpoker_deal"; game: string | null };
export type PlayerOpenState = { open: OpenReason[]; links: PlayerLink[] };

// Rooms qui n'utilisent PAS `wallet_transactions.settled` : NEXA se règle par semaine
// (sources NEXA ci-dessous), QQPK par bloc de staking (source QQPK). Leurs tx restent à
// settled=0 pour toujours (dump 2026-09-25 : 41 tx NEXA, 46 tx QQPK, aucune à 1) — les
// compter rendrait ouverts à vie tous leurs joueurs. TOUTE autre room, y compris une room
// future ou inconnue, compte ses tx non réglées : fail-closed.
const ROOMS_WITHOUT_SETTLED_FLAG = ["NEXAPOKER", "QQPK"];

const EPS = 0.005;
const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

export type OpenStateOptions = {
  /**
   * Dû d'affiliation d'un agent (USDT), `null` = incalculable (part agence sans taux).
   * Par défaut : le calcul canonique computeAgentCommissionOn(db, id).due_now. Surchargé
   * seulement par les tests qui veulent isoler une autre source.
   */
  agentDue?: (playerId: number) => number | null;
};

type Acc = Map<number, PlayerOpenState>;
function push(acc: Acc, id: number, r: OpenReason) {
  let s = acc.get(id);
  if (!s) { s = { open: [], links: [] }; acc.set(id, s); }
  s.open.push(r);
}
function link(acc: Acc, id: number, l: PlayerLink) {
  let s = acc.get(id);
  if (!s) { s = { open: [], links: [] }; acc.set(id, s); }
  s.links.push(l);
}

/**
 * État « ouvert » de chaque joueur (tous, ou `playerIds`). Un joueur absent de la map
 * n'a rien d'ouvert ni de lien actif.
 *
 * LÈVE en cas d'erreur (table manquante…) : c'est à l'appelant de décider du fail-closed
 * (une suppression est refusée ; l'écran /players le signale par un bandeau).
 */
export function getPlayersOpenStateOn(db: DB, playerIds?: number[], opts: OpenStateOptions = {}): Map<number, PlayerOpenState> {
  const acc: Acc = new Map();
  const only = playerIds ? new Set(playerIds) : null;
  const want = (id: number) => !only || only.has(id);
  const noFlag = ROOMS_WITHOUT_SETTLED_FLAG.map(() => "?").join(",");

  // 1. Tx non réglées, quarantaine comprise (seule `rejected` est close), toute room qui
  //    utilise le flag settled — TELE compris (héritage, décision Baki : ouvert, pas
  //    d'exception ; le solder se fera par un acte explicite, cf. TODOS).
  for (const r of db.prepare(`
    SELECT wt.player_id AS id, g.name AS game, COUNT(*) AS n,
           SUM(CASE WHEN wt.type = 'withdrawal' THEN wt.amount ELSE -wt.amount END) AS net,
           SUM(COALESCE(wt.status, 'active') = 'quarantined') AS quarantined
    FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
    WHERE wt.settled = 0 AND (wt.source IS NULL OR wt.source IN ('sync', 'manual'))
      AND COALESCE(wt.status, 'active') <> 'rejected'
      AND g.name NOT IN (${noFlag})
    GROUP BY wt.player_id, g.id
  `).all(...ROOMS_WITHOUT_SETTLED_FLAG) as { id: number; game: string; n: number; net: number; quarantined: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, {
      code: r.game === "TELE" ? "tele_tx" : "tx_unsettled",
      label: `${r.n} tx non réglée${r.n > 1 ? "s" : ""} ${r.game} (net ${fmt(r.net)})${r.quarantined ? `, dont ${r.quarantined} en quarantaine` : ""}`,
    });
  }

  // 1-bis. Rooms sans flag settled (NEXA, QQPK) : une tx en quarantaine, ou dans une autre
  //    devise que l'USDT, n'est vue ni par la source 1 (room exclue) ni par leur moteur
  //    (qui ne lit que status actif / NULL et l'USDT) → ouverte d'office, fail-closed.
  for (const r of db.prepare(`
    SELECT wt.player_id AS id, g.name AS game,
           SUM(COALESCE(wt.status, 'active') = 'quarantined') AS quarantined,
           SUM(COALESCE(wt.currency, 'USDT') <> 'USDT' AND COALESCE(wt.status, 'active') <> 'rejected') AS other_ccy
    FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
    WHERE g.name IN (${noFlag}) AND (wt.source IS NULL OR wt.source IN ('sync', 'manual'))
    GROUP BY wt.player_id, g.id
    HAVING quarantined > 0 OR other_ccy > 0
  `).all(...ROOMS_WITHOUT_SETTLED_FLAG) as { id: number; game: string; quarantined: number; other_ccy: number }[]) {
    if (!want(r.id)) continue;
    if (r.quarantined) push(acc, r.id, { code: "tx_quarantined", label: `${r.quarantined} tx ${r.game} en quarantaine` });
    if (r.other_ccy) push(acc, r.id, { code: "tx_other_currency", label: `${r.other_ccy} tx ${r.game} hors USDT (non comptée par le moteur de la room)` });
  }

  // 2. Héritage TELE : semaines hebdo non reçues (moteur hebdo d'avril–juin). Tous les statuts
  //    qu'un écran traite comme « à payer » (SettlementsClient) + conflict, fail-closed.
  for (const r of db.prepare(`
    SELECT player_id AS id, COUNT(*) AS n FROM weekly_settlements
    WHERE status IN ('auto_settled', 'pending_manual', 'settled', 'carry_over', 'conflict') AND COALESCE(payment_received, 0) = 0
    GROUP BY player_id
  `).all() as { id: number; n: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "tele_weekly", label: `${r.n} semaine${r.n > 1 ? "s" : ""} TELE non reçue${r.n > 1 ? "s" : ""}` });
  }

  // 3. Règlements verrouillés non payés, tous kinds (action, rakeback, BR NEXA, pool, xpoker).
  for (const r of db.prepare(`
    SELECT player_id AS id, COUNT(*) AS n FROM manual_settlements WHERE status = 'locked' GROUP BY player_id
  `).all() as { id: number; n: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "settlement_locked", label: `${r.n} règlement${r.n > 1 ? "s" : ""} verrouillé${r.n > 1 ? "s" : ""} non payé${r.n > 1 ? "s" : ""}` });
  }

  // 4. NEXA — semaine BR ouverte d'un staké : une semaine n'existe en base qu'une fois
  //    verrouillée, un staké actif a donc toujours une semaine courante ouverte.
  for (const r of db.prepare(`
    SELECT player_id AS id, MAX(pct) AS pct FROM nexa_player_action_shares
    WHERE end_week IS NULL AND pct > 0 GROUP BY player_id
  `).all() as { id: number; pct: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "nexa_stake", label: `staké NEXA ${r.pct} % (semaine BR ouverte)` });
  }

  // 5. NEXA — rejeu du moteur (part d'action / RB non réglés, makeup, solde des mouvements).
  //    Incalculable (win/loss manquant) = ouvert, décision Baki.
  const nexaIds = db.prepare(`
    SELECT player_id AS id FROM nexa_affiliate_weeks
    UNION SELECT player_id FROM nexa_player_action_shares
    UNION SELECT player_id FROM nexa_player_bankroll_weeks
    UNION SELECT wt.player_id FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id WHERE g.name = 'NEXAPOKER'
  `).all() as { id: number }[];
  for (const { id } of nexaIds) {
    if (id == null || !want(id)) continue;
    const d = getNexaPlayerDetailOn(db, id);
    if (!d) continue;
    if (d.action_unsettled === null) push(acc, id, { code: "nexa_action", label: "part d'action NEXA incalculable (win/loss manquant)" });
    else if (Math.abs(d.action_unsettled) > EPS) push(acc, id, { code: "nexa_action", label: `part d'action NEXA non réglée ${fmt(d.action_unsettled)}` });
    if (Math.abs(d.rb_unsettled) > EPS) push(acc, id, { code: "nexa_rb", label: `rakeback NEXA non réglé ${fmt(d.rb_unsettled)}` });
    if (Math.abs(d.makeup_final) > EPS) push(acc, id, { code: "nexa_makeup", label: `makeup NEXA ${fmt(d.makeup_final)}` });
    if (Math.abs(d.net_movements) > EPS) push(acc, id, { code: "nexa_movements", label: `solde des mouvements NEXA ${fmt(d.net_movements)}` });
    // Une semaine bloquée (écart de contrôle) n'entre ni dans action_unsettled ni dans
    // rb_unsettled : sans cette ligne, un joueur dont il ne reste que ça serait archivable.
    const nb = d.blocked_weeks.count;
    if (nb > 0) push(acc, id, { code: "nexa_blocked", label: `${nb} semaine${nb > 1 ? "s" : ""} NEXA bloquée${nb > 1 ? "s" : ""} (écart de contrôle)` });
  }

  // 6. Pool AK multi-Account : membre du pool, compte ou période ouverts (fail-closed :
  //    l'appartenance seule suffit, le pool se règle sur la somme des soldes).
  for (const r of db.prepare(`
    SELECT player_id AS id FROM pool_players
    UNION SELECT player_id FROM pool_accounts WHERE closed_at IS NULL
    UNION SELECT player_id FROM pool_periods WHERE closed_at IS NULL
  `).all() as { id: number }[]) {
    if (r.id == null || !want(r.id)) continue;
    push(acc, r.id, { code: "pool", label: "pool AK multi-Account" });
  }

  // 7. QQPK : bloc de staking non réglé, ou tx QQPK couverte par aucun bloc (le premier
  //    bloc date du 21/06 ; une tx hors bloc n'a été réglée par aucun cycle).
  for (const r of db.prepare(`
    SELECT player_id AS id, COUNT(*) AS n FROM qqpk_staking_blocks WHERE status <> 'settled' GROUP BY player_id
  `).all() as { id: number; n: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "qqpk_block", label: `${r.n} bloc${r.n > 1 ? "s" : ""} QQPK non réglé${r.n > 1 ? "s" : ""}` });
  }
  for (const r of db.prepare(`
    SELECT wt.player_id AS id, COUNT(*) AS n,
           SUM(CASE WHEN wt.type = 'deposit' THEN wt.amount ELSE -wt.amount END) AS dep
    FROM wallet_transactions wt JOIN games g ON g.id = wt.game_id
    WHERE g.name = 'QQPK' AND (wt.source IS NULL OR wt.source IN ('sync', 'manual')) AND COALESCE(wt.status, 'active') <> 'rejected'
      AND NOT EXISTS (SELECT 1 FROM qqpk_staking_blocks b WHERE b.player_id = wt.player_id
                      AND COALESCE(wt.tx_datetime, wt.tx_date) BETWEEN b.block_start AND b.block_end)
    GROUP BY wt.player_id
  `).all() as { id: number; n: number; dep: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "qqpk_outside_block", label: `${r.n} tx QQPK hors bloc (dépôts nets ${fmt(r.dep)})` });
  }

  // 8. XPoker : semaines réglables, ou bloquées faute de deal / en écart d'import.
  //    Une semaine « settled » est close, pas ouverte.
  const xpIds = db.prepare(`SELECT DISTINCT player_id AS id FROM xpoker_week_rows WHERE player_id IS NOT NULL`).all() as { id: number }[];
  for (const { id } of xpIds) {
    if (!want(id)) continue;
    const w = getSettleableWeeksOn(db, id);
    if (w.settleable.length) push(acc, id, { code: "xpoker_settleable", label: `${w.settleable.length} semaine${w.settleable.length > 1 ? "s" : ""} XPoker à régler` });
    const blocked = w.blocked.filter(b => b.reason !== "settled");
    if (blocked.length) push(acc, id, { code: "xpoker_blocked", label: `${blocked.length} semaine${blocked.length > 1 ? "s" : ""} XPoker bloquée${blocked.length > 1 ? "s" : ""} (${[...new Set(blocked.map(b => b.reason))].join(", ")})` });
  }

  // 8-bis. XPoker — mouvements de chips du joueur (buy-in, cash-out, ajustement), hors
  //    versements de règlement (action_paid / rb_paid, eux-mêmes des règlements) :
  //    « position joueur = ses lignes + ses résultats × son deal » (xpoker/schema.ts). Un
  //    solde de lignes non nul = des chips créditées ou rendues qui ne sont pas soldées.
  //    Fail-closed : un buy-in sans cash-out garde le joueur ouvert (décision Baki 2026-09-25).
  for (const r of db.prepare(`
    SELECT player_id AS id, COUNT(*) AS n,
           SUM(CASE WHEN direction = 'out' THEN chips ELSE -chips END) AS net_chips
    FROM xpoker_chip_ledger
    WHERE player_id IS NOT NULL AND kind IN ('buyin', 'cashout', 'adjustment')
    GROUP BY player_id
  `).all() as { id: number; n: number; net_chips: number }[]) {
    if (!want(r.id) || Math.abs(r.net_chips) <= EPS) continue;
    push(acc, r.id, { code: "xpoker_chips", label: `mouvements de chips XPoker non soldés (${fmt(r.net_chips)} chips, ${r.n} ligne${r.n > 1 ? "s" : ""})` });
  }

  // 9. Grindhouse non payé, demande de cashout en cours.
  for (const r of db.prepare(`SELECT player_id AS id, COUNT(*) AS n FROM grindhouse_settlements WHERE status <> 'paid' GROUP BY player_id`).all() as { id: number; n: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "grindhouse", label: `${r.n} règlement${r.n > 1 ? "s" : ""} grindhouse non payé${r.n > 1 ? "s" : ""}` });
  }
  // Une session grindhouse n'est réglée que par un règlement PAYÉ qui couvre sa date : un
  // règlement n'existe qu'une fois créé à la main (api/grindhouse-settlements), donc une
  // session sans règlement n'est réglée par rien.
  for (const r of db.prepare(`
    SELECT s.player_id AS id, COUNT(*) AS n FROM grindhouse_sessions s
    WHERE NOT EXISTS (SELECT 1 FROM grindhouse_settlements gs
                      WHERE gs.player_id = s.player_id AND gs.status = 'paid'
                        AND s.session_date BETWEEN gs.period_start AND gs.period_end
                        -- saisie AVANT le règlement : sessions_pnl est figé à sa création, une
                        -- session antidatée saisie après n'a jamais été payée.
                        AND s.created_at <= gs.created_at)
    GROUP BY s.player_id
  `).all() as { id: number; n: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "grindhouse_sessions", label: `${r.n} session${r.n > 1 ? "s" : ""} grindhouse non réglée${r.n > 1 ? "s" : ""}` });
  }
  for (const r of db.prepare(`SELECT player_id AS id, COUNT(*) AS n FROM cashout_requests WHERE status IN ('pending', 'approved') GROUP BY player_id`).all() as { id: number; n: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "cashout_request", label: `${r.n} demande${r.n > 1 ? "s" : ""} de cashout en cours` });
  }

  // 10. Reports rakeback (Wepoker) : aucune notion de « réglé » dans le schéma et aucun
  //     flux de règlement (manual-settlement-engine.ts:679) — fail-closed.
  for (const r of db.prepare(`SELECT player_id AS id, COUNT(*) AS n FROM rakeback_entries WHERE player_id IS NOT NULL GROUP BY player_id`).all() as { id: number; n: number }[]) {
    if (!want(r.id)) continue;
    push(acc, r.id, { code: "rakeback_report", label: `${r.n} ligne${r.n > 1 ? "s" : ""} de report rakeback (aucun état « réglé »)` });
  }

  // 11. Affiliation : l'agence doit à l'AGENT (affiliate_player_id) ; le filleul ne porte
  //     aucune dette d'affiliation. Dû calculé au niveau agent (compensation croisée).
  //     null = incalculable (semaine sans taux agent) → ouvert, jamais un 0 supposé.
  const agentDue = opts.agentDue ?? ((id: number) => computeAgentCommissionOn(db, id).due_now);
  for (const { id } of db.prepare(`SELECT DISTINCT affiliate_player_id AS id FROM affiliate_relationships WHERE status = 'active'`).all() as { id: number }[]) {
    if (!want(id)) continue;
    const due = agentDue(id);
    if (due === null || !Number.isFinite(due)) push(acc, id, { code: "affiliate_due", label: "commission d'affiliation incalculable (taux agent manquant)" });
    else if (due > EPS) push(acc, id, { code: "affiliate_due", label: `commission d'affiliation due ${fmt(due)}` });
  }

  // ── Liens actifs : PAS ouverts, affichés dans « Archivés » ──
  for (const r of db.prepare(`
    SELECT pgd.player_id AS id, g.name AS game FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id
    WHERE pgd.end_date IS NULL ORDER BY g.name
  `).all() as { id: number; game: string }[]) {
    if (want(r.id)) link(acc, r.id, { code: "deal", game: r.game });
  }
  for (const r of db.prepare(`
    SELECT DISTINCT pwg.player_id AS id, g.name AS game FROM player_wallet_games pwg JOIN games g ON g.id = pwg.game_id ORDER BY g.name
  `).all() as { id: number; game: string }[]) {
    if (want(r.id)) link(acc, r.id, { code: "wallet", game: r.game });
  }
  for (const r of db.prepare(`
    SELECT id FROM players WHERE COALESCE(tron_address, '') <> '' OR COALESCE(tele_wallet_cashout, '') <> ''
  `).all() as { id: number }[]) {
    if (want(r.id)) link(acc, r.id, { code: "wallet_legacy", game: null });
  }
  for (const r of db.prepare(`SELECT DISTINCT player_id AS id FROM xpoker_player_deals WHERE end_week IS NULL`).all() as { id: number }[]) {
    if (want(r.id)) link(acc, r.id, { code: "xpoker_deal", game: "XPOKER_TWD" });
  }

  return acc;
}

export class PlayerOpenError extends Error {
  constructor(public readonly blocked: { player_id: number; name: string; reasons: OpenReason[] }[]) {
    super(
      "Suppression refusée — quelque chose reste à régler : " +
      blocked.map(b => `${b.name} (#${b.player_id}) : ${b.reasons.map(r => r.label).join(" ; ")}`).join(" | "),
    );
    this.name = "PlayerOpenError";
  }
}

/**
 * Garde des SUPPRESSIONS : lève PlayerOpenError si UN des joueurs est ouvert. Toute erreur de
 * calcul est propagée telle quelle : la suppression n'a pas lieu (fail-closed).
 */
export function assertPlayersNotOpenOn(db: DB, playerIds: number[], opts: OpenStateOptions = {}): void {
  const state = getPlayersOpenStateOn(db, playerIds, opts);
  const names = new Map((db.prepare(`SELECT id, name FROM players WHERE id IN (${playerIds.map(() => "?").join(",") || "NULL"})`).all(...playerIds) as { id: number; name: string }[]).map(p => [p.id, p.name]));
  const blocked = playerIds
    .filter(id => (state.get(id)?.open.length ?? 0) > 0)
    .map(id => ({ player_id: id, name: names.get(id) ?? `#${id}`, reasons: state.get(id)!.open }));
  if (blocked.length) throw new PlayerOpenError(blocked);
}
