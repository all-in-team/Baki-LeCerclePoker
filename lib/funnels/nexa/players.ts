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
import { computeRakeback } from "./rakeback-engine";
import type {
  Basis, MakeupCarry, RakebackPeriod, ActionPeriod, WeekInput, WeekResult, EngineResult,
} from "./rakeback-engine";

type DB = BetterSqlite3.Database;

// ── Défauts globaux de rakeback (settings) ────────────────────────────────
// Le % de rakeback n'a PAS de miroir dans player_game_deals, contrairement à la
// part d'action. C'est délibéré : ce cache ne porte que la période courante, et
// le moteur a interdiction de le lire (il appliquerait le % d'aujourd'hui à une
// semaine d'il y a deux mois). nexa_player_rakeback est la seule vérité.

const BASES: readonly Basis[] = ["gross_rake", "affiliate_commission"];
const CARRIES: readonly MakeupCarry[] = ["carry", "reset"];

export type NexaRakebackDefaults = { defaultPct: number; defaultBasis: Basis };

/** Défauts appliqués aux semaines qu'aucune période ne couvre. */
export function getNexaRakebackDefaultsOn(db: DB): NexaRakebackDefaults {
  const read = (key: string): string | null => {
    const r = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
    return r?.value ?? null;
  };
  const pct = Number(read("nexa_default_rakeback_pct"));
  const basis = read("nexa_default_rakeback_basis");
  return {
    // Un réglage absent ou illisible retombe sur 0 % : ne jamais deviner un
    // pourcentage — 0 ne doit rien au joueur, une valeur inventée si.
    defaultPct: Number.isFinite(pct) && pct >= 0 && pct <= 100 ? pct : 0,
    defaultBasis: BASES.includes(basis as Basis) ? (basis as Basis) : "affiliate_commission",
  };
}

export function getNexaRakebackDefaults(): NexaRakebackDefaults {
  return getNexaRakebackDefaultsOn(getDb());
}

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
  /** Rakeback EN COURS. À défaut de période enregistrée : les valeurs de settings. */
  rakeback_pct: number;
  rakeback_basis: Basis;
  rakeback_makeup_carry: MakeupCarry;
  /** null = aucune période enregistrée, donc le défaut global s'applique. */
  rakeback_since: string | null;
  /** true quand la ligne affiche le défaut settings et non un choix explicite. */
  rakeback_is_default: boolean;
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

/** Ligne SQL brute : le rakeback y est encore nullable, avant repli sur settings. */
type NexaPlayerRawRow = Omit<
  NexaPlayerRow, "rakeback_pct" | "rakeback_basis" | "rakeback_makeup_carry" | "rakeback_is_default"
> & {
  rb_pct: number | null;
  rb_basis: Basis | null;
  rb_makeup_carry: MakeupCarry | null;
};

export function getNexaPlayersOn(db: DB): NexaPlayerRow[] {
  const gid = gameId(db);
  const rows = db.prepare(`
    SELECT
      p.id AS player_id,
      p.name,
      p.telegram_handle,
      pgi.external_id AS member_id,
      w.report_nickname,
      COALESCE(a.pct, 0) AS action_pct,
      a.start_week AS action_since,
      rb.pct AS rb_pct,
      rb.basis AS rb_basis,
      rb.makeup_carry AS rb_makeup_carry,
      rb.start_week AS rakeback_since,
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
    -- Rakeback en cours, même règle : une seule période ouverte, la plus récente.
    LEFT JOIN (
      SELECT player_id, pct, basis, makeup_carry, start_week,
             ROW_NUMBER() OVER (PARTITION BY player_id ORDER BY start_week DESC, id DESC) AS rn
      FROM nexa_player_rakeback WHERE end_week IS NULL
    ) rb ON rb.player_id = p.id AND rb.rn = 1
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
      WHERE game_id = @gid AND (source IS NULL OR source != 'unknown') AND (status IS NULL OR status = 'active') AND currency = 'USDT'
      GROUP BY player_id
    ) m ON m.player_id = p.id
    LEFT JOIN nexa_leads l ON l.player_id = p.id
    -- Un joueur est « NEXA » s'il porte un lien vers ce game, par ID ou par pseudo.
    WHERE pgi.player_id IS NOT NULL OR nl.player_id IS NOT NULL
    ORDER BY COALESCE(w.total_rake, 0) DESC, p.name
  `).all({ gid }) as NexaPlayerRawRow[];

  // Repli sur les défauts globaux, une seule lecture de settings pour la liste.
  // `rakeback_is_default` dit à l'écran que le chiffre affiché n'est pas un choix.
  const def = getNexaRakebackDefaultsOn(db);

  // UN JOUEUR, UNE LIGNE — garanti ici, à la source.
  //
  // La requête ci-dessus fait des LEFT JOIN sur player_game_ids, nexa_nickname_links
  // et nexa_leads sans DISTINCT : un joueur qui porte DEUX pseudos de report (cas
  // nominal — il change de pseudo dans la room) ou deux Member ID sortait deux fois.
  // Tous ses montants étaient alors comptés double chez CHAQUE appelant qui somme :
  // vue Agence (position nette, action déjà réglée), Σ rake / Σ commission de la
  // table joueurs, et cartes du tableau de bord. Le piège : commission, dû et action
  // doublant ensemble, la réconciliation interne restait vraie et ne signalait rien.
  //
  // Dédoublonner ici plutôt que chez chaque appelant tarit la source : un nouvel
  // appelant hérite de la garantie sans avoir à y penser. La première ligne gagne —
  // l'ORDER BY porte sur le rake, pas sur les colonnes jointes, donc les doublons
  // sont adjacents et ne diffèrent que par le member_id / pseudo retenu.
  // (Constat money-auditor 2026-08-05 ; aucun doublon en prod à cette date —
  // 8 lignes pour 8 joueurs — c'était une bombe à retardement, pas un chiffre faux.)
  const seen = new Set<number>();
  return rows
    .filter(r => { if (seen.has(r.player_id)) return false; seen.add(r.player_id); return true; })
    .map(({ rb_pct, rb_basis, rb_makeup_carry, ...r }) => ({
      ...r,
      rakeback_pct: rb_pct ?? def.defaultPct,
      rakeback_basis: rb_basis ?? def.defaultBasis,
      rakeback_makeup_carry: rb_makeup_carry ?? "carry",
      rakeback_is_default: rb_pct === null,
    }));
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

// ── Win/loss hebdomadaire : l'ASSIETTE des parts d'action ─────────────────
//
// Le report d'affiliation NEXA ne contient AUCUN win/loss : il ne connaît que le
// rake et la commission. Le win/loss est une saisie manuelle d'Hugo, dans sa
// propre table, et c'est ce qui le protège : re-saisir une semaine du report ne
// peut pas l'écraser, il n'y a aucun chemin de l'un vers l'autre.
//
// null ≠ 0. Une semaine non saisie n'est pas une semaine à zéro : le moteur
// refuse d'en déduire une part d'action, et refusera de la régler.

export type WinlossResult = { ok: true; week_start: string } | { ok: false; error: string };

/**
 * Cette semaine est-elle pilotée par la bankroll ?
 *
 * Lecture SQL directe plutôt qu'un import de ./bankroll : ce module-ci est
 * importé PAR celui-là (lockBankrollWeekOn appelle addMovementOn), un import
 * retour créerait un cycle. Même parti pris que pour ./action-settlement.
 *
 * Le repli ne couvre QUE l'absence de table : la migration
 * add_nexa_bankroll_weeks_v1 est plus récente que ce fichier, et sur une base
 * d'avant elle il n'y a aucune semaine BR à protéger — la grille doit continuer
 * de marcher exactement comme avant.
 *
 * Tout le reste est RELANCÉ. Un `catch` muet ferait échouer cette garde EN
 * LAISSANT PASSER : un SQLITE_BUSY sur cette seule requête suffirait à autoriser
 * l'écrasement du résultat d'une semaine figée. Une garde d'argent doit échouer
 * fermée. (Constat money-auditor 2026-08-17.)
 */
function isBankrollDriven(db: DB, playerId: number, weekStart: string): boolean {
  try {
    return !!db.prepare(
      `SELECT 1 FROM nexa_player_bankroll_weeks WHERE player_id = ? AND week_start = ?`
    ).get(playerId, weekStart);
  } catch (e: any) {
    if (!/no such table/i.test(e?.message ?? "")) throw e;
    return false;
  }
}

/** Saisit (ou corrige) le win/loss d'une semaine. Montant signé. */
export function setWeeklyWinlossOn(
  db: DB, args: { player_id: number; week_start: string; amount: number; note?: string | null },
): WinlossResult {
  const { player_id, week_start, amount } = args;
  if (!Number.isFinite(amount)) {
    return { ok: false, error: "Le win/loss doit être un nombre (négatif pour une semaine perdante)." };
  }
  if (!isMondayISO(week_start)) {
    return { ok: false, error: `Semaine « ${week_start} » invalide — attendu la date d'un LUNDI.` };
  }
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(player_id)) {
    return { ok: false, error: `Joueur ${player_id} introuvable.` };
  }
  // UNE SEULE VÉRITÉ PAR SEMAINE. Si la semaine a été calculée depuis la
  // bankroll, la grille ne peut pas écrire par-dessus : on aurait deux chiffres
  // pour la même semaine du même joueur, l'un tapé à la main, l'autre déduit de
  // la BR, et rien pour dire lequel fait foi. Le refus vit ICI, dans l'écrivain,
  // et pas dans l'UI : la grille, la route et tout futur appelant en héritent.
  if (isBankrollDriven(db, player_id, week_start)) {
    return {
      ok: false,
      error: `Semaine ${week_start} calculée depuis la bankroll — elle ne se saisit pas à la main. `
           + `Déverrouille le règlement BR de cette semaine si le chiffre est faux.`,
    };
  }
  try {
    // UPSERT et non append-only : contrairement à une part d'action, un win/loss
    // n'a pas de période de validité. C'est un fait daté qu'on corrige, pas une
    // règle qui change à partir d'une date.
    db.prepare(`
      INSERT INTO nexa_player_weekly_winloss (player_id, week_start, amount, note)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(player_id, week_start) DO UPDATE SET
        amount = excluded.amount, note = excluded.note, entered_at = datetime('now')
    `).run(player_id, week_start, amount, args.note ?? null);
    return { ok: true, week_start };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/**
 * Dé-saisit une semaine : elle redevient NON SAISIE, pas « à zéro ».
 * Écrire 0 dirait « le joueur a fini à l'équilibre » — ce n'est pas la même chose
 * que « je ne sais pas encore », et le moteur les traite différemment.
 */
export function clearWeeklyWinlossOn(db: DB, playerId: number, weekStart: string): WinlossResult {
  if (!isMondayISO(weekStart)) {
    return { ok: false, error: `Semaine « ${weekStart} » invalide — attendu la date d'un LUNDI.` };
  }
  // Dé-saisir une semaine BR reviendrait à effacer le résultat d'un règlement
  // figé en laissant le règlement debout : la semaine resterait réglée, payée
  // peut-être, mais sans résultat. Même refus que pour l'écriture.
  if (isBankrollDriven(db, playerId, weekStart)) {
    return {
      ok: false,
      error: `Semaine ${weekStart} calculée depuis la bankroll — elle ne se dé-saisit pas ici. `
           + `Passe par le déverrouillage du règlement BR.`,
    };
  }
  db.prepare(`DELETE FROM nexa_player_weekly_winloss WHERE player_id = ? AND week_start = ?`)
    .run(playerId, weekStart);
  return { ok: true, week_start: weekStart };
}

export function setWeeklyWinloss(args: { player_id: number; week_start: string; amount: number; note?: string | null }) {
  return setWeeklyWinlossOn(getDb(), args);
}
export function clearWeeklyWinloss(playerId: number, weekStart: string) {
  return clearWeeklyWinlossOn(getDb(), playerId, weekStart);
}

/** week_start → montant saisi. Une semaine absente de la Map n'est PAS à zéro. */
export function getWeeklyWinlossOn(db: DB, playerId: number): Map<string, number> {
  const rows = db.prepare(
    `SELECT week_start, amount FROM nexa_player_weekly_winloss WHERE player_id = ?`
  ).all(playerId) as { week_start: string; amount: number }[];
  return new Map(rows.map(r => [r.week_start, r.amount]));
}

/**
 * Win/loss de TOUS les joueurs pour UNE semaine — l'inverse de la fonction
 * ci-dessus, pour la grille de saisie hebdomadaire.
 *
 * Lecture pure : aucun calcul, aucun repli. Une clé absente veut dire « non
 * saisi » et doit le rester — c'est la distinction que tout le moteur repose
 * dessus (un zéro saisi n'est pas une absence de saisie).
 */
export function getWinlossForWeekOn(db: DB, weekStart: string): Map<number, number> {
  const rows = db.prepare(
    `SELECT player_id, amount FROM nexa_player_weekly_winloss WHERE week_start = ?`
  ).all(weekStart) as { player_id: number; amount: number }[];
  return new Map(rows.map(r => [r.player_id, r.amount]));
}

// ── Vue détail d'un joueur ────────────────────────────────────────────────

export type NexaPlayerDetail = {
  player_id: number;
  name: string;
  weeks: WeekResult[];
  /**
   * week_start → id du règlement qui a figé cette semaine. Le moteur, lui, rejoue
   * toujours TOUTE la chaîne : c'est cette carte qui dit ce qui est déjà réglé, et
   * elle seule. Sans elle, l'écran présenterait comme dû ce qui a déjà été payé.
   */
  settled_weeks: Record<string, number>;
  /** week_start → id du règlement de RAKEBACK qui a figé cette semaine. */
  rb_settled_weeks: Record<string, number>;
  /** Dernière semaine dont le rakeback est réglé. INFORMATIF : ne pilote aucun calcul. */
  rb_settled_through: string | null;
  /** Rakeback déjà versé, au montant FIGÉ au verrouillage. */
  rb_settled_total: number;
  /**
   * Rakeback qui RESTE à verser : dû rejoué des seules semaines ok non réglées.
   *
   * C'est lui qu'un écran doit montrer, jamais `totals.due` — celui-ci inclut les
   * semaines déjà payées et continuerait donc d'afficher un dû éteint.
   */
  rb_unsettled: number;
  /**
   * Part d'action DÉJÀ RÉGLÉE, au montant FIGÉ dans nexa_action_settlement_weeks —
   * pas au montant que le rejeu donnerait aujourd'hui. Si la semaine est corrigée
   * après coup, le rejeu bouge mais ce qui est sorti des comptes ne bouge plus.
   */
  action_settled: number;
  /**
   * Part d'action qui reste à régler. null si une semaine `ok` non réglée n'a pas
   * son win/loss — c'est ELLE, et non le total brut, qui porte la position nette.
   */
  action_unsettled: number | null;
  totals: EngineResult["totals"];
  blocked_weeks: EngineResult["blocked_weeks"];
  warnings: EngineResult["warnings"];
  makeup_final: number;
  /** Trésorerie — hors moteur : les mouvements ne sont pas un flux de calcul. */
  deposited: number;
  withdrawn: number;
  /** withdrawn − deposited. Même convention que le hub : positif = le joueur me doit. */
  net_movements: number;
  /**
   * Position nette = part d'action NON RÉGLÉE + mouvements, dans la MÊME convention
   * de signe (positif = le joueur doit au Cercle).
   *
   * Portée par le NON RÉGLÉ, pas par le total : une fois les semaines réglées et
   * payées, ce que le joueur doit encore au titre de l'action est zéro. Sommer
   * toutes les semaines ferait afficher « il te doit 300 » indéfiniment après un
   * paiement — un dû éteint qui continue de s'afficher est un chiffre faux.
   *
   * null si un win/loss manque sur une semaine non réglée : un net amputé ne doit
   * pas ressembler à un chiffre juste.
   */
  net_position: number | null;
};

/**
 * Rejoue toute la chaîne d'un joueur pour l'écran de détail.
 *
 * C'est ICI que le moteur est branché sur la base, et nulle part ailleurs : les
 * semaines viennent de nexa_affiliate_weeks, le win/loss de sa table dédiée, les
 * pourcentages de nexa_player_action_shares / nexa_player_rakeback, les défauts
 * de settings. Jamais getPlayerWalletStats, jamais player_game_deals.
 */
export function getNexaPlayerDetailOn(db: DB, playerId: number): NexaPlayerDetail | null {
  const p = db.prepare(`SELECT id, name FROM players WHERE id = ?`).get(playerId) as
    { id: number; name: string } | undefined;
  if (!p) return null;

  const winloss = getWeeklyWinlossOn(db, playerId);
  const weeks: WeekInput[] = getNexaPlayerWeeksOn(db, playerId).map(w => ({
    week_start: w.week_start,
    gross_rake: w.rake,
    affiliate_commission: w.affiliate_payment,
    check_ok: w.check_ok === 1,
    // has() et non ?? : un win/loss saisi À ZÉRO est une saisie, pas une absence.
    winloss: winloss.has(w.week_start) ? winloss.get(w.week_start)! : null,
  }));

  const actionPeriods: ActionPeriod[] = db.prepare(
    `SELECT pct, start_week, end_week FROM nexa_player_action_shares WHERE player_id = ?`
  ).all(playerId) as ActionPeriod[];

  // PAS DE BORNE DE MAKEUP. Décision d'Hugo (2026-08-05, second arbitrage) : régler
  // le rakeback PAIE ce qui est dû, il ne SOLDE pas le déficit restant. Le makeup
  // non récupéré continue donc de courir sur les semaines suivantes, exactement
  // comme avant l'introduction du règlement.
  //
  // Une première version remettait le makeup à zéro après la dernière semaine
  // réglée. L'audit a montré que sa justification était fausse — makeup_in et
  // makeup_out sont disjoints, la chaîne ne double-compte jamais — et que la
  // remise à zéro ne corrigeait donc rien : elle faisait cadeau du déficit, pour
  // un surcoût de |makeup restant| × taux à chaque règlement. Elle a été retirée.
  const r = computeRakeback(
    weeks, getRakebackPeriodsOn(db, playerId), actionPeriods, getNexaRakebackDefaultsOn(db),
  );

  const gid = gameId(db);
  const mv = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'deposit'    THEN amount ELSE 0 END), 0) AS deposited,
           COALESCE(SUM(CASE WHEN type = 'withdrawal' THEN amount ELSE 0 END), 0) AS withdrawn
    FROM wallet_transactions
    WHERE player_id = ? AND game_id = ? AND (source IS NULL OR source != 'unknown') AND (status IS NULL OR status = 'active') AND currency = 'USDT'
  `).get(playerId, gid) as { deposited: number; withdrawn: number };

  const netMovements = mv.withdrawn - mv.deposited;

  // Lecture directe plutôt qu'un import de ./action-settlement : ce module-ci est
  // importé PAR celui-là (getNexaPlayerDetailOn y alimente le calcul du réglable),
  // un import retour créerait un cycle.
  const settledRows = db.prepare(
    `SELECT week_start, settlement_id, action_amount FROM nexa_action_settlement_weeks WHERE player_id = ?`
  ).all(playerId) as { week_start: string; settlement_id: number; action_amount: number }[];

  // Semaines dont le RAKEBACK est réglé — flux distinct de l'action : une semaine
  // peut avoir son action réglée et pas son rakeback, ou l'inverse. Deux mémoires
  // séparées, jamais confondues à l'écran.
  const rbSettledRows = db.prepare(
    `SELECT week_start, settlement_id, due FROM nexa_rakeback_settlement_weeks WHERE player_id = ?`
  ).all(playerId) as { week_start: string; settlement_id: number; due: number }[];
  const settledSet = new Set(settledRows.map(s => s.week_start));

  // Le réglé vaut son montant FIGÉ ; le reste à régler est recalculé par le rejeu.
  const actionSettled = settledRows.reduce((s, w) => s + w.action_amount, 0);
  const openWeeks = r.weeks.filter(w => w.status === "ok" && !settledSet.has(w.week_start));
  // L'exclusion du réglé passe par settledSet, PAS par la présence du win/loss :
  // clearWeeklyWinlossOn n'interdit pas de dé-saisir une semaine déjà réglée. Une
  // semaine réglée garde donc son montant figé même sans win/loss, et c'est bien le
  // non-réglé — et lui seul — qui peut devenir incalculable.
  const actionUnsettled = openWeeks.some(w => w.winloss === null)
    ? null
    : openWeeks.reduce((s, w) => s + (w.action_amount ?? 0), 0);

  // RAKEBACK : même distinction que pour l'action, et pour la même raison.
  //
  // `totals.due` est le dû rejoué sur TOUTES les semaines ok, réglées comprises.
  // C'est le bon chiffre pour dire « ce que ce joueur a coûté en rakeback », et le
  // mauvais pour dire « ce que je lui dois » : une fois la semaine payée, son dû
  // est éteint. Afficher `totals.due` comme un reste à verser ferait réclamer
  // indéfiniment un rakeback déjà sorti des comptes.
  //
  // Les deux moitiés ne se lisent PAS dans la même source, et c'est voulu :
  //   • rb_settled_total  = Σ des dûs FIGÉS au verrouillage — ce qui est réellement
  //     sorti, insensible à une correction ultérieure du report ;
  //   • rb_unsettled      = Σ des dûs REJOUÉS des semaines ok non réglées — ce qui
  //     reste à payer, au taux et à l'assiette d'aujourd'hui.
  // Leur somme n'égale donc pas forcément `totals.due` si un report a été corrigé
  // après un règlement. Ce n'est pas une incohérence : c'est la différence entre ce
  // qui est sorti et ce que le rejeu dirait aujourd'hui, et elle doit rester visible.
  //
  // Pas de `null` ici, contrairement à l'action : le rakeback ne dépend pas du
  // win/loss, son assiette est le rake du report. Une semaine ok a toujours un dû
  // calculable.
  const rbSettledSet = new Set(rbSettledRows.map(s => s.week_start));
  const rbUnsettled = r.weeks
    .filter(w => w.status === "ok" && !rbSettledSet.has(w.week_start))
    .reduce((s, w) => s + w.due, 0);

  return {
    player_id: p.id,
    name: p.name,
    weeks: r.weeks,
    settled_weeks: Object.fromEntries(settledRows.map(s => [s.week_start, s.settlement_id])),
    rb_settled_weeks: Object.fromEntries(rbSettledRows.map(s => [s.week_start, s.settlement_id])),
    rb_settled_through: rbSettledRows.length > 0
      ? rbSettledRows.map(r => r.week_start).sort().slice(-1)[0]
      : null,
    rb_settled_total: rbSettledRows.reduce((s, w) => s + w.due, 0),
    rb_unsettled: rbUnsettled,
    action_settled: actionSettled,
    action_unsettled: actionUnsettled,
    totals: r.totals,
    blocked_weeks: r.blocked_weeks,
    warnings: r.warnings,
    makeup_final: r.makeup_final,
    deposited: mv.deposited,
    withdrawn: mv.withdrawn,
    net_movements: netMovements,
    net_position: actionUnsettled === null ? null : actionUnsettled + netMovements,
  };
}

export function getNexaPlayerDetail(playerId: number): NexaPlayerDetail | null {
  return getNexaPlayerDetailOn(getDb(), playerId);
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
    //
    // start_date EST POSÉE, et ce n'est pas cosmétique : toutes les requêtes
    // d'argent de lib/queries.ts (getPlayerWalletStats, getPlayerBalance,
    // getWalletKPIs…) bornent le deal par
    //   `pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date`.
    // Laissée à NULL, cette garde est INOPÉRANTE et le % courant s'applique
    // rétroactivement à toutes les semaines passées. On garde la date d'ouverture
    // de la PREMIÈRE période (MIN) : le miroir vaut pour tout l'historique NEXA,
    // pas seulement depuis la dernière modification du %.
    const firstWeek = (db.prepare(
      `SELECT MIN(start_week) AS w FROM nexa_player_action_shares WHERE player_id = ?`
    ).get(player_id) as { w: string | null }).w ?? start_week;

    // COALESCE dans CET ordre : on ne pose la date que si elle manque, on ne la RECULE
    // jamais. Reculer une borne existante réintégrerait en silence, dans getPlayerBalance
    // et les KPI, des mouvements qui en étaient sortis — une borne d'argent ne s'élargit
    // pas comme effet de bord d'un changement de pourcentage.
    db.prepare(`
      INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct, start_date)
      VALUES (?, ?, ?, 0, ?)
      ON CONFLICT(player_id, game_id) DO UPDATE SET
        action_pct = excluded.action_pct,
        start_date = COALESCE(player_game_deals.start_date, excluded.start_date)
    `).run(player_id, gid, pct, firstWeek);

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

// ── Rakeback ──────────────────────────────────────────────────────────────

export type RakebackResult =
  | { ok: true; created: boolean; closed_previous: string | null; player_id: number }
  | { ok: false; error: string };

export type SetRakebackArgs = {
  player_id: number;
  pct: number;
  basis: Basis;
  /** Au changement de base : reporter le makeup en cours, ou le purger. */
  makeup_carry: MakeupCarry;
  start_week: string;
  note?: string | null;
};

/**
 * Enregistre un % de rakeback à effet d'une semaine donnée.
 *
 * Strictement le même modèle que setActionShareOn — append-only, période en
 * cours close à la semaine précédente, correction sur place si la semaine
 * demandée EST celle de la période ouverte — avec deux champs en plus, `basis`
 * et `makeup_carry`, que la table exige (basis est NOT NULL sans défaut).
 *
 * PAS DE MIROIR vers player_game_deals, contrairement à la part d'action. Ce
 * cache ne porte que la période courante ; le moteur, lui, rejoue l'historique.
 * Y écrire le rakeback créerait exactement la source de vérité concurrente que
 * l'encadré en tête de fichier interdit. player_game_deals.rakeback_pct reste
 * donc à 0 pour NEXAPOKER, comme aujourd'hui.
 */
export function setRakebackOn(db: DB, args: SetRakebackArgs): RakebackResult {
  const { player_id, pct, basis, makeup_carry, start_week } = args;
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    return { ok: false, error: "Le rakeback doit être un nombre entre 0 et 100." };
  }
  if (!BASES.includes(basis)) {
    return { ok: false, error: `Base « ${basis} » invalide — attendu gross_rake ou affiliate_commission.` };
  }
  if (!CARRIES.includes(makeup_carry)) {
    return { ok: false, error: `Report de makeup « ${makeup_carry} » invalide — attendu carry ou reset.` };
  }
  if (!isMondayISO(start_week)) {
    return { ok: false, error: `Semaine d'effet « ${start_week} » invalide — attendu la date d'un LUNDI.` };
  }
  if (!db.prepare(`SELECT 1 FROM players WHERE id = ?`).get(player_id)) {
    return { ok: false, error: `Joueur ${player_id} introuvable.` };
  }

  const run = db.transaction((): { created: boolean; closed: string | null } => {
    const open = db.prepare(
      `SELECT id, pct, basis, start_week FROM nexa_player_rakeback
        WHERE player_id = ? AND end_week IS NULL ORDER BY start_week DESC, id DESC LIMIT 1`
    ).get(player_id) as { id: number; pct: number; basis: Basis; start_week: string } | undefined;

    let created = true, closed: string | null = null;
    if (open && open.start_week === start_week) {
      db.prepare(`UPDATE nexa_player_rakeback SET pct = ?, basis = ?, makeup_carry = ?, note = ? WHERE id = ?`)
        .run(pct, basis, makeup_carry, args.note ?? null, open.id);
      created = false;
    } else {
      if (open) {
        // Même refus que pour la part d'action : une période qui commencerait
        // APRÈS la semaine demandée produirait un historique qui se chevauche.
        if (open.start_week > start_week) {
          throw new Error(
            `Un rakeback court déjà depuis le ${open.start_week}, postérieur au ${start_week} demandé. ` +
            `Choisis une semaine d'effet au moins égale à ${open.start_week}.`
          );
        }
        closed = previousWeek(start_week);
        db.prepare(`UPDATE nexa_player_rakeback SET end_week = ? WHERE id = ?`).run(closed, open.id);
      }
      db.prepare(
        `INSERT INTO nexa_player_rakeback (player_id, pct, basis, makeup_carry, start_week, note)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(player_id, pct, basis, makeup_carry, start_week, args.note ?? null);
    }
    return { created, closed };
  });

  try {
    const r = run();
    return { ok: true, created: r.created, closed_previous: r.closed, player_id };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

export function setRakeback(args: SetRakebackArgs): RakebackResult {
  return setRakebackOn(getDb(), args);
}

/**
 * Historique complet des périodes de rakeback d'un joueur, au format exact
 * attendu par computeRakeback(). C'est CETTE fonction qui alimentera le moteur
 * à l'étape 7 — jamais player_game_deals, jamais getPlayerWalletStats.
 */
export function getRakebackPeriodsOn(db: DB, playerId: number): RakebackPeriod[] {
  return db.prepare(
    `SELECT pct, basis, makeup_carry, start_week, end_week
       FROM nexa_player_rakeback WHERE player_id = ? ORDER BY start_week DESC, id DESC`
  ).all(playerId) as RakebackPeriod[];
}

export function getRakebackPeriods(playerId: number): RakebackPeriod[] {
  return getRakebackPeriodsOn(getDb(), playerId);
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
 * Semaine BR FIGÉE qui contient cette date, ou null.
 *
 * Lecture directe, même raison que isBankrollDriven : ./bankroll importe ce
 * module, l'import retour ferait un cycle. Et même règle sur le repli — seule
 * l'absence de table est tolérée, tout le reste est relancé : un `catch` muet
 * laisserait un mouvement tardif entrer dans une semaine figée sur un simple
 * hoquet de la base.
 */
function bankrollWeekCovering(db: DB, playerId: number, txDate: string): string | null {
  try {
    const r = db.prepare(`
      SELECT week_start FROM nexa_player_bankroll_weeks
       WHERE player_id = ? AND week_start <= ? AND date(week_start, '+6 days') >= ?
       LIMIT 1
    `).get(playerId, txDate, txDate) as { week_start: string } | undefined;
    return r?.week_start ?? null;
  } catch (e: any) {
    if (!/no such table/i.test(e?.message ?? "")) throw e;
    return null;
  }
}

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
  // MOUVEMENT TARDIF SUR UNE SEMAINE FIGÉE : refus dur (arbitrage Hugo, 2026-08-17).
  //
  // La règle des règlements hebdomadaires — « une transaction tardive appartient
  // à la semaine ouverte suivante » (invariant #11) — NE MARCHE PAS ici. Une
  // semaine BR est bornée par les dates : un mouvement daté dans une semaine
  // close ne serait compté ni dans celle-ci (ses dépôts et cash-outs sont figés)
  // ni dans la suivante (hors fenêtre). Il disparaîtrait du calcul en silence, et
  // le résultat de la semaine serait faux du montant du mouvement.
  const frozen = bankrollWeekCovering(db, player_id, tx_date);
  if (frozen) {
    return {
      ok: false,
      error: `Le ${tx_date} tombe dans la semaine BR ${frozen} déjà figée pour ce joueur. `
           + `Un mouvement ajouté après coup n'entrerait dans AUCUN calcul. `
           + `Déverrouille la semaine, ajoute le mouvement, re-clôture.`,
    };
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
    `SELECT player_id, tx_date, settled, settlement_id FROM wallet_transactions
      WHERE id = ? AND game_id = ? AND source = 'manual'`
  ).get(id, gid) as { player_id: number; tx_date: string; settled: number; settlement_id: number | null } | undefined;
  if (!row) return { ok: false, error: `Mouvement ${id} introuvable sur NEXAPOKER, ou non saisi manuellement.` };
  if (row.settled === 1 || row.settlement_id !== null) {
    return { ok: false, error: `Mouvement ${id} déjà consommé par un règlement — il ne peut plus être supprimé.` };
  }
  // Symétrique du refus posé sur l'ajout : retirer un mouvement d'une semaine
  // figée change son assiette après coup. Les dépôts et cash-outs de la semaine
  // sont recopiés dans nexa_player_bankroll_weeks au verrouillage, donc le
  // montant réglé ne bougerait pas — mais l'historique cesserait de justifier
  // le chiffre, et plus rien ne permettrait de rejouer le calcul.
  const frozen = bankrollWeekCovering(db, row.player_id, row.tx_date);
  if (frozen) {
    return {
      ok: false,
      error: `Mouvement ${id} daté dans la semaine BR ${frozen}, déjà figée — suppression refusée. `
           + `Déverrouille la semaine d'abord.`,
    };
  }
  db.prepare(`DELETE FROM wallet_transactions WHERE id = ? AND game_id = ? AND source = 'manual'`).run(id, gid);
  return { ok: true };
}

export function deleteMovement(id: number) { return deleteMovementOn(getDb(), id); }
