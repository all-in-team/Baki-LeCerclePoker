// Suivi multi-comptes « AK multi-Account » — SCHÉMA. Module pur : aucun import.
//
// Importé par lib/db.ts (la migration) ET par scripts/pool-engine.test.ts, pour
// que les tests exercent LA MÊME chaîne SQL que la prod — un test qui recopie le
// DDL valide sa copie, pas la base. Même mécanisme que lib/funnels/dzpk/schema.
//
// ─────────────────────────────────────────────────────────────────────────────
// LE MODÈLE EN UNE PHRASE. Un joueur a N comptes (2 à 8, variable), chacun avec
// une wallet de jeu AK et une OkPay de transit, plus SA wallet main OkPay. Le
// résultat d'une période se calcule sur le POOL — la somme de tous ces soldes —
// parce que le % d'action est le même sur tous ses comptes :
//
//   pool     = solde main + Σ AK + Σ OkPay
//   résultat = (pool fin + sorties externes) − (pool début + entrées externes)
//   ma part  = résultat × action_pct / 100
//
// C'est EXACTEMENT la grandeur du moteur bankroll NEXAPOKER
// (lib/funnels/nexa/bankroll-engine.ts) : pool début = BR début, pool fin = BR
// fin, entrées externes = dépôts, sorties externes = cash-outs. Le moteur est donc
// RÉUTILISÉ tel quel (lib/pool/engine.ts), pas recopié : une grandeur, un moteur.
//
// UNE SEULE TABLE DE RÉSULTAT : pool_periods. Pas nexa_player_weekly_winloss —
// elle est NEXA-only (aucun game_id, UNIQUE(player_id, week_start) incompatible
// avec une clôture en milieu de semaine, et elle ALIMENTE le moteur rakeback
// NEXA). manual_settlements.amount_due_usdt en est la DÉRIVÉE (result × pct),
// reliée par settlement_id — même arbitrage que nexa_player_bankroll_weeks.
//
// ⚠️ LA DIFFÉRENCE AVEC NEXA, ET LE POINT LE PLUS IMPORTANT DU CHANTIER : ici la
// wallet main du joueur EST DANS LE POOL. Donc mon versement d'une période
// perdante (agence → sa main) FAIT GROSSIR le pool, et son règlement d'une
// période gagnante (sa main → agence) LE FAIT RÉTRÉCIR. Chez NEXA le second
// était 'none' (il payait de sa poche, hors bankroll) ; ici les DEUX sens sont
// des mouvements externes, datés du paiement réel. Non comptés : il me devrait
// une part de mon propre versement, ou je paierais ma part de mon propre
// encaissement. Voir pool_external_movements.kind = 'settlement' et
// lib/pool/engine.ts settlementMovementFor. (Arbitrage Baki, 2026-09-13.)
// ─────────────────────────────────────────────────────────────────────────────

export const POOL_GAME_NAME = "AK multi-Account";
export const POOL_MIGRATION_V1 = "add_pool_settlement_v1";

/** Wallet OkPay de l'agence — la contrepartie qui marque un règlement dans un historique. */
export const POOL_AGENCY_OKPAY_TG_ID = "1486389037";

/**
 * Écart maximal entre les horodatages des soldes d'une même clôture avant
 * avertissement. Pas un blocker : une main sans activité depuis trois jours a
 * légitimement un observed_at ancien. (Arbitrage Baki : 30 min, avertissement +
 * confirmation.)
 */
export const POOL_OBSERVATION_SPREAD_WARN_MIN = 30;

export const POOL_SCHEMA_SQL = `
  -- ── Inscription d'un joueur au modèle pool, pour UNE game ─────────────────
  -- main_okpay_tg_id : l'ID Telegram porté par l'en-tête « <Pseudo>
  -- Transaction:<tg_id> » du message OkPay transféré. C'est lui qui rattache
  -- un historique reçu à la wallet MAIN de ce joueur.
  CREATE TABLE IF NOT EXISTS pool_players (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    main_okpay_tg_id TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(player_id, game_id)
  );
  CREATE INDEX IF NOT EXISTS idx_pool_players_main
    ON pool_players(main_okpay_tg_id) WHERE main_okpay_tg_id IS NOT NULL;

  -- ── N comptes par joueur × game — variable, SOFT-CLOSE ────────────────────
  -- ON N'EFFACE JAMAIS UNE LIGNE : les soldes des périodes passées la
  -- référencent (pool_period_balances.account_id). « Supprimer » = closed_at
  -- posé, et SEULEMENT si les derniers soldes figés du compte sont à 0 — sinon
  -- l'argent disparaîtrait du pool, lirait comme une perte, et je paierais ma
  -- part d'une perte fictive (cas limite n°1). Le garde vit dans la couche DB
  -- (lib/pool/periods.ts closeAccountOn), pas dans l'écran.
  CREATE TABLE IF NOT EXISTS pool_accounts (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id           INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id             INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    label               TEXT NOT NULL,
    ak_ref              TEXT,
    okpay_tg_id         TEXT,
    created_at          TEXT NOT NULL DEFAULT (datetime('now')),
    closed_at           TEXT,
    closed_in_period_id INTEGER REFERENCES pool_periods(id)
  );
  CREATE INDEX IF NOT EXISTS idx_pool_accounts_player
    ON pool_accounts(player_id, game_id);
  CREATE INDEX IF NOT EXISTS idx_pool_accounts_okpay
    ON pool_accounts(okpay_tg_id) WHERE okpay_tg_id IS NOT NULL;

  -- ── UNE ligne par clôture : PROVENANCE FIGÉE + RÉSULTAT ───────────────────
  -- Les périodes sont des intervalles ]opened_at, closed_at] CONTIGUS par
  -- construction (opened_at = closed_at de la précédente) — pas des semaines.
  -- Clôture en milieu de semaine et rétroactive : triviales. Un closed_at
  -- antérieur à la dernière période figée est REFUSÉ (la chaîne se remonte
  -- dans l'ordre, cf. unlock).
  --
  -- pool_open est repris de la période précédente (carry) ou SAISI pour la
  -- première — jamais 0 par défaut, et jamais repris d'une autre game (AKS) :
  -- deux histoires séparées, ce qu'on se doit sur AKS se règle sur AKS.
  --
  -- settlement_id en NO ACTION (pas de cascade) — leçon add_nexa_bankroll_weeks_fk_v2 :
  -- le « délock » de /payments fait DELETE FROM manual_settlements ; avec une
  -- cascade il effacerait la période figée en laissant les mouvements de
  -- règlement derrière. En NO ACTION ce DELETE échoue au niveau du schéma tant
  -- que la période existe ; le déverrouillage légitime retire la période AVANT.
  CREATE TABLE IF NOT EXISTS pool_periods (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id        INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id          INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    opened_at        TEXT NOT NULL,
    closed_at        TEXT NOT NULL,
    pool_open        REAL NOT NULL,
    pool_open_source TEXT NOT NULL CHECK(pool_open_source IN ('carry','manual')),
    -- Σ des soldes figés (pool_period_balances), RECALCULÉE dans la transaction.
    pool_close       REAL NOT NULL,
    -- Σ pool_external_movements dans ]opened_at, closed_at], figées pour le rejeu.
    ext_in           REAL NOT NULL,
    ext_out          REAL NOT NULL,
    -- Sorties du moteur, arrondies au centime (demi-supérieur en valeur absolue).
    -- result > 0 : le joueur a gagné, il me doit action_amount.
    -- result < 0 : il a perdu, je lui verse |action_amount| sur sa main.
    result           REAL NOT NULL,
    action_pct       REAL NOT NULL CHECK(action_pct > 0 AND action_pct <= 100),
    action_amount    REAL NOT NULL,
    settlement_id    INTEGER REFERENCES manual_settlements(id),
    note             TEXT,
    locked_at        TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(player_id, game_id, closed_at),
    -- Deux périodes ouvertes au même instant = deux résultats pour le même
    -- intervalle. La contiguïté complète (opened_at = closed_at précédent) reste
    -- un garde applicatif ; celui-ci ferme le cas le plus grossier au schéma.
    UNIQUE(player_id, game_id, opened_at),
    CHECK(closed_at >= opened_at),
    -- UN SEUL FORMAT pour tous les horodatages du pool : « YYYY-MM-DD HH:MM:SS »,
    -- heure murale OkPay. Un ISO avec « T » ou une date sans heure se compare
    -- lexicalement de travers (' ' < 'T') et ferait retenir la mauvaise ligne
    -- dans balanceAt. (Constat money-auditor 2026-09-13, B4.)
    CHECK(opened_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'),
    CHECK(closed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'),
    CHECK(pool_open >= 0 AND pool_close >= 0 AND ext_in >= 0 AND ext_out >= 0),
    -- PROVENANCE AUTO-CERTIFIANTE : une ligne dont le résultat ne découle pas de
    -- ses propres entrées est refusée par le schéma, pas par la vigilance de
    -- l'appelant. Tolérance 0.006 : les quatre termes sont au centime, le
    -- résultat aussi, seule la dérive flottante de l'addition passe.
    CHECK(abs(result - (pool_close + ext_out - pool_open - ext_in)) < 0.006),
    CHECK(abs(action_amount - result * action_pct / 100) < 0.006),
    -- Et tout est stocké AU CENTIME : le moteur arrondit, mais un écrivain SQL
    -- direct ne doit pas pouvoir déposer du sub-centime dans la chaîne des
    -- pool_open (constat money-auditor, B4). Avec ce CHECK, la tolérance 0.006
    -- ci-dessus équivaut à « pas un centime d'écart ».
    CHECK(abs(pool_open * 100 - round(pool_open * 100)) < 0.000001),
    CHECK(abs(pool_close * 100 - round(pool_close * 100)) < 0.000001),
    CHECK(abs(ext_in * 100 - round(ext_in * 100)) < 0.000001),
    CHECK(abs(ext_out * 100 - round(ext_out * 100)) < 0.000001),
    CHECK(abs(result * 100 - round(result * 100)) < 0.000001),
    CHECK(abs(action_amount * 100 - round(action_amount * 100)) < 0.000001)
  );
  -- Un règlement ne porte qu'UNE période (et une période qu'un règlement).
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_periods_settlement
    ON pool_periods(settlement_id) WHERE settlement_id IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_pool_periods_player
    ON pool_periods(player_id, game_id, closed_at);

  -- ── Un solde par wallet, HORODATÉ, figé avec la période ───────────────────
  -- account_id NULL ⇔ wallet_kind = 'main' (la wallet main n'appartient à aucun
  -- compte). observed_at : l'instant où le solde ÉTAIT celui-là — pour le main,
  -- la date de la dernière ligne OkPay ≤ closed_at (le « Changed balance »
  -- n'est vrai qu'à cet instant), pas l'heure de réception du message.
  -- C'est l'écart entre ces observed_at qui signale l'argent en vol (cas n°3).
  CREATE TABLE IF NOT EXISTS pool_period_balances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    period_id     INTEGER NOT NULL REFERENCES pool_periods(id) ON DELETE CASCADE,
    account_id    INTEGER REFERENCES pool_accounts(id),
    wallet_kind   TEXT NOT NULL CHECK(wallet_kind IN ('ak','okpay','main')),
    balance       REAL NOT NULL CHECK(balance >= 0 AND abs(balance * 100 - round(balance * 100)) < 0.000001),
    observed_at   TEXT NOT NULL,
    source        TEXT NOT NULL CHECK(source IN ('manual','okpay_ledger')),
    okpay_line_id INTEGER REFERENCES okpay_ledger_lines(id),
    CHECK((wallet_kind = 'main') = (account_id IS NULL)),
    -- Un solde « lu sur l'historique » sans la ligne qui le porte n'est pas une
    -- provenance, c'est une affirmation.
    CHECK((source = 'okpay_ledger') = (okpay_line_id IS NOT NULL)),
    CHECK(observed_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'),
    UNIQUE(period_id, account_id, wallet_kind)
  );
  -- UNIQUE ci-dessus ne couvre pas account_id NULL (NULL ≠ NULL en SQL) : une
  -- période ne doit avoir qu'UN solde main, d'où l'index partiel.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_balances_one_main
    ON pool_period_balances(period_id) WHERE wallet_kind = 'main';

  -- ── Ce qui ENTRE dans le pool ou en SORT, DATÉ ────────────────────────────
  -- 'declared'   : les champs « entrées / sorties » saisis par Baki à la clôture.
  -- 'settlement' : écrit AUTOMATIQUEMENT au markPaid d'un règlement adossé à une
  --                période (lib/manual-settlement-engine.ts), daté par
  --                settlementOccurredAt (lib/pool/engine.ts) — paid_date est un
  --                JOUR, les bornes sont à la SECONDE : le mouvement est daté
  --                max(paid_date 00:00:00, closed_at réglé + 1 s), jamais avant
  --                la clôture qu'il règle, donc jamais dans sa somme figée :
  --                'in' quand je verse ma part (agence → sa main), 'out' quand il
  --                me règle (sa main → agence). C'est ce qui rend le modèle
  --                auto-correcteur : payé tôt ou tard, le mouvement compte une
  --                fois, dans la période où il tombe — jamais supposé au lock.
  -- Des LIGNES datées et non deux scalaires dans pool_periods : c'est la seule
  -- forme qui permet au règlement de compter à SA date.
  CREATE TABLE IF NOT EXISTS pool_external_movements (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id     INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id       INTEGER NOT NULL REFERENCES games(id) ON DELETE CASCADE,
    direction     TEXT NOT NULL CHECK(direction IN ('in','out')),
    amount        REAL NOT NULL CHECK(amount > 0),
    currency      TEXT NOT NULL DEFAULT 'USDT' CHECK(currency = 'USDT'),
    occurred_at   TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK(kind IN ('declared','settlement')),
    settlement_id INTEGER REFERENCES manual_settlements(id),
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    -- Un mouvement de règlement porte son règlement, un mouvement déclaré n'en
    -- porte pas : sinon un 'declared' occuperait l'index unique et bloquerait le
    -- vrai mouvement au markPaid, ou un 'settlement' orphelin serait répétable.
    CHECK((kind = 'settlement') = (settlement_id IS NOT NULL)),
    -- Au centime : computePoolPeriod arrondit les sommes de mouvements en
    -- supposant chaque terme cent-exact — un 0.004 ici s'évaporerait dans la somme.
    CHECK(abs(amount * 100 - round(amount * 100)) < 0.000001),
    CHECK(occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]')
  );
  CREATE INDEX IF NOT EXISTS idx_pool_movements_player
    ON pool_external_movements(player_id, game_id, occurred_at);
  -- Un règlement ne produit qu'UN mouvement : son markPaid ne réussit qu'une fois,
  -- et l'index le garantit au niveau du schéma.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_pool_movements_settlement
    ON pool_external_movements(settlement_id) WHERE settlement_id IS NOT NULL;

  -- ── FAITS BRUTS : les lignes OkPay parsées depuis les messages transférés ─
  -- Une ligne par opération, pour la wallet identifiée par l'en-tête du message.
  -- wallet_tg_id peut être une main (pool_players.main_okpay_tg_id), une OkPay de
  -- compte (pool_accounts.okpay_tg_id) ou une wallet encore inconnue — la ligne
  -- est conservée dans tous les cas : c'est un fait, pas un résultat.
  --
  -- DÉDUPLICATION AU NIVEAU DU SCHÉMA : dedup_key UNIQUE + INSERT OR IGNORE. Le
  -- même message transféré deux fois ne crée jamais de doublon (cas n°5).
  --
  -- LIMITE CONNUE, à ne pas oublier : la clé est (wallet, date, sens, montant,
  -- solde après). Deux opérations réelles la partagent si, À LA MÊME SECONDE,
  -- la wallet fait +100 → 200, −100 → 100, +100 → 200 : la 1re et la 3e sont
  -- indistinguables, la 3e est avalée, et la chaîne casse entre la 2e et la
  -- suivante — de façon IRRÉPARABLE par réémission de la page (la ligne est
  -- ré-ignorée). Symptôme à reconnaître en mode audit : une rupture que le
  -- renvoi de la page ne referme pas. Probabilité jugée négligeable sur des
  -- virements manuels ; documentée plutôt que contournée. (Constat
  -- money-auditor 2026-09-13, B8.)
  CREATE TABLE IF NOT EXISTS okpay_ledger_lines (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_tg_id       TEXT NOT NULL,
    wallet_label       TEXT,
    direction          TEXT NOT NULL CHECK(direction IN ('+','-')),
    amount             REAL NOT NULL CHECK(amount >= 0),
    currency           TEXT NOT NULL CHECK(currency = 'USDT'),
    balance_after      REAL NOT NULL,
    occurred_at        TEXT NOT NULL CHECK(occurred_at GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9] [0-9][0-9]:[0-9][0-9]:[0-9][0-9]'),
    counterparty_tg_id TEXT,
    counterparty_name  TEXT,
    raw_text           TEXT NOT NULL,
    dedup_key          TEXT NOT NULL UNIQUE,
    ingested_at        TEXT NOT NULL DEFAULT (datetime('now')),
    ingest_source      TEXT NOT NULL CHECK(ingest_source IN ('telegram_forward','paste'))
  );
  CREATE INDEX IF NOT EXISTS idx_okpay_lines_wallet
    ON okpay_ledger_lines(wallet_tg_id, occurred_at, id);
  CREATE INDEX IF NOT EXISTS idx_okpay_lines_counterparty
    ON okpay_ledger_lines(counterparty_tg_id) WHERE counterparty_tg_id IS NOT NULL;
`;

/** Ligne games de la nouvelle room. default_action_pct NULL : le % vit dans player_game_deals, figé au lock. */
export const POOL_GAME_INSERT_SQL = `
  INSERT OR IGNORE INTO games (name, status, default_action_pct, currency)
  VALUES ('${POOL_GAME_NAME}', 'active', NULL, 'USDT');
`;
