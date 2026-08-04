// Joueurs NEXAPOKER : liste, part d'action, ajout manuel, réconciliation.
//
// Deux formes par fonction publique — `x()` sur la base de prod via getDb(), et
// `xOn(db, …)` sur une base explicite — pour que les tests exercent les vraies
// contraintes SQL au lieu de les supposer. Même parti pris que ./affiliate-ingest.
//
// ─────────────────────────────────────────────────────────────────────────────
// LE MIROIR DE LA PART D'ACTION — à lire avant de toucher quoi que ce soit ici.
//
// La part d'action NEXA a DEUX écritures, et c'est délibéré :
//   • nexa_player_action_shares → la VÉRITÉ. Historisée, append-only, une ligne
//     par période. C'est elle qui fera foi au calcul (étape 6).
//   • player_game_deals.action_pct → un CACHE DÉRIVÉ de la période courante.
//     Il n'existe que parce que tout le reste du repo le lit — getPlayerWalletStats
//     joint player_game_deals pour calculer my_pnl, et un joueur NEXA sans cette
//     ligne serait purement et simplement exclu du JOIN.
//
// Les deux sont écrits DANS LA MÊME TRANSACTION par setActionShareOn, et par elle
// seule. Une seule main écrit les deux. Ne jamais modifier player_game_deals.action_pct
// pour NEXAPOKER ailleurs : le cache mentirait sur l'historique dès la première
// divergence. Le garde-fou est posé dans lib/deal-edit.ts (refus explicite du game).
// ─────────────────────────────────────────────────────────────────────────────
import { getDb } from "@/lib/db";
import type BetterSqlite3 from "better-sqlite3";
import { insertWalletTransaction } from "@/lib/queries";
import { NEXA_GAME_NAME, nicknameKey, isMondayISO } from "./affiliate-ingest";

type DB = BetterSqlite3.Database;

function gameId(db: DB): number {
  const g = db.prepare(`SELECT id FROM games WHERE name = ?`).get(NEXA_GAME_NAME) as { id: number } | undefined;
  if (!g) throw new Error(`Game ${NEXA_GAME_NAME} absent — la migration add_nexa_affiliate_v1 n'a pas tourné.`);
  return g.id;
}

/** Lundi précédant `monday` — borne de fermeture d'une période. */
export function previousWeek(monday: string): string {
  const d = new Date(`${monday}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/** Lundi de la semaine en cours — défaut proposé à l'édition d'une part. */
export function currentWeekMonday(today = new Date()): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// ── Liste ─────────────────────────────────────────────────────────────────

export type NexaPlayerRow = {
  player_id: number;
  name: string;
  telegram_handle: string | null;
  member_id: string | null;
  /** Pseudo tel qu'il apparaît dans le report — peut différer de players.name. */
  report_nickname: string | null;
  /** Période EN COURS uniquement (end_week IS NULL). 0 quand rien n'est enregistré. */
  action_pct: number;
  action_since: string | null;
  weeks_count: number;
  total_rake: number;
  total_commission: number;
  /** Nombre de semaines dont le recalcul ne retombe pas — alerte à l'écran. */
  check_ko: number;
  /** Buy-ins cumulés (wallet_transactions type='deposit', game NEXAPOKER). */
  deposited: number;
  /** Cash-outs cumulés (type='withdrawal'). */
  withdrawn: number;
  /** withdrawn − deposited. Positif = j'ai versé plus qu'il n'a acheté. */
  net_movements: number;
  /** Le joueur est-il issu du funnel ? Aujourd'hui la réponse est non pour tous. */
  lead_id: number | null;
};

export function getNexaPlayersOn(db: DB): NexaPlayerRow[] {
  const gid = gameId(db);
  return db.prepare(`
    SELECT
      p.id AS player_id,
      p.name,
      p.telegram_handle,
      pgi.external_id AS member_id,
      w.report_nickname,
      COALESCE(a.pct, 0) AS action_pct,
      a.start_week AS action_since,
      COALESCE(w.weeks_count, 0) AS weeks_count,
      COALESCE(w.total_rake, 0) AS total_rake,
      COALESCE(w.total_commission, 0) AS total_commission,
      COALESCE(w.check_ko, 0) AS check_ko,
      COALESCE(m.deposited, 0) AS deposited,
      COALESCE(m.withdrawn, 0) AS withdrawn,
      COALESCE(m.net_movements, 0) AS net_movements,
      l.id AS lead_id
    FROM players p
    LEFT JOIN player_game_ids pgi ON pgi.player_id = p.id AND pgi.game_id = @gid
    LEFT JOIN nexa_nickname_links nl ON nl.player_id = p.id
    -- Période EN COURS : end_week IS NULL. S'il y en avait plusieurs (anomalie),
    -- on prend la plus récente plutôt que d'en additionner deux.
    LEFT JOIN (
      SELECT player_id, pct, start_week,
             ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY start_week DESC, id DESC) AS rn
      FROM nexa_player_action_shares WHERE end_week IS NULL
    ) a ON a.player_id = p.id AND a.rn = 1
    LEFT JOIN (
      SELECT player_id,
             COUNT(*) AS weeks_count,
             SUM(nlh + mtt + plo + spins) AS total_rake,
             SUM(affiliate_payment) AS total_commission,
             SUM(CASE WHEN check_ok = 0 THEN 1 ELSE 0 END) AS check_ko,
             MAX(nickname) AS report_nickname
      FROM nexa_affiliate_weeks WHERE player_id IS NOT NULL GROUP BY player_id
    ) w ON w.player_id = p.id
    -- Buy-in / cash-out manuels du game NEXAPOKER. Les lignes 'unknown' sont
    -- exclues de tout agrégat (invariant #10), comme partout ailleurs.
    LEFT JOIN (
      SELECT player_id,
             SUM(CASE WHEN type = 'deposit' THEN amount ELSE 0 END) AS deposited,
             SUM(CASE WHEN type = 'withdrawal' THEN amount ELSE 0 END) AS withdrawn,
             SUM(CASE WHEN type = 'withdrawal' THEN amount ELSE -amount END) AS net_movements
      FROM wallet_transactions
      -- currency = 'USDT' : invariant #3, on ne somme jamais des devises
      -- différentes sans toUsdt(). addMovementOn force USDT, mais d'autres
      -- chemins du repo peuvent écrire une autre devise sur ce game_id.
      WHERE game_id = @gid AND (source IS NULL OR source != 'unknown') AND currency = 'USDT'
      GROUP BY player_id
    ) m ON m.player_id = p.id
    LEFT JOIN nexa_leads l ON l.player_id = p.id
    -- Un joueur est « NEXA » s'il porte un lien vers ce game, par ID ou par pseudo.
    WHERE pgi.player_id IS NOT NULL OR nl.player_id IS NOT NULL
    ORDER BY COALESCE(w.total_rake, 0) DESC, p.name
  `).all({ gid }) as NexaPlayerRow[];
}

export function getNexaPlayers(): NexaPlayerRow[] { return getNexaPlayersOn(getDb()); }

/** Rake hebdo d'un joueur, pour la vue détail. */
export type NexaPlayerWeek = {
  week_start: string; nlh: number; mtt: number; plo: number; spins: number;
  rake: number; affiliate_payment: number; check_ok: number; override_reason: string | null;
};

export function getNexaPlayerWeeksOn(db: DB, playerId: number): NexaPlayerWeek[] {
  return db.prepare(`
    SELECT week_start, nlh, mtt, plo, spins, (nlh + mtt + plo + spins) AS rake,
           affiliate_payment, check_ok, override_reason
    FROM nexa_affiliate_weeks WHERE player_id = ? ORDER BY week_start
  `).all(playerId) as NexaPlayerWeek[];
}

export function getNexaPlayerWeeks(playerId: number): NexaPlayerWeek[] {
  return getNexaPlayerWeeksOn(getDb(), playerId);
}

// ── Rattrapage rétroactif ─────────────────────────────────────────────────

/**
 * Rattache TOUT l'historique déjà saisi à un joueur qu'on vient de lier.
 *
 * Possible parce que le lien validé ne vit jamais sur la ligne du report : il vit
 * dans player_game_ids / nexa_nickname_links, et nexa_affiliate_weeks.player_id
 * n'est qu'un cache résolu à l'écriture. On le recalcule ici pour le passé.
 *
 * `WHERE player_id IS NULL` : on ne réécrit JAMAIS un rattachement déjà fait —
 * un lien posé à la main ne doit pas pouvoir être écrasé par un autre.
 */
export function backfillPlayerIdOn(
  db: DB, playerId: number, memberId: string | null, nickKey: string | null,
): number {
  let n = 0;
  const id = String(memberId ?? "").trim();
  if (id !== "") {
    n += db.prepare(
      `UPDATE nexa_affiliate_weeks SET player_id = ? WHERE player_id IS NULL AND member_id = ?`
    ).run(playerId, id).changes;
  }
  if (nickKey) {
    // Uniquement les lignes SANS Member ID : une ligne qui en porte un se rattache
    // par lui, jamais par le pseudo (règle de resolveRows, identique ici).
    n += db.prepare(
      `UPDATE nexa_affiliate_weeks SET player_id = ?
        WHERE player_id IS NULL AND (member_id IS NULL OR member_id = '') AND nickname_key = ?`
    ).run(playerId, nickKey).changes;
  }
  return n;
}

// ── Part d'action ─────────────────────────────────────────────────────────

export type ActionShareResult =
  | { ok: true; created: boolean; closed_previous: string | null; player_id: number }
  | { ok: false; error: string };

/**
 * Enregistre une part d'action à effet d'une semaine donnée.
 *
 * APPEND-ONLY : la période en cours est CLOSE à la semaine précédente et une
 * nouvelle est créée. L'historique n'est jamais modifié — c'est ce qui permettra
 * à l'étape 6 de recalculer une semaine passée avec le % qui s'appliquait alors.
 *
 * Exception unique : si la période en cours commence EXACTEMENT la semaine
 * demandée, on corrige son pct sur place. Ce n'est pas de l'historique réécrit,
 * c'est la même période qu'on rectifie — et la fermer à la semaine précédente
 * violerait la contrainte end_week >= start_week.
 *
 * MIROIR : player_game_deals.action_pct est mis à jour dans la MÊME transaction.
 * Voir l'encadré en tête de fichier. Ne pas dissocier les deux écritures.
 */
export function setActionShareOn(
  db: DB, args: { player_id: number; pct: number; start_week: string; note?: string | null },
): ActionShareResult {
  const { player_id, pct, start_week } = args;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: "La part d'action doit être un nombre entre 0 et 100." };
  }
  if (!isMondayISO(start_week)) {
    return { ok: false, error: `Semaine d'effet « ${start_week} » invalide — attendu la date d'un LUNDI.` };
  }
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(player_id)) {
    return { ok: false, error: `Joueur ${player_id} introuvable.` };
  }
  const gid = gameId(db);

  const run = db.transaction((): { created: boolean; closed: string | null } => {
    const open = db.prepare(
      `SELECT id, pct, start_week FROM nexa_player_action_shares
        WHERE player_id = ? AND end_week IS NULL ORDER BY start_week DESC, id DESC LIMIT 1`
    ).get(player_id) as { id: number; pct: number; start_week: string } | undefined;

    let created = true, closed: string | null = null;
    if (open && open.start_week === start_week) {
      db.prepare(`UPDATE nexa_player_action_shares SET pct = ?, note = ? WHERE id = ?`)
        .run(pct, args.note ?? null, open.id);
      created = false;
    } else {
      if (open) {
        // Une période antérieure se ferme la semaine d'avant. Une période qui
        // commencerait APRÈS la semaine demandée est une incohérence de saisie :
        // on refuse plutôt que de produire un historique qui se chevauche.
        if (open.start_week > start_week) {
          throw new Error(
            `Une part d'action court déjà depuis le ${open.start_week}, postérieur au ${start_week} demandé. ` +
            `Choisis une semaine d'effet au moins égale à ${open.start_week}.`
          );
        }
        closed = previousWeek(start_week);
        db.prepare(`UPDATE nexa_player_action_shares SET end_week = ? WHERE id = ?`).run(closed, open.id);
      }
      db.prepare(
        `INSERT INTO nexa_player_action_shares (player_id, pct, start_week, note) VALUES (?, ?, ?, ?)`
      ).run(player_id, pct, start_week, args.note ?? null);
    }

    // ── MIROIR — même transaction, voir l'encadré en tête de fichier ──
    // player_game_deals.action_pct est un cache de la période COURANTE. Il ne
    // porte aucun historique : c'est nexa_player_action_shares qui fait foi.
    db.prepare(`
      INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct)
      VALUES (?, ?, ?, 0)
      ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct
    `).run(player_id, gid, pct);

    return { created, closed };
  });

  try {
    const r = run();
    return { ok: true, created: r.created, closed_previous: r.closed, player_id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function setActionShare(args: { player_id: number; pct: number; start_week: string; note?: string | null }) {
  return setActionShareOn(getDb(), args);
}

/** Historique complet des parts d'un joueur — l'écran doit pouvoir le montrer. */
export function getActionSharesOn(db: DB, playerId: number) {
  return db.prepare(
    `SELECT id, pct, start_week, end_week, note, created_at
       FROM nexa_player_action_shares WHERE player_id = ? ORDER BY start_week DESC, id DESC`
  ).all(playerId) as { id: number; pct: number; start_week: string; end_week: string | null; note: string | null; created_at: string }[];
}

// ── Création manuelle ─────────────────────────────────────────────────────

export type CreatePlayerArgs = {
  nickname: string;
  member_id?: string | null;
  telegram_handle?: string | null;
  action_pct?: number | null;
  /** Semaine d'effet de la part d'action ; défaut = lundi de la semaine en cours. */
  action_start_week?: string | null;
};

export type CreatePlayerResult =
  | { ok: true; player_id: number; backfilled: number }
  | { ok: false; error: string };

/**
 * Crée un joueur NEXA hors funnel — le cas courant aujourd'hui : les 4 joueurs
 * actuels n'ont ni lead ni @ Telegram.
 *
 * players + player_game_ids (si Member ID) + nexa_nickname_links + part d'action,
 * en UNE transaction, puis rattrapage rétroactif de tout l'historique déjà saisi.
 */
export function createNexaPlayerOn(db: DB, args: CreatePlayerArgs): CreatePlayerResult {
  const nickname = String(args.nickname ?? "").trim();
  if (nickname === "") return { ok: false, error: "Le pseudo est obligatoire." };
  const nickKey = nicknameKey(nickname);
  const memberId = String(args.member_id ?? "").trim();
  const pct = args.action_pct ?? 0;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: "La part d'action doit être un nombre entre 0 et 100." };
  }
  const startWeek = args.action_start_week ?? currentWeekMonday();
  if (!isMondayISO(startWeek)) {
    return { ok: false, error: `Semaine d'effet « ${startWeek} » invalide — attendu la date d'un LUNDI.` };
  }
  const gid = gameId(db);

  // Conflits détectés AVANT d'écrire quoi que ce soit : un message clair vaut
  // mieux qu'une contrainte SQL remontée brute.
  if (memberId !== "") {
    const taken = db.prepare(
      `SELECT p.name FROM player_game_ids g JOIN players p ON p.id = g.player_id
        WHERE g.game_id = ? AND g.external_id = ?`
    ).get(gid, memberId) as { name: string } | undefined;
    if (taken) return { ok: false, error: `Le Member ID ${memberId} est déjà rattaché à « ${taken.name} ».` };
  }
  const nickTaken = db.prepare(
    `SELECT p.name FROM nexa_nickname_links l JOIN players p ON p.id = l.player_id WHERE l.nickname_key = ?`
  ).get(nickKey) as { name: string } | undefined;
  if (nickTaken) return { ok: false, error: `Le pseudo « ${nickname} » est déjà rattaché à « ${nickTaken.name} ».` };

  try {
    const run = db.transaction((): { player_id: number; backfilled: number } => {
      const pid = Number(db.prepare(`INSERT INTO players (name, telegram_handle) VALUES (?, ?)`)
        .run(nickname, args.telegram_handle?.trim() || null).lastInsertRowid);

      if (memberId !== "") {
        db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, ?)`)
          .run(pid, gid, memberId);
      }
      db.prepare(`INSERT INTO nexa_nickname_links (nickname_key, player_id) VALUES (?, ?)`).run(nickKey, pid);

      // La part d'action passe par le même chemin que l'édition — donc le miroir
      // player_game_deals est posé ici aussi, sans duplication de logique.
      const share = setActionShareOn(db, { player_id: pid, pct, start_week: startWeek });
      if (!share.ok) throw new Error(share.error);

      return { player_id: pid, backfilled: backfillPlayerIdOn(db, pid, memberId || null, nickKey) };
    });
    const r = run();
    return { ok: true, ...r };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function createNexaPlayer(args: CreatePlayerArgs) { return createNexaPlayerOn(getDb(), args); }

// ── Réconciliation ────────────────────────────────────────────────────────

export type UnreconciledRow = {
  row_key: string;
  member_id: string | null;
  nickname: string;
  nickname_key: string;
  weeks: number;
  total_rake: number;
  total_commission: number;
  first_week: string;
  last_week: string;
  /** Candidat proposé, JAMAIS appliqué : c'est Hugo qui tranche. */
  hint_player_id: number | null;
  hint_player_name: string | null;
  hint_via: "member_id" | "nickname" | null;
};

/**
 * Lignes du report que personne ne réclame, agrégées par clé.
 *
 * Le `hint` reprend la règle de resolveRows : un Member ID inconnu dont le pseudo
 * est déjà lié propose ce joueur — sans jamais l'appliquer. Rien ne se rattache
 * sur une approximation.
 */
export function getUnreconciledOn(db: DB): UnreconciledRow[] {
  const gid = gameId(db);
  return db.prepare(`
    SELECT
      w.row_key, w.member_id, MAX(w.nickname) AS nickname, w.nickname_key,
      COUNT(*) AS weeks,
      SUM(w.nlh + w.mtt + w.plo + w.spins) AS total_rake,
      SUM(w.affiliate_payment) AS total_commission,
      MIN(w.week_start) AS first_week, MAX(w.week_start) AS last_week,
      hint.player_id AS hint_player_id,
      hp.name AS hint_player_name,
      CASE WHEN hint.player_id IS NULL THEN NULL ELSE 'nickname' END AS hint_via
    FROM nexa_affiliate_weeks w
    -- Un Member ID inconnu peut correspondre à un pseudo déjà rattaché : on le
    -- propose. Une ligne sans ID dont le pseudo serait lié ne serait pas ici
    -- (resolveRows l'aurait déjà rattachée à l'écriture).
    LEFT JOIN nexa_nickname_links hint ON hint.nickname_key = w.nickname_key
    LEFT JOIN players hp ON hp.id = hint.player_id
    WHERE w.player_id IS NULL
    GROUP BY w.row_key
    ORDER BY total_rake DESC
  `).all({ gid }) as UnreconciledRow[];
}

export function getUnreconciled(): UnreconciledRow[] { return getUnreconciledOn(getDb()); }

export type LinkResult = { ok: true; backfilled: number } | { ok: false; error: string };

/**
 * Rattache une ligne non réconciliée à un joueur EXISTANT, sur action explicite.
 * Pose le lien durable (player_game_ids si Member ID, nexa_nickname_links sinon)
 * puis rattrape tout l'historique déjà saisi.
 */
export function linkRowToPlayerOn(
  db: DB, args: { player_id: number; member_id?: string | null; nickname: string },
): LinkResult {
  const memberId = String(args.member_id ?? "").trim();
  const nickname = String(args.nickname ?? "").trim();
  if (nickname === "") return { ok: false, error: "Pseudo manquant." };
  const nickKey = nicknameKey(nickname);
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(args.player_id)) {
    return { ok: false, error: `Joueur ${args.player_id} introuvable.` };
  }
  const gid = gameId(db);

  try {
    const run = db.transaction((): number => {
      if (memberId !== "") {
        const taken = db.prepare(
          `SELECT player_id FROM player_game_ids WHERE game_id = ? AND external_id = ?`
        ).get(gid, memberId) as { player_id: number } | undefined;
        if (taken && taken.player_id !== args.player_id) {
          throw new Error(`Le Member ID ${memberId} est déjà rattaché à un autre joueur (#${taken.player_id}).`);
        }
        if (!taken) {
          db.prepare(`INSERT INTO player_game_ids (player_id, game_id, external_id) VALUES (?, ?, ?)`)
            .run(args.player_id, gid, memberId);
        }
      } else {
        const taken = db.prepare(`SELECT player_id FROM nexa_nickname_links WHERE nickname_key = ?`)
          .get(nickKey) as { player_id: number } | undefined;
        if (taken && taken.player_id !== args.player_id) {
          throw new Error(`Le pseudo « ${nickname} » est déjà rattaché à un autre joueur (#${taken.player_id}).`);
        }
        if (!taken) {
          db.prepare(`INSERT INTO nexa_nickname_links (nickname_key, player_id) VALUES (?, ?)`)
            .run(nickKey, args.player_id);
        }
      }
      return backfillPlayerIdOn(db, args.player_id, memberId || null, memberId === "" ? nickKey : null);
    });
    return { ok: true, backfilled: run() };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function linkRowToPlayer(args: { player_id: number; member_id?: string | null; nickname: string }) {
  return linkRowToPlayerOn(getDb(), args);
}

// ── Buy-in / cash-out ─────────────────────────────────────────────────────
//
// Sur NEXAPOKER les dépôts et retraits passent par Hugo en système d'agent, pas
// par la blockchain. On réutilise `wallet_transactions` avec `source='manual'` —
// la table et le motif existent déjà pour exactement ce cas, il n'y a pas de
// table parallèle à créer. L'écriture passe par insertWalletTransaction
// (lib/queries.ts), seul chemin d'écriture manuelle du repo.
//
// DIRECTION — la convention du repo, à ne pas inverser (docs/DOMAIN.md) :
//   • buy-in   → 'deposit'    : le joueur met de l'argent, il finance son action.
//   • cash-out → 'withdrawal' : l'opérateur paie le joueur.
//   net = Σ retraits − Σ dépôts. Positif = j'ai versé plus qu'il n'a acheté.
//
// Ces mouvements sont la SAISIE d'Hugo. Ni l'import, ni l'extraction de
// screenshot, ni commitWeek n'y touchent — même règle que le win/loss manuel.
//
// Deux triggers de la table, vérifiés sur le DDL de prod avant d'écrire ici :
//   • wallet_tx_source_check accepte 'manual' ;
//   • enforce_withdrawal_from_wallet_mere ne se déclenche QUE sur source='sync',
//     donc l'invariant #1 (retraits issus du wallet mère) ne s'applique pas aux
//     mouvements manuels et ne les bloque pas.

export type MovementKind = "buy_in" | "cash_out";

export type Movement = {
  id: number; type: "deposit" | "withdrawal"; amount: number; currency: string;
  note: string | null; tx_date: string; created_at: string;
};

export type MovementResult = { ok: true; id: number } | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Enregistre un buy-in ou un cash-out.
 *
 * Le montant est TOUJOURS positif : c'est le `type` qui porte le sens. Accepter
 * un négatif créerait deux façons d'exprimer la même chose et fausserait tous les
 * agrégats qui somment par type.
 */
export function addMovementOn(
  db: DB,
  args: { player_id: number; kind: MovementKind; amount: number; tx_date: string; note?: string | null },
): MovementResult {
  const { player_id, kind, amount, tx_date } = args;
  if (kind !== "buy_in" && kind !== "cash_out") return { ok: false, error: `Type de mouvement inconnu : ${kind}.` };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Le montant doit être un nombre strictement positif — le sens est porté par le type de mouvement." };
  }
  if (!ISO_DATE.test(tx_date) || Number.isNaN(new Date(`${tx_date}T00:00:00Z`).getTime())) {
    return { ok: false, error: `Date « ${tx_date} » invalide — attendu YYYY-MM-DD.` };
  }
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(player_id)) {
    return { ok: false, error: `Joueur ${player_id} introuvable.` };
  }
  const gid = gameId(db);

  try {
    const id = Number(insertWalletTransaction({
      player_id, game_id: gid,
      type: kind === "buy_in" ? "deposit" : "withdrawal",
      amount, currency: "USDT",
      note: args.note?.trim() || undefined,
      tx_date,
    }, db));
    return { ok: true, id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function addMovement(args: { player_id: number; kind: MovementKind; amount: number; tx_date: string; note?: string | null }) {
  return addMovementOn(getDb(), args);
}

/** Historique des mouvements NEXA d'un joueur, du plus récent au plus ancien. */
export function getMovementsOn(db: DB, playerId: number): Movement[] {
  const gid = gameId(db);
  return db.prepare(`
    SELECT id, type, amount, currency, note, tx_date, created_at
      FROM wallet_transactions
     WHERE player_id = ? AND game_id = ?
       -- source='manual' STRICT : cet écran ne montre et ne supprime que la
       -- saisie d'Hugo. Une ligne 'sync' (on-chain) n'a rien à faire ici et ne
       -- doit surtout pas être supprimable depuis un bouton de cette page.
       AND source = 'manual'
     ORDER BY tx_date DESC, id DESC
  `).all(playerId, gid) as Movement[];
}

export function getMovements(playerId: number): Movement[] { return getMovementsOn(getDb(), playerId); }

/**
 * Suppression d'un mouvement — saisie manuelle, donc corrigeable.
 * Bornée au game NEXAPOKER et aux lignes non consommées par un règlement :
 * une transaction déjà rattachée à un manual_settlement ne se supprime pas dans
 * le dos de ce règlement.
 */
export function deleteMovementOn(db: DB, id: number): { ok: true } | { ok: false; error: string } {
  const gid = gameId(db);
  // source='manual' : on ne supprime QUE de la saisie manuelle. Une ligne issue
  // d'une synchro on-chain n'est pas un « mouvement » au sens de cet écran.
  const row = db.prepare(
    `SELECT settled, settlement_id FROM wallet_transactions
      WHERE id = ? AND game_id = ? AND source = 'manual'`
  ).get(id, gid) as { settled: number; settlement_id: number | null } | undefined;
  if (!row) return { ok: false, error: `Mouvement ${id} introuvable sur NEXAPOKER, ou non saisi manuellement.` };
  if (row.settled === 1 || row.settlement_id !== null) {
    return { ok: false, error: `Mouvement ${id} déjà consommé par un règlement — il ne peut plus être supprimé.` };
  }
  db.prepare(`DELETE FROM wallet_transactions WHERE id = ? AND game_id = ? AND source = 'manual'`).run(id, gid);
  return { ok: true };
}

export function deleteMovement(id: number) { return deleteMovementOn(getDb(), id); }
