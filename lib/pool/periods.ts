// Suivi multi-comptes « AK multi-Account » — BRANCHEMENT DU MOTEUR SUR LA BASE.
//
// Deux formes par fonction publique, `x()` sur la prod et `xOn(db, …)` sur une
// base explicite, pour que les tests exercent les vraies contraintes SQL. Même
// parti pris que lib/funnels/nexa/bankroll.ts, dont ce module reprend la doctrine :
//
//   • RIEN N'EST PERSISTÉ AVANT LE CLIC « Régler ». L'aperçu est calculé à la
//     volée PAR LA MÊME FONCTION que le verrouillage (previewPoolPeriodOn), donc
//     l'écran ne peut pas montrer autre chose que ce qui sera écrit. Ce qui vit
//     en base avant : la structure (pool_players, pool_accounts), les faits bruts
//     (okpay_ledger_lines) et les mouvements déclarés — jamais un résultat.
//   • Le verrouillage écrit, DANS UNE SEULE TRANSACTION : la ligne
//     manual_settlements (kind='action') si la part n'est pas nulle, la période
//     figée (pool_periods) et ses soldes horodatés (pool_period_balances).
//   • Le montant est RECALCULÉ au verrouillage (preview rejouée juste avant la
//     transaction, sur la même connexion synchrone), jamais repris de l'écran.
//   • Seule la DERNIÈRE période est déverrouillable, jamais si son règlement est
//     payé. Le pool de début de N+1 est repris de N : déverrouiller N sous N+1
//     l'invaliderait en silence.
//
// ⚠️ LE POINT §4 — les règlements traversent le pool. Le mouvement de règlement
// s'écrit au « marquer payé » de /payments (writePoolSettlementMovementOnPaid,
// appelé dans la transaction de markPaid), daté par settlementOccurredAt, et
// compte dans la période où il tombe. D'où la RÈGLE D'EXPLOITATION, imposée
// ici par un blocker : on ne clôture pas une période tant que le règlement de
// la précédente est 'locked'. Voir lib/pool/schema.ts et docs/POOL_MULTI_ACCOUNT.md.
import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import {
  POOL_GAME_NAME, POOL_AGENCY_OKPAY_TG_ID,
} from "./schema";
import {
  EPS, round2, isCentExact, computePoolPeriod, carriedPoolOpen, sumPool, settlementMovementFor,
  observationSpread, nonZeroOkpayWarnings, balanceAt, isPoolTimestamp, settlementOccurredAt,
  type BalanceReading, type PoolPeriodComputed, type PoolWarning, type LedgerLine, type WalletKind,
} from "./engine";
import { parseOkpayMessage } from "./okpay-parse";

type DB = BetterSqlite3.Database;

export function poolGameIdOn(db: DB): number {
  const g = db.prepare(`SELECT id FROM games WHERE name = ?`).get(POOL_GAME_NAME) as { id: number } | undefined;
  if (!g) throw new Error(`Game ${POOL_GAME_NAME} absente — la migration add_pool_settlement_v1 n'a pas tourné.`);
  return g.id;
}

// ── Inscription d'un joueur ──────────────────────────────────────────────────

export type PoolPlayerRow = {
  id: number; player_id: number; game_id: number; main_okpay_tg_id: string | null; created_at: string;
  player_name: string; action_pct: number | null;
};

export function getPoolPlayerOn(db: DB, playerId: number): PoolPlayerRow | null {
  const gid = poolGameIdOn(db);
  return (db.prepare(`
    SELECT pp.*, p.name AS player_name, d.action_pct
      FROM pool_players pp
      JOIN players p ON p.id = pp.player_id
      LEFT JOIN player_game_deals d ON d.player_id = pp.player_id AND d.game_id = pp.game_id
     WHERE pp.player_id = ? AND pp.game_id = ?
  `).get(playerId, gid) as PoolPlayerRow | undefined) ?? null;
}

export function listPoolPlayersOn(db: DB): PoolPlayerRow[] {
  const gid = poolGameIdOn(db);
  return db.prepare(`
    SELECT pp.*, p.name AS player_name, d.action_pct
      FROM pool_players pp
      JOIN players p ON p.id = pp.player_id
      LEFT JOIN player_game_deals d ON d.player_id = pp.player_id AND d.game_id = pp.game_id
     WHERE pp.game_id = ? ORDER BY p.name
  `).all(gid) as PoolPlayerRow[];
}

export type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

/**
 * Inscrit un joueur au modèle pool. Idempotent sur (player, game) : réinscrire ne
 * fait que mettre à jour l'ID de la main si un est fourni.
 */
export function enrollPoolPlayerOn(db: DB, playerId: number, mainOkpayTgId: string | null = null): Result<{ id: number }> {
  const gid = poolGameIdOn(db);
  const p = db.prepare(`SELECT id FROM players WHERE id = ?`).get(playerId);
  if (!p) return { ok: false, error: `Joueur ${playerId} introuvable.` };
  if (mainOkpayTgId !== null && !/^\d{5,15}$/.test(mainOkpayTgId)) {
    return { ok: false, error: `ID OkPay « ${mainOkpayTgId} » invalide — attendu l'ID Telegram numérique de l'en-tête du message.` };
  }
  if (mainOkpayTgId !== null) {
    const taken = walletTakenOn(db, mainOkpayTgId, { exceptMainOf: playerId });
    if (taken) return { ok: false, error: `Wallet ${mainOkpayTgId} déjà rattachée : ${taken}. Une wallet n'appartient qu'à un seul pool — sinon son solde compte deux fois.` };
    // CHANGER DE MAIN = même danger que clore un compte à solde ≠ 0 : l'argent de
    // l'ancienne main disparaît du pool, la période suivante lit une perte, je paie ma
    // part d'une perte fictive. Refus tant que le dernier solde main figé n'est pas 0.
    // (Constat money-auditor 2026-09-13, phase 2 B4 : −400 → part fantôme −120.)
    const cur = getPoolPlayerOn(db, playerId);
    if (cur && cur.main_okpay_tg_id !== null && cur.main_okpay_tg_id !== mainOkpayTgId) {
      const lastMain = db.prepare(`
        SELECT b.balance, pp.closed_at FROM pool_period_balances b JOIN pool_periods pp ON pp.id = b.period_id
         WHERE pp.player_id = ? AND pp.game_id = ? AND b.wallet_kind = 'main' ORDER BY pp.closed_at DESC, pp.id DESC LIMIT 1
      `).get(playerId, gid) as { balance: number; closed_at: string } | undefined;
      if (lastMain && lastMain.balance > EPS) {
        return { ok: false, error: `Changer la main de ${cur.main_okpay_tg_id} vers ${mainOkpayTgId} refusé : l'ancienne main portait ${lastMain.balance.toFixed(2)} à la dernière clôture (${lastMain.closed_at}). `
                                + `Vide-la vers la nouvelle, clôture une période à main 0, puis change.` };
      }
    }
  }
  db.prepare(`INSERT OR IGNORE INTO pool_players (player_id, game_id) VALUES (?, ?)`).run(playerId, gid);
  if (mainOkpayTgId !== null) {
    db.prepare(`UPDATE pool_players SET main_okpay_tg_id = ? WHERE player_id = ? AND game_id = ?`).run(mainOkpayTgId, playerId, gid);
  }
  const row = db.prepare(`SELECT id FROM pool_players WHERE player_id = ? AND game_id = ?`).get(playerId, gid) as { id: number };
  return { ok: true, id: row.id };
}

/**
 * Une wallet OkPay est-elle déjà prise (main d'un joueur, compte OUVERT, agence) ?
 * Rend une description nommée, ou null. Les index uniques du schéma sont la
 * garantie ; ceci donne le message, et couvre le croisement main ↔ compte que
 * deux index séparés ne voient pas. (Constat money-auditor 2026-09-13, phase 2 B.)
 */
function walletTakenOn(db: DB, tgId: string, opts: { exceptMainOf?: number; exceptAccount?: number } = {}): string | null {
  if (tgId === POOL_AGENCY_OKPAY_TG_ID) return "c'est la wallet de l'agence";
  const gid = poolGameIdOn(db);
  const main = db.prepare(`
    SELECT pp.player_id, p.name FROM pool_players pp JOIN players p ON p.id = pp.player_id
     WHERE pp.game_id = ? AND pp.main_okpay_tg_id = ?
  `).get(gid, tgId) as { player_id: number; name: string } | undefined;
  if (main && main.player_id !== opts.exceptMainOf) return `main de ${main.name}`;
  const acc = db.prepare(`
    SELECT a.id, a.label, p.name FROM pool_accounts a JOIN players p ON p.id = a.player_id
     WHERE a.game_id = ? AND a.okpay_tg_id = ? AND a.closed_at IS NULL
  `).get(gid, tgId) as { id: number; label: string; name: string } | undefined;
  if (acc && acc.id !== opts.exceptAccount) return `${acc.label} de ${acc.name}`;
  return null;
}

// ── Comptes ─────────────────────────────────────────────────────────────────

export type PoolAccountRow = {
  id: number; player_id: number; game_id: number; label: string; ak_ref: string | null; okpay_tg_id: string | null;
  created_at: string; closed_at: string | null; closed_in_period_id: number | null;
};

export function listAccountsOn(db: DB, playerId: number, includeClosed = false): PoolAccountRow[] {
  const gid = poolGameIdOn(db);
  return db.prepare(`
    SELECT * FROM pool_accounts WHERE player_id = ? AND game_id = ? ${includeClosed ? "" : "AND closed_at IS NULL"}
     ORDER BY id
  `).all(playerId, gid) as PoolAccountRow[];
}

export function addAccountOn(
  db: DB, args: { player_id: number; label?: string | null; ak_ref?: string | null; okpay_tg_id?: string | null },
): Result<{ id: number; label: string }> {
  const gid = poolGameIdOn(db);
  if (!getPoolPlayerOn(db, args.player_id)) return { ok: false, error: `Joueur ${args.player_id} non inscrit au modèle pool.` };
  if (args.okpay_tg_id && !/^\d{5,15}$/.test(args.okpay_tg_id)) {
    return { ok: false, error: `ID OkPay « ${args.okpay_tg_id} » invalide.` };
  }
  if (args.okpay_tg_id) {
    const taken = walletTakenOn(db, args.okpay_tg_id);
    if (taken) return { ok: false, error: `Wallet ${args.okpay_tg_id} déjà rattachée : ${taken}. Une wallet n'appartient qu'à un seul pool.` };
  }
  // Libellé par défaut : « Compte N », N = nombre de comptes jamais créés + 1 (les
  // clos comptent : un « Compte 2 » clos ne doit pas renaître sous le même nom).
  const n = (db.prepare(`SELECT COUNT(*) AS n FROM pool_accounts WHERE player_id = ? AND game_id = ?`).get(args.player_id, gid) as { n: number }).n;
  const label = (args.label ?? "").trim() || `Compte ${n + 1}`;
  const ins = db.prepare(`
    INSERT INTO pool_accounts (player_id, game_id, label, ak_ref, okpay_tg_id) VALUES (?, ?, ?, ?, ?)
  `).run(args.player_id, gid, label, args.ak_ref ?? null, args.okpay_tg_id ?? null);
  return { ok: true, id: Number(ins.lastInsertRowid), label };
}

/**
 * CAS LIMITE N°1 — clore un compte qui a encore un solde ferait disparaître cet
 * argent du pool : la période suivante lirait une perte, et je paierais ma part
 * d'une perte fictive. REFUS tant que les DERNIERS soldes figés du compte (AK et
 * OkPay, dans la dernière période où il apparaît) ne sont pas tous deux à 0.
 *
 * Un compte qui n'a jamais été figé n'a jamais porté d'argent connu : il se clôt.
 * Soft-close : la ligne reste, référencée par les soldes passés. Jamais de DELETE.
 */
export function closeAccountOn(db: DB, accountId: number): Result<{ closed_in_period_id: number | null }> {
  const acc = db.prepare(`SELECT * FROM pool_accounts WHERE id = ?`).get(accountId) as PoolAccountRow | undefined;
  if (!acc) return { ok: false, error: `Compte ${accountId} introuvable.` };
  if (acc.closed_at !== null) return { ok: false, error: `${acc.label} est déjà clos (${acc.closed_at}).` };

  const last = db.prepare(`
    SELECT pp.id AS period_id, pp.closed_at
      FROM pool_period_balances b JOIN pool_periods pp ON pp.id = b.period_id
     WHERE b.account_id = ? ORDER BY pp.closed_at DESC, pp.id DESC LIMIT 1
  `).get(accountId) as { period_id: number; closed_at: string } | undefined;

  if (last) {
    const bals = db.prepare(`
      SELECT wallet_kind, balance FROM pool_period_balances WHERE period_id = ? AND account_id = ?
    `).all(last.period_id, accountId) as { wallet_kind: WalletKind; balance: number }[];
    const nonZero = bals.filter(b => b.balance > EPS);
    if (nonZero.length > 0) {
      return {
        ok: false,
        error: `${acc.label} porte encore de l'argent à la dernière clôture (${last.closed_at}) : `
             + nonZero.map(b => `${b.wallet_kind.toUpperCase()} ${b.balance.toFixed(2)}`).join(", ")
             + `. Le clore ferait disparaître ce montant du pool — vide-le d'abord (vers la main), clôture une période à 0, puis supprime.`,
      };
    }
  }
  db.prepare(`UPDATE pool_accounts SET closed_at = datetime('now'), closed_in_period_id = ? WHERE id = ?`)
    .run(last?.period_id ?? null, accountId);
  return { ok: true, closed_in_period_id: last?.period_id ?? null };
}

// ── Grand livre OkPay ───────────────────────────────────────────────────────

/** À qui appartient une wallet OkPay, d'après pool_players / pool_accounts. */
export type WalletOwner =
  | { kind: "main"; player_id: number; player_name: string }
  | { kind: "account"; player_id: number; player_name: string; account_id: number; label: string }
  | { kind: "agency" }
  | { kind: "unknown" };

export type IngestResult = Result<{
  wallet_tg_id: string; wallet_label: string | null;
  inserted: number; ignored: number; skipped_other_currency: number;
  owner: WalletOwner;
  /** Mouvements de règlement datés au jour dont la seconde vient d'être résolue par cette page. */
  resolved_settlements: number;
}>;

export function walletOwnerOn(db: DB, walletTgId: string): WalletOwner {
  if (walletTgId === POOL_AGENCY_OKPAY_TG_ID) return { kind: "agency" };
  const gid = poolGameIdOn(db);
  const main = db.prepare(`
    SELECT pp.player_id, p.name FROM pool_players pp JOIN players p ON p.id = pp.player_id
     WHERE pp.game_id = ? AND pp.main_okpay_tg_id = ?
  `).get(gid, walletTgId) as { player_id: number; name: string } | undefined;
  if (main) return { kind: "main", player_id: main.player_id, player_name: main.name };
  const acc = db.prepare(`
    SELECT a.id, a.label, a.player_id, p.name FROM pool_accounts a JOIN players p ON p.id = a.player_id
     WHERE a.game_id = ? AND a.okpay_tg_id = ? ORDER BY a.closed_at IS NOT NULL, a.id LIMIT 1
  `).get(gid, walletTgId) as { id: number; label: string; player_id: number; name: string } | undefined;
  if (acc) return { kind: "account", player_id: acc.player_id, player_name: acc.name, account_id: acc.id, label: acc.label };
  return { kind: "unknown" };
}

/**
 * Ingère un message OkPay (transféré au bot, ou collé). Tout-ou-rien côté parseur ;
 * côté base, INSERT OR IGNORE sur dedup_key : le même message deux fois = 0 ligne.
 * La wallet est conservée même inconnue — c'est un fait, le rattachement viendra.
 */
export function ingestOkpayMessageOn(db: DB, text: string, source: "telegram_forward" | "paste"): IngestResult {
  const parsed = parseOkpayMessage(text);
  if (!parsed.ok) return parsed;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO okpay_ledger_lines
      (wallet_tg_id, wallet_label, direction, amount, currency, balance_after, occurred_at,
       counterparty_tg_id, counterparty_name, raw_text, dedup_key, ingest_source)
    VALUES (@wallet_tg_id, @wallet_label, @direction, @amount, 'USDT', @balance_after, @occurred_at,
            @counterparty_tg_id, @counterparty_name, @raw_text, @dedup_key, @source)
  `);
  let inserted = 0;
  db.transaction(() => {
    for (const l of parsed.lines) {
      inserted += ins.run({ ...l, wallet_tg_id: parsed.wallet_tg_id, wallet_label: parsed.wallet_label, source }).changes;
    }
  })();
  const owner = walletOwnerOn(db, parsed.wallet_tg_id);
  // Une page de MAIN peut porter la seconde exacte d'un règlement daté au jour.
  let resolved = 0;
  if (owner.kind === "main" && inserted > 0) resolved = resolveSettlementInstantsOn(db, owner.player_id);
  return {
    ok: true, wallet_tg_id: parsed.wallet_tg_id, wallet_label: parsed.wallet_label,
    inserted, ignored: parsed.lines.length - inserted, skipped_other_currency: parsed.skipped.length,
    owner, resolved_settlements: resolved,
  };
}

/** Jour ± n, au format YYYY-MM-DD. */
function shiftDay(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Les lignes agence du grand livre de la main qui peuvent être CE règlement :
 * même sens, même montant au centime (le grand livre est au millionième),
 * contrepartie = agence, dans la fenêtre [jour−1, jour+1] du mouvement — le jour
 * de paid_date est en calendrier UTC, celui d'OkPay est inconnu, un jour d'écart
 * est normal — et STRICTEMENT après la clôture réglée (une ligne antérieure dirait
 * « payé avant la photo », cf. settlementCandidatesBeforeCloseOn).
 */
function settlementCandidatesOn(
  db: DB, mainTgId: string, m: { direction: "in" | "out"; amount: number; occurred_at: string; closed_at: string },
): { id: number; occurred_at: string }[] {
  const day = m.occurred_at.slice(0, 10);
  // « NOT IN … okpay_line_id » : une ligne déjà attribuée à un règlement ne peut pas
  // en dater un second — deux pertes égales à un jour d'écart, payées l'une après la
  // photo de l'autre, se résolvaient toutes deux sur la première ligne (R1).
  return db.prepare(`
    SELECT id, occurred_at FROM okpay_ledger_lines
     WHERE wallet_tg_id = ? AND counterparty_tg_id = ? AND direction = ?
       AND substr(occurred_at, 1, 10) BETWEEN ? AND ? AND abs(amount - ?) < 0.005 AND occurred_at > ?
       AND id NOT IN (SELECT okpay_line_id FROM pool_external_movements WHERE okpay_line_id IS NOT NULL)
     ORDER BY occurred_at, id
  `).all(mainTgId, POOL_AGENCY_OKPAY_TG_ID, m.direction === "in" ? "+" : "-", shiftDay(day, -1), shiftDay(day, 1), m.amount, m.closed_at) as
    { id: number; occurred_at: string }[];
}

/**
 * §4, précision — donne aux mouvements de règlement datés au JOUR leur seconde
 * réelle, lue sur le grand livre de la main (cf. settlementCandidatesOn). UNE seule
 * candidate, sinon on ne tranche pas. Ne touche JAMAIS un mouvement déjà 'second' :
 * une résolution rejouée ne doit pas déplacer un instant déjà figé dans une somme.
 * Rend le nombre de mouvements résolus.
 */
export function resolveSettlementInstantsOn(db: DB, playerId: number): number {
  const gid = poolGameIdOn(db);
  const pp = getPoolPlayerOn(db, playerId);
  if (!pp?.main_okpay_tg_id) return 0;
  const pending = db.prepare(`
    SELECT m.id, m.direction, m.amount, m.occurred_at, pp.closed_at
      FROM pool_external_movements m JOIN pool_periods pp ON pp.settlement_id = m.settlement_id
     WHERE m.player_id = ? AND m.game_id = ? AND m.kind = 'settlement' AND m.occurred_precision = 'day'
  `).all(playerId, gid) as { id: number; direction: "in" | "out"; amount: number; occurred_at: string; closed_at: string }[];
  if (pending.length === 0) return 0;
  const upd = db.prepare(`
    UPDATE pool_external_movements SET occurred_at = ?, occurred_precision = 'second', okpay_line_id = ?
     WHERE id = ? AND occurred_precision = 'day'
  `);
  let n = 0;
  for (const m of pending) {
    const cands = settlementCandidatesOn(db, pp.main_okpay_tg_id, m);
    if (cands.length !== 1) continue;
    n += upd.run(cands[0].occurred_at, cands[0].id, m.id).changes;
  }
  return n;
}

export type LedgerRow = LedgerLine & { id: number; wallet_tg_id: string; counterparty_name: string | null; ingested_at: string };

export function getLedgerOn(db: DB, walletTgId: string): LedgerRow[] {
  return db.prepare(`
    SELECT id, wallet_tg_id, direction, amount, balance_after, occurred_at, counterparty_tg_id, counterparty_name, ingested_at
      FROM okpay_ledger_lines WHERE wallet_tg_id = ? ORDER BY occurred_at, id
  `).all(walletTgId) as LedgerRow[];
}

// ── Mouvements externes déclarés ─────────────────────────────────────────────

export type MovementRow = {
  id: number; direction: "in" | "out"; amount: number; occurred_at: string; kind: "declared" | "settlement";
  occurred_precision: "second" | "day";
  okpay_line_id: number | null;
  settlement_id: number | null; note: string | null; created_at: string;
};

export function listMovementsOn(db: DB, playerId: number): MovementRow[] {
  const gid = poolGameIdOn(db);
  return db.prepare(`
    SELECT id, direction, amount, occurred_at, kind, occurred_precision, okpay_line_id, settlement_id, note, created_at
      FROM pool_external_movements WHERE player_id = ? AND game_id = ? ORDER BY occurred_at, id
  `).all(playerId, gid) as MovementRow[];
}

function lastPeriodOn(db: DB, playerId: number, gid: number): PoolPeriodRow | null {
  return (db.prepare(`
    SELECT * FROM pool_periods WHERE player_id = ? AND game_id = ? ORDER BY closed_at DESC, id DESC LIMIT 1
  `).get(playerId, gid) as PoolPeriodRow | undefined) ?? null;
}

/**
 * Un mouvement externe DÉCLARÉ par Baki (entrée ou sortie du pool, hors règlement).
 * Refusé s'il tombe dans une période déjà figée : sa somme est figée sans lui, il
 * serait compté nulle part. Il se déclare dans la période OUVERTE, ou on déverrouille.
 */
export function addDeclaredMovementOn(
  db: DB, args: { player_id: number; direction: "in" | "out"; amount: number; occurred_at: string; note?: string | null },
): Result<{ id: number }> {
  const gid = poolGameIdOn(db);
  if (!getPoolPlayerOn(db, args.player_id)) return { ok: false, error: `Joueur ${args.player_id} non inscrit au modèle pool.` };
  if (args.direction !== "in" && args.direction !== "out") return { ok: false, error: `Sens « ${args.direction} » invalide.` };
  if (!Number.isFinite(args.amount) || args.amount <= 0) return { ok: false, error: `Montant « ${args.amount} » : positif attendu (le sens est porté par entrée/sortie).` };
  if (!isCentExact(args.amount)) return { ok: false, error: `Montant ${args.amount} : deux décimales maximum.` };
  if (!isPoolTimestamp(args.occurred_at)) return { ok: false, error: `Date « ${args.occurred_at} » — attendu YYYY-MM-DD HH:MM:SS, date existante.` };
  const last = lastPeriodOn(db, args.player_id, gid);
  if (!last) {
    // Avant la première clôture, l'intervalle est vide : un mouvement n'y compterait
    // jamais, et deviendrait insupprimable une fois la période figée.
    return { ok: false, error: `Aucune période figée pour ce joueur : le pool de DÉPART se saisit, les mouvements externes se déclarent après la première clôture.` };
  }
  if (args.occurred_at <= last.closed_at) {
    return { ok: false, error: `Date ${args.occurred_at} dans une période déjà figée (close le ${last.closed_at}) : sa somme est figée sans ce mouvement. `
                            + `Déclare-le après cette clôture, ou déverrouille la période.` };
  }
  const ins = db.prepare(`
    INSERT INTO pool_external_movements (player_id, game_id, direction, amount, occurred_at, kind, note)
    VALUES (?, ?, ?, ?, ?, 'declared', ?)
  `).run(args.player_id, gid, args.direction, args.amount, args.occurred_at, args.note ?? null);
  return { ok: true, id: Number(ins.lastInsertRowid) };
}

/** Retire un mouvement DÉCLARÉ, tant qu'il n'est pas figé dans une période. Un mouvement de règlement ne se retire pas ici. */
export function deleteDeclaredMovementOn(db: DB, movementId: number): Result<{}> {
  const gid = poolGameIdOn(db);
  const m = db.prepare(`SELECT * FROM pool_external_movements WHERE id = ? AND game_id = ?`).get(movementId, gid) as
    (MovementRow & { player_id: number }) | undefined;
  if (!m) return { ok: false, error: `Mouvement ${movementId} introuvable.` };
  if (m.kind !== "declared") return { ok: false, error: `Le mouvement ${movementId} est un règlement (#${m.settlement_id}) : il se gère depuis /payments, pas ici.` };
  const last = lastPeriodOn(db, m.player_id, gid);
  if (last && m.occurred_at <= last.closed_at) {
    return { ok: false, error: `Mouvement daté ${m.occurred_at}, déjà figé dans la période close le ${last.closed_at}. Déverrouille-la d'abord.` };
  }
  db.prepare(`DELETE FROM pool_external_movements WHERE id = ?`).run(movementId);
  return { ok: true };
}

// ── Aperçu et verrouillage d'une période ─────────────────────────────────────

export type PoolPeriodRow = {
  id: number; player_id: number; game_id: number; opened_at: string; closed_at: string;
  pool_open: number; pool_open_source: "carry" | "manual"; pool_close: number; ext_in: number; ext_out: number;
  result: number; action_pct: number; action_amount: number; settlement_id: number | null; note: string | null; locked_at: string;
  settlement_status?: "locked" | "paid" | null;
};

export function getPeriodsOn(db: DB, playerId: number): PoolPeriodRow[] {
  const gid = poolGameIdOn(db);
  return db.prepare(`
    SELECT pp.*, ms.status AS settlement_status
      FROM pool_periods pp LEFT JOIN manual_settlements ms ON ms.id = pp.settlement_id
     WHERE pp.player_id = ? AND pp.game_id = ? ORDER BY pp.closed_at, pp.id
  `).all(playerId, gid) as PoolPeriodRow[];
}

export type PeriodBalanceRow = {
  id: number; period_id: number; account_id: number | null; wallet_kind: WalletKind; balance: number;
  observed_at: string; source: "manual" | "okpay_ledger"; okpay_line_id: number | null; label: string;
};

export function getPeriodBalancesOn(db: DB, periodId: number): PeriodBalanceRow[] {
  return db.prepare(`
    SELECT b.*, COALESCE(a.label, 'main') AS label
      FROM pool_period_balances b LEFT JOIN pool_accounts a ON a.id = b.account_id
     WHERE b.period_id = ? ORDER BY b.account_id IS NULL, b.account_id, b.wallet_kind
  `).all(periodId) as PeriodBalanceRow[];
}

/** Un solde saisi à l'écran. account_id null = la main (facultatif : sinon lue sur le grand livre). */
export type BalanceInput = { account_id: number | null; wallet_kind: WalletKind; balance: number; observed_at: string };

export type PreviewArgs = {
  player_id: number;
  /** L'instant de clôture choisi, « YYYY-MM-DD HH:MM:SS ». */
  closed_at: string;
  balances: BalanceInput[];
  /** Première période seulement : le pool de départ, SAISI. */
  pool_open_manual?: number | null;
  note?: string | null;
  /** « Maintenant », au format pool — injecté pour la testabilité. */
  now: string;
};

export type PoolPreview = {
  player_id: number; player_name: string;
  opened_at: string; closed_at: string;
  is_first: boolean;
  action_pct: number;
  pool_open: number | null; pool_open_source: "carry" | "manual"; carried_from: string | null;
  /** Les soldes tels qu'ils seront figés (main résolue depuis le grand livre si non saisie). */
  readings: (BalanceReading & { source: "manual" | "okpay_ledger"; okpay_line_id: number | null })[];
  pool_close: number | null;
  ext_in: number; ext_out: number; movements: MovementRow[];
  warnings: PoolWarning[];
  /** Refus DURS : tant qu'il y en a, le verrouillage est impossible. */
  blockers: string[];
  computed: PoolPeriodComputed | null;
};

/**
 * Tout ce qu'il faut pour afficher — et pour verrouiller — une période. Le
 * verrouillage rappelle cette fonction et recalcule.
 */
export function previewPoolPeriodOn(db: DB, args: PreviewArgs): Result<{ preview: PoolPreview }> {
  const gid = poolGameIdOn(db);
  const pp = getPoolPlayerOn(db, args.player_id);
  if (!pp) return { ok: false, error: `Joueur ${args.player_id} non inscrit au modèle pool.` };
  if (!isPoolTimestamp(args.closed_at)) return { ok: false, error: `Clôture « ${args.closed_at} » — attendu YYYY-MM-DD HH:MM:SS, date existante.` };
  if (!isPoolTimestamp(args.now)) return { ok: false, error: `Horloge « ${args.now} » invalide.` };

  const blockers: string[] = [];
  const warnings: PoolWarning[] = [];

  if (args.closed_at > args.now) blockers.push(`Clôture ${args.closed_at} dans le futur (maintenant ${args.now}).`);

  // Part d'action : player_game_deals, figée au lock.
  const actionPct = pp.action_pct ?? 0;
  if (actionPct <= 0) blockers.push(`Aucune part d'action sur ${POOL_GAME_NAME} pour ${pp.player_name} (player_game_deals) — le règlement pool ne concerne que les joueurs stakés.`);

  // ── La chaîne des périodes ──
  const last = lastPeriodOn(db, args.player_id, gid);
  let openedAt: string, poolOpen: number | null = null, poolOpenSource: "carry" | "manual" = "manual", carriedFrom: string | null = null;
  if (last) {
    if (args.closed_at <= last.closed_at) {
      blockers.push(`Clôture ${args.closed_at} antérieure ou égale à la dernière période figée (${last.closed_at}). La chaîne se remonte dans l'ordre : déverrouille d'abord.`);
    }
    openedAt = last.closed_at;
    poolOpen = carriedPoolOpen(last);
    poolOpenSource = "carry";
    carriedFrom = last.closed_at;

    // RÈGLE D'EXPLOITATION §4 : le règlement précédent doit être marqué payé (à sa
    // date réelle) avant de clôturer par-dessus. Tant qu'il est 'locked', on ne sait
    // pas si l'argent a bougé ; s'il a bougé, la photo de clôture le contient mais le
    // calcul l'ignore → part fantôme. Et une fois cette période figée, le vrai
    // paiement deviendrait inenregistrable (sa date tomberait dans une somme figée).
    const enAttente = db.prepare(`
      SELECT pp.closed_at, pp.settlement_id, pp.action_amount
        FROM pool_periods pp JOIN manual_settlements ms ON ms.id = pp.settlement_id
       WHERE pp.player_id = ? AND pp.game_id = ? AND ms.status = 'locked' ORDER BY pp.closed_at
    `).all(args.player_id, gid) as { closed_at: string; settlement_id: number; action_amount: number }[];
    for (const r of enAttente) {
      const sens = r.action_amount < 0 ? `tu lui dois ${(-r.action_amount).toFixed(2)}` : `il te doit ${r.action_amount.toFixed(2)}`;
      blockers.push(`Règlement #${r.settlement_id} de la période close le ${r.closed_at} pas encore marqué payé (${sens}). `
                  + `Marque-le payé À SA DATE RÉELLE dans /payments d'abord : l'argent a traversé le pool et doit compter dans la période où il est tombé.`);
    }
  } else {
    // Première période : l'intervalle est vide, le pool de départ est SAISI.
    openedAt = args.closed_at;
    if (args.pool_open_manual !== null && args.pool_open_manual !== undefined) {
      if (!Number.isFinite(args.pool_open_manual) || args.pool_open_manual < 0 || !isCentExact(args.pool_open_manual)) {
        blockers.push(`Pool de départ « ${args.pool_open_manual} » invalide — positif, deux décimales maximum.`);
      } else poolOpen = args.pool_open_manual;
    }
    // poolOpen reste null si non fourni : l'écran doit le DEMANDER. Jamais 0 par
    // défaut, jamais repris d'AKS (arbitrage Baki 1c : deux histoires séparées).
  }

  // ── Les soldes ──
  const accounts = listAccountsOn(db, args.player_id, false);
  const accById = new Map(accounts.map(a => [a.id, a]));
  const readings: PoolPreview["readings"] = [];
  const seen = new Set<string>();
  let mainGiven = false;

  for (const b of args.balances) {
    const key = `${b.account_id ?? "main"}:${b.wallet_kind}`;
    if (seen.has(key)) { blockers.push(`Solde en double : ${key}.`); continue; }
    seen.add(key);
    if (!isPoolTimestamp(b.observed_at)) { blockers.push(`Horodatage « ${b.observed_at} » (${key}) — attendu YYYY-MM-DD HH:MM:SS.`); continue; }
    if (b.wallet_kind === "main") {
      if (b.account_id !== null) { blockers.push(`La main n'appartient à aucun compte (reçu account_id ${b.account_id}).`); continue; }
      mainGiven = true;
      readings.push({ account_id: null, label: "main", wallet_kind: "main", balance: b.balance, observed_at: b.observed_at, source: "manual", okpay_line_id: null });
    } else {
      if (b.account_id === null) { blockers.push(`Solde ${b.wallet_kind.toUpperCase()} sans compte.`); continue; }
      const acc = accById.get(b.account_id);
      if (!acc) { blockers.push(`Compte ${b.account_id} inconnu, clos, ou d'un autre joueur.`); continue; }
      readings.push({ account_id: acc.id, label: acc.label, wallet_kind: b.wallet_kind, balance: b.balance, observed_at: b.observed_at, source: "manual", okpay_line_id: null });
    }
  }
  // Chaque compte ouvert doit avoir SES DEUX soldes.
  for (const a of accounts) {
    for (const k of ["ak", "okpay"] as const) {
      if (!seen.has(`${a.id}:${k}`)) blockers.push(`${a.label} : solde ${k.toUpperCase()} manquant.`);
    }
  }
  // La main : saisie, ou lue sur le grand livre à l'instant de clôture.
  if (!mainGiven) {
    if (!pp.main_okpay_tg_id) {
      blockers.push(`Solde main manquant, et aucune wallet main OkPay rattachée à ${pp.player_name} : transfère son historique OkPay (l'en-tête l'identifie) ou saisis le solde.`);
    } else {
      const lines = getLedgerOn(db, pp.main_okpay_tg_id);
      const at = balanceAt(lines, args.closed_at);
      if (!at) {
        blockers.push(`Aucune ligne OkPay de la main (${pp.main_okpay_tg_id}) antérieure au ${args.closed_at} : le solde main est inconnu — transfère la page, ou saisis-le.`);
      } else if (at.ambiguity) {
        blockers.push(`Solde main indéterminable au ${args.closed_at} : plusieurs opérations à ${at.ambiguity.occurred_at} dont l'ordre ne peut pas être établi `
                    + `(soldes possibles : ${at.ambiguity.possible_final_balances.map(x => x.toFixed(6)).join(" / ")}). Transfère la page suivante, ou saisis le solde.`);
      } else {
        // LA FRONTIÈRE : 6 décimales au grand livre, le centime dans le pool.
        readings.push({ account_id: null, label: "main", wallet_kind: "main", balance: at.pool_balance, observed_at: at.line.occurred_at,
                        source: "okpay_ledger", okpay_line_id: (at.line as LedgerRow).id });
        // Le solde OkPay de la main est vrai à l'instant de sa dernière ligne ; s'il y a
        // des lignes APRÈS la clôture, elles sont ignorées (période suivante) — signal.
        const after = lines.filter(l => l.occurred_at > args.closed_at).length;
        if (after > 0) warnings.push({ code: "main_stale", message: `${after} opération(s) de la main postérieures à la clôture — ignorées ici, elles comptent pour la période suivante.` });
      }
    }
  }

  // Main SAISIE alors que le grand livre dit autre chose au même instant : la saisie
  // gagne (Baki a peut-être une page plus fraîche sous les yeux), mais on le dit.
  if (mainGiven && pp.main_okpay_tg_id) {
    const at = balanceAt(getLedgerOn(db, pp.main_okpay_tg_id), args.closed_at);
    const given = readings.find(r => r.wallet_kind === "main")!;
    if (at && !at.ambiguity && Math.abs(at.pool_balance - given.balance) > EPS) {
      warnings.push({ code: "main_conflict", message: `Main saisie ${given.balance.toFixed(2)} mais le grand livre OkPay dit ${at.pool_balance.toFixed(2)} au ${at.line.occurred_at}. La saisie l'emporte — vérifie laquelle est à jour.` });
    }
  }

  let poolClose: number | null = null;
  if (readings.some(r => r.wallet_kind === "main")) {
    const sum = sumPool(readings);
    if (sum.ok) poolClose = sum.value; else blockers.push(sum.error);
  }
  warnings.push(...nonZeroOkpayWarnings(readings));
  const spread = observationSpread(readings);
  if (spread.warning) warnings.push(spread.warning);

  // ── Mouvements externes de l'intervalle ]opened_at, closed_at] ──
  const movements = listMovementsOn(db, args.player_id).filter(m => m.occurred_at > openedAt && m.occurred_at <= args.closed_at);
  const extIn = round2(movements.filter(m => m.direction === "in").reduce((s, m) => s + m.amount, 0));
  const extOut = round2(movements.filter(m => m.direction === "out").reduce((s, m) => s + m.amount, 0));

  // §4, PRÉCISION — un règlement daté au JOUR : son instant réel est inconnu, et son
  // JOUR même peut différer d'un jour de celui du grand livre (paid_date est en
  // calendrier UTC, OkPay dans un fuseau non établi). Toute clôture à ±1 jour de ce
  // jour — que le mouvement tombe dans l'intervalle ou juste après — ne peut pas
  // savoir si l'argent était dans la photo : payé à 19:00 après une photo à 17:59,
  // ou payé « le 21 » OkPay pour un paid_date du 20, le mouvement serait compté
  // contre une photo qui ne le contient pas → part fantôme. REFUS tant que la
  // seconde n'est pas résolue (la page OkPay de la main porte la ligne agence).
  // Au-delà de ±1 jour, l'instant réel est forcément du même côté de la clôture que
  // le jour déclaré, quel que soit le fuseau. (Constats money-auditor 2026-09-13,
  // phase 2 A puis A'.)
  const closedDay = args.closed_at.slice(0, 10);
  const allMovements = listMovementsOn(db, args.player_id);
  for (const m of allMovements) {
    if (m.kind !== "settlement" || m.occurred_precision !== "day") continue;
    const mDay = m.occurred_at.slice(0, 10);
    if (closedDay >= shiftDay(mDay, -1) && closedDay <= shiftDay(mDay, 1)) {
      blockers.push(`Règlement #${m.settlement_id} payé le ${mDay} (heure inconnue, jour ± 1 selon le fuseau OkPay), trop proche de cette clôture (${closedDay}) : impossible de savoir si les `
                  + `${m.amount.toFixed(2)} étaient déjà dans le pool à ${args.closed_at}. Transfère la page OkPay de la main (la ligne agence donne la seconde exacte), ou clôture à 2 jours au moins.`);
    }
  }
  // Résolution devenue AMBIGUË après coup : une seconde ligne agence identique est
  // arrivée depuis. La première a peut-être été un autre virement (à déclarer à part).
  // Et « payé AVANT la photo » : une ligne agence identique antérieure à la clôture
  // réglée dit que le montant était déjà dans le pool de fin — la période réglée est
  // fausse, et un règlement payé ne se déverrouille pas : on le dit, fort.
  if (pp.main_okpay_tg_id) {
    for (const m of allMovements) {
      if (m.kind !== "settlement") continue;
      const per = db.prepare(`SELECT closed_at FROM pool_periods WHERE settlement_id = ?`).get(m.settlement_id) as { closed_at: string } | undefined;
      if (!per) continue;
      // settlementCandidatesOn exclut les lignes déjà portées — donc la sienne : toute
      // AUTRE candidate libre rend la résolution ambiguë.
      const others = settlementCandidatesOn(db, pp.main_okpay_tg_id, { ...m, closed_at: per.closed_at });
      if (m.occurred_precision === "second" && m.okpay_line_id !== null && others.length > 0) {
        warnings.push({ code: "resolution_ambiguous", message: `Règlement #${m.settlement_id} daté sur la ligne OkPay ${m.occurred_at}, mais ${others.length} autre(s) ligne(s) agence identique(s) existe(nt) (${others.map(c => c.occurred_at).join(", ")}) : vérifie laquelle est le règlement — l'autre est un mouvement externe à déclarer.` });
      }
      const before = db.prepare(`
        SELECT occurred_at FROM okpay_ledger_lines
         WHERE wallet_tg_id = ? AND counterparty_tg_id = ? AND direction = ? AND abs(amount - ?) < 0.005
           AND occurred_at <= ? AND substr(occurred_at, 1, 10) >= ?
      `).all(pp.main_okpay_tg_id, POOL_AGENCY_OKPAY_TG_ID, m.direction === "in" ? "+" : "-", m.amount, per.closed_at, shiftDay(per.closed_at.slice(0, 10), -1)) as { occurred_at: string }[];
      if (before.length > 0 && m.occurred_precision === "day") {
        warnings.push({ code: "paid_before_close", message: `Règlement #${m.settlement_id} : une ligne agence de ${m.amount.toFixed(2)} existe le ${before[0].occurred_at}, AVANT la clôture réglée (${per.closed_at}). Si c'est ce règlement, il était déjà dans la photo : la période réglée est surévaluée d'autant — à traiter à la main.` });
      }
    }
  }
  // Baki déclare à la main le versement que le hook a déjà écrit → compté deux fois.
  for (const st of movements.filter(m => m.kind === "settlement")) {
    const twin = movements.find(m => m.kind === "declared" && m.direction === st.direction && Math.abs(m.amount - st.amount) <= EPS);
    if (twin) warnings.push({ code: "double_declared", message: `Mouvement déclaré ${twin.direction} ${twin.amount.toFixed(2)} (${twin.occurred_at}) identique au règlement #${st.settlement_id} déjà compté : doublon probable — supprime la déclaration.` });
  }

  let computed: PoolPeriodComputed | null = null;
  if (blockers.length === 0 && poolOpen !== null && poolClose !== null) {
    const r = computePoolPeriod({ pool_open: poolOpen, pool_close: poolClose, ext_in: extIn, ext_out: extOut, action_pct: actionPct });
    if (r.ok) computed = r.value; else blockers.push(r.error);
  }

  return {
    ok: true,
    preview: {
      player_id: args.player_id, player_name: pp.player_name, opened_at: openedAt, closed_at: args.closed_at,
      is_first: last === null, action_pct: actionPct,
      pool_open: poolOpen, pool_open_source: poolOpenSource, carried_from: carriedFrom,
      readings, pool_close: poolClose, ext_in: extIn, ext_out: extOut, movements, warnings, blockers, computed,
    },
  };
}

export type LockResult = Result<{ period_id: number; settlement_id: number | null; computed: PoolPeriodComputed; preview: PoolPreview }>;

/**
 * Fige la période. Une seule transaction, tout ou rien. Le montant est recalculé
 * ici ; les avertissements (écart d'horodatage, OkPay non nulle) ne bloquent pas —
 * l'écran a demandé confirmation, c'est l'arbitrage Baki.
 */
export function lockPoolPeriodOn(db: DB, args: PreviewArgs): LockResult {
  const pre = previewPoolPeriodOn(db, args);
  if (!pre.ok) return pre;
  const p = pre.preview;
  if (p.blockers.length > 0) return { ok: false, error: p.blockers.join(" · ") };
  if (p.pool_open === null) {
    return { ok: false, error: `Première période de ${p.player_name} : le pool de départ doit être SAISI. Il n'est pas supposé à 0, et il n'est jamais repris d'AKS — deux histoires séparées.` };
  }
  if (!p.computed || p.pool_close === null) return { ok: false, error: "Pool de fin incalculable." };
  const c = p.computed;
  const gid = poolGameIdOn(db);

  try {
    let out: LockResult = { ok: false, error: "transaction non exécutée" };
    db.transaction(() => {
      let settlementId: number | null = null;
      if (Math.abs(c.action_amount) > EPS) {
        const ins = db.prepare(`
          INSERT INTO manual_settlements (game_id, player_id, net_selected_usdt, action_pct_applied, amount_due_usdt, status, notes, locked_at, kind)
          VALUES (?, ?, ?, ?, ?, 'locked', ?, datetime('now'), 'action')
        `).run(gid, args.player_id, c.result, p.action_pct, c.action_amount, [
          `Pool ${p.opened_at} → ${p.closed_at} : ${p.pool_open!.toFixed(2)} → ${p.pool_close!.toFixed(2)}`,
          `entrées ${p.ext_in.toFixed(2)} · sorties ${p.ext_out.toFixed(2)}`,
          c.transfer_amount > EPS ? `à verser ${c.transfer_amount.toFixed(2)} sur sa main OkPay` : `il règle ${c.action_amount.toFixed(2)} depuis sa main`,
          args.note,
        ].filter(Boolean).join(" — "));
        settlementId = Number(ins.lastInsertRowid);
      }
      const insP = db.prepare(`
        INSERT INTO pool_periods (player_id, game_id, opened_at, closed_at, pool_open, pool_open_source, pool_close, ext_in, ext_out,
                                  result, action_pct, action_amount, settlement_id, note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(args.player_id, gid, p.opened_at, p.closed_at, p.pool_open, p.pool_open_source, p.pool_close, p.ext_in, p.ext_out,
             c.result, p.action_pct, c.action_amount, settlementId, args.note ?? null);
      const periodId = Number(insP.lastInsertRowid);
      const insB = db.prepare(`
        INSERT INTO pool_period_balances (period_id, account_id, wallet_kind, balance, observed_at, source, okpay_line_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of p.readings) insB.run(periodId, r.account_id, r.wallet_kind, r.balance, r.observed_at, r.source, r.okpay_line_id);
      out = { ok: true, period_id: periodId, settlement_id: settlementId, computed: c, preview: p };
    })();
    return out;
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Déverrouille la DERNIÈRE période. Refus si son règlement est payé (de l'argent
 * sorti ne se dé-règle pas). Les comptes clos dans cette période sont réouverts.
 */
export function unlockPoolPeriodOn(db: DB, playerId: number, periodId: number): Result<{ closed_at: string }> {
  const gid = poolGameIdOn(db);
  const row = db.prepare(`SELECT * FROM pool_periods WHERE id = ? AND player_id = ? AND game_id = ?`).get(periodId, playerId, gid) as PoolPeriodRow | undefined;
  if (!row) return { ok: false, error: `Période ${periodId} introuvable pour le joueur ${playerId}.` };
  const last = lastPeriodOn(db, playerId, gid)!;
  if (last.id !== row.id) {
    return { ok: false, error: `Seule la dernière période (close le ${last.closed_at}) est déverrouillable : le pool de départ des suivantes est repris de celle-ci.` };
  }
  if (row.settlement_id !== null) {
    const st = db.prepare(`SELECT status FROM manual_settlements WHERE id = ?`).get(row.settlement_id) as { status: string } | undefined;
    if (st?.status === "paid") return { ok: false, error: `Règlement #${row.settlement_id} déjà marqué payé — déverrouillage interdit. De l'argent sorti ne se dé-règle pas.` };
  }
  // Les comptes clos dans cette période vont RÉOUVRIR : leur wallet a pu être reprise
  // entre-temps (main d'un autre joueur, autre compte). Refus nommé plutôt qu'un état
  // double, ou qu'une erreur UNIQUE brute. (Constat money-auditor 2026-09-13, B1/B2.)
  const toReopen = db.prepare(`SELECT id, label, okpay_tg_id FROM pool_accounts WHERE closed_in_period_id = ?`).all(row.id) as
    { id: number; label: string; okpay_tg_id: string | null }[];
  for (const a of toReopen) {
    if (!a.okpay_tg_id) continue;
    const taken = walletTakenOn(db, a.okpay_tg_id, { exceptAccount: a.id });
    if (taken) return { ok: false, error: `Déverrouiller réouvrirait ${a.label} (wallet ${a.okpay_tg_id}), mais cette wallet est maintenant ${taken}. Détache-la d'abord.` };
  }
  try {
    db.transaction(() => {
      db.prepare(`UPDATE pool_accounts SET closed_at = NULL, closed_in_period_id = NULL WHERE closed_in_period_id = ?`).run(row.id);
      // Les soldes partent en CASCADE avec la période ; la période part AVANT le
      // règlement (sa FK est en NO ACTION — c'est le seul ordre qui passe, et c'est voulu).
      db.prepare(`DELETE FROM pool_periods WHERE id = ?`).run(row.id);
      if (row.settlement_id !== null) {
        const del = db.prepare(`DELETE FROM manual_settlements WHERE id = ? AND status = 'locked'`).run(row.settlement_id);
        if (del.changes !== 1) throw new Error(`Règlement #${row.settlement_id} n'est plus verrouillé — déverrouillage annulé.`);
      }
    })();
    return { ok: true, closed_at: row.closed_at };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

// ── Le hook « marquer payé » — §4 ────────────────────────────────────────────

/**
 * Mouvement de règlement d'une période pool, écrit dans la transaction de markPaid
 * (lib/manual-settlement-engine.ts), ou jamais. Sans effet si le règlement n'est
 * adossé à aucune période pool.
 *
 *   action_amount < 0 → je verse sur sa main → 'in'
 *   action_amount > 0 → il me règle depuis sa main → 'out'
 *
 * Daté par settlementOccurredAt (paid_date est un JOUR, les bornes sont à la
 * SECONDE). paid_date OBLIGATOIRE : l'absence de date n'est pas « aujourd'hui »,
 * c'est une information manquante. CEINTURE : refus si l'instant tombe dans une
 * période déjà figée du joueur — la règle d'exploitation (blocker de preview)
 * rend ce cas impossible, la ceinture le garantit même si un autre chemin
 * l'oubliait. Toute erreur est relancée : elle annule la transaction et le
 * règlement ne passe pas payé sans son mouvement.
 */
export function writePoolSettlementMovementOnPaid(db: DB, settlementId: number, paidDate: string | null): void {
  let per: { id: number; player_id: number; game_id: number; closed_at: string; action_amount: number } | undefined;
  try {
    per = db.prepare(`SELECT id, player_id, game_id, closed_at, action_amount FROM pool_periods WHERE settlement_id = ?`).get(settlementId) as typeof per;
  } catch (e: any) {
    if (!/no such table/i.test(e?.message ?? "")) throw e;
    return;
  }
  if (!per) return;
  if (paidDate === null) {
    throw new Error(`Règlement #${settlementId} adossé à la période pool close le ${per.closed_at} : la date de paiement réelle est obligatoire — `
                  + `le mouvement compte dans la période où l'argent a traversé le pool.`);
  }
  const when = settlementOccurredAt(paidDate, per.closed_at);
  if (!when.ok) throw new Error(`Règlement #${settlementId} : ${when.error}`);
  const gele = db.prepare(`
    SELECT closed_at FROM pool_periods WHERE player_id = ? AND game_id = ? AND id != ? AND closed_at >= ? ORDER BY closed_at LIMIT 1
  `).get(per.player_id, per.game_id, per.id, when.occurred_at) as { closed_at: string } | undefined;
  if (gele) {
    throw new Error(`Règlement #${settlementId} : le paiement daté ${when.occurred_at} tombe dans la période déjà figée close le ${gele.closed_at} — `
                  + `sa somme est figée sans lui. Déverrouille cette période, ou corrige la date.`);
  }
  const mv = settlementMovementFor(per.action_amount);
  if (!mv) return;
  db.prepare(`
    INSERT INTO pool_external_movements (player_id, game_id, direction, amount, occurred_at, occurred_precision, kind, settlement_id, note)
    VALUES (?, ?, ?, ?, ?, ?, 'settlement', ?, ?)
  `).run(per.player_id, per.game_id, mv.direction, mv.amount, when.occurred_at, when.precision, settlementId,
         `Règlement pool de la période close le ${per.closed_at} (payé le ${paidDate})`);
  // La page de la main est peut-être déjà là : la seconde exacte l'emporte sur le jour.
  resolveSettlementInstantsOn(db, per.player_id);
}

/** Refus nommé pour unlockSettlement (/payments) : une période pool référence ce règlement. */
export function poolPeriodForSettlementOn(db: DB, settlementId: number): { closed_at: string; player_id: number } | null {
  try {
    return (db.prepare(`SELECT closed_at, player_id FROM pool_periods WHERE settlement_id = ?`).get(settlementId) as
      { closed_at: string; player_id: number } | undefined) ?? null;
  } catch (e: any) {
    if (!/no such table/i.test(e?.message ?? "")) throw e;
    return null;
  }
}

// ── Formes prod ──────────────────────────────────────────────────────────────
export const getPoolPlayer = (playerId: number) => getPoolPlayerOn(getDb(), playerId);
export const listPoolPlayers = () => listPoolPlayersOn(getDb());
export const enrollPoolPlayer = (playerId: number, main: string | null = null) => enrollPoolPlayerOn(getDb(), playerId, main);
export const listAccounts = (playerId: number, includeClosed = false) => listAccountsOn(getDb(), playerId, includeClosed);
export const addAccount = (args: Parameters<typeof addAccountOn>[1]) => addAccountOn(getDb(), args);
export const closeAccount = (accountId: number) => closeAccountOn(getDb(), accountId);
export const ingestOkpayMessage = (text: string, source: "telegram_forward" | "paste") => ingestOkpayMessageOn(getDb(), text, source);
export const getLedger = (walletTgId: string) => getLedgerOn(getDb(), walletTgId);
export const listMovements = (playerId: number) => listMovementsOn(getDb(), playerId);
export const addDeclaredMovement = (args: Parameters<typeof addDeclaredMovementOn>[1]) => addDeclaredMovementOn(getDb(), args);
export const deleteDeclaredMovement = (id: number) => deleteDeclaredMovementOn(getDb(), id);
export const resolveSettlementInstants = (playerId: number) => resolveSettlementInstantsOn(getDb(), playerId);
export const getPeriods = (playerId: number) => getPeriodsOn(getDb(), playerId);
export const getPeriodBalances = (periodId: number) => getPeriodBalancesOn(getDb(), periodId);
export const previewPoolPeriod = (args: PreviewArgs) => previewPoolPeriodOn(getDb(), args);
export const lockPoolPeriod = (args: PreviewArgs) => lockPoolPeriodOn(getDb(), args);
export const unlockPoolPeriod = (playerId: number, periodId: number) => unlockPoolPeriodOn(getDb(), playerId, periodId);
