# TODOS

Deferred work from /plan-ceo-review (2026-04-28).

## P0 — Ouvert cette semaine (décision Hugo, 2026-08-18)

### `add_a5poker_game_v1` laisse une transaction ouverte pour tout le reste du boot
- **Où :** `lib/db.ts:1061-1090`
- **Quoi :** la migration pose son marqueur `_applied_fixes` **avant** de travailler
  (`:1062`), fait `BEGIN … COMMIT`, et son `finally` ne restaure que le PRAGMA — **il n'y a
  pas de ROLLBACK**. Quand le `db.exec` échoue en cours (constaté sur base vierge :
  `no such column: default_action_pct`), la transaction reste ouverte **jusqu'à la fin du
  processus** (`db.inTransaction = true` mesuré à la sortie d'`initSchema`).
- **Pourquoi c'est élevé :** sur une base touchée — A5POKER n'est jamais ajouté, le marqueur
  est posé donc la migration ne se rejoue **jamais**, `games_new` et `games` coexistent, une
  **douzaine de migrations postérieures échouent en cascade** (`add_aapkmy_game_v1`,
  `fix_player_game_ids_fk_v1`, `drop_games_name_check_v1`, tous les `add_*_game_v1`…), et
  tout ce que l'app écrit ensuite vit dans une transaction jamais committée : invisible de
  `getReadonlyDb()` et perdue au moindre crash.
- **Comment on l'a vu :** le chantier « règlement BR » a ajouté une migration avec
  `BEGIN`/`ROLLBACK` ; son ROLLBACK de secours a annulé ~2 400 lignes de schéma d'un coup et
  fait tomber la suite `group-provisioning` (`no such table: group_creations`). Le chantier
  BR **contourne** le problème (garde `db.inTransaction` → report au prochain boot) ; il ne
  le corrige pas.
- **À faire :** ROLLBACK dans le `finally`, marqueur posé **après** le travail (comme
  `add_nexa_bankroll_weeks_v1` et `add_nexa_rakeback_settlement_v1` le font déjà), et
  vérifier l'état réel des bases de prod avant de rejouer quoi que ce soit.
- **Vérifié par :** money-auditor, passes 4 à 8 du chantier BR (2026-08-17/18).

### Déclencheurs à surveiller — issus du même audit
- **Périmètre sync NEXAPOKER** — le calcul de bankroll ne lit que `source='manual'` ;
  `net_movements` lit `manual + sync`. Inoffensif aujourd'hui (aucun appelant de
  `/api/wallets/sync` ne passe `game_name: "NEXAPOKER"`). **Devient bloquant** le jour où la
  synchro NEXAPOKER est câblée : tout dépôt/cash-out on-chain serait invisible du calcul BR
  et échapperait au refus de mouvement tardif.
- **Discriminant `br_effect`** — la classification d'un mouvement de règlement BR (entrée /
  sortie / sans effet sur la bankroll) est **re-dérivée à la lecture** d'une LEFT JOIN sur
  `nexa_player_bankroll_weeks.transfer_movement_id`. Si la ligne BR disparaît, le mode
  d'échec est un **basculement silencieux de signe** (jusqu'à 973,20 d'erreur), pas une
  erreur. Inatteignable derrière trois gardes aujourd'hui. **À poser en précondition de la
  prochaine fonction touchant `nexa_player_bankroll_weeks`.**
- **F-D / F-E** — `action-settlement.ts` n'écrit aucun mouvement au paiement, le chemin BR en
  écrit un : deux joueurs aux mêmes chiffres afficheront des `net_movements` différents. Et
  `getPlayerWalletStats` (`lib/queries.ts:806-808`) applique `action_pct` à tout mouvement,
  donc fabrique un `my_pnl` à partir d'un versement de règlement. Même geste à faire.

### `add_pool_settlement_v1` en attente de déploiement depuis `main` — tout `railway up` la joue
- **Constat (rejeu XPoker sur copie prod, 2026-09-13) :** `_applied_fixes` prod = 111 ; un boot
  sur `main` passe à 113 — `add_pool_settlement_v1` (AK multi-Account, `lib/pool/schema.ts`)
  n'est pas en prod. Le prochain déploiement de `main`, quel que soit le chantier, l'applique.
- **Inerte ?** Oui : 6 `CREATE TABLE IF NOT EXISTS` + `INSERT OR IGNORE` d'une ligne `games`
  (`AK multi-Account`, active), FK vers des tables existantes, aucun ALTER/DROP/UPDATE, marqueur
  posé après le corps, rejouable. Aucune route ni page ne lit ces tables sur `main`
  (seul `lib/pool/okpay-parse.ts`, non branché). Seul effet visible : la nouvelle ligne `games`
  apparaît dans les sélecteurs génériques (fiche joueur, /crm/games, broadcast bot).

### SQL libre sur les tables d'argent — `db-diagnostic` (P0) et `query_db` (à cadrer)
- **`app/api/admin/db-diagnostic/route.ts`** : hors auth, clé en dur dans le repo
  (`db-diag-20260518`), action `run-sql` qui exécute du SQL arbitraire — un `run()` en
  écriture si la requête ne commence pas par SELECT. Trou connu, acté par Baki le
  2026-09-13 après une lecture prod SELECT-only (chantier XPoker). **Plus jamais un
  chemin de travail par défaut** : toute lecture prod se demande à Baki.
- **`query_db` de l'agent IA** (`lib/agent-tools.ts` → `runReadonlyQuery`) : même
  famille — SQL libre sur `manual_settlements`, `wallet_transactions`, etc. — mais avec
  de vraies gardes : connexion `getReadonlyDb()` (SQLite refuse l'écriture), SELECT/WITH
  seuls, une instruction, denylist de mots-clés et de tables credentials, 200 lignes.
  Risque résiduel = lecture/mésinterprétation de chiffres d'argent par l'agent, pas
  d'écriture. À cadrer avec db-diagnostic (auth, journalisation des requêtes), hors
  périmètre du chantier XPoker.

## P1 — High value, build next

### Smart alerts (loss threshold)
- **What:** Telegram alert when a player's net P&L crosses a configurable threshold (e.g. -$2000)
- **Why:** Catch underwater players before losses compound
- **Effort:** ~30 min (CC). Data + Telegram bot already exist.
- **Depends on:** Unified P&L query (must be built first)

### Player self-service via Telegram
- **What:** /historique (last 10 transactions) and /deal (current deal terms) bot commands
- **Why:** Reduces "what's my deal again?" back-and-forth messages with players
- **Effort:** ~45 min (CC). Extends existing bot + queries.
- **Depends on:** telegram_chat_id on players table (built in current phase)

## P2 — Medium value, needs careful planning

### Refactor Telegram webhook into command modules
- **What:** Extract each bot command (/deal, /depot, /retrait, /pnl, /solde, /start, etc.) into separate handler files under lib/telegram-commands/
- **Why:** Webhook handler is the hottest file (18 touches in 30 days) and growing with each new command
- **Effort:** ~30 min (CC). Pure refactor, no behavior change.
- **Depends on:** Nothing. Do whenever the file feels painful to navigate.

### Cashout automation via Tron
- **What:** When operator approves a cashout in the queue, auto-send USDT from wallet mere to player's cashout wallet
- **Why:** Eliminates manual crypto transfers. Closes the loop from approval to payment.
- **Effort:** ~2 hours (CC). Needs private key management (sensitive).
- **Depends on:** Cashout queue (built in current phase), secure key storage strategy
- **Risk:** Private key on Railway volume. Consider hardware wallet integration or manual approval step before broadcast.

### Nature d'une wallet mère : aucun écran pour poser `kind`
- **What:** `wallet_meres.kind` ('operator' | 'room_hot') n'est posé que par la migration
  `add_wallet_mere_kind_v1`. Aucune route, aucun formulaire ne permet de le lire ni de le changer.
  Ajouter la colonne à la gestion des mères (affichage + choix à la création) et à `addWalletMere`.
- **Why:** F1 de l'audit money-auditor du 2026-09-23. Une hot wallet de room enregistrée comme
  mère part en 'operator' par défaut : ses versements vers les wallets de dépôt sont écartés en
  silence, exactement le bug des 7 dépôts de Raph (4 530 USDT). L'exclusion se fait aujourd'hui
  par ADRESSE, ce qui protège d'un ré-ajout de l'adresse OkPay — mais pas d'une NOUVELLE room qui
  paierait ses cashouts depuis son propre hot wallet.
- **Effort:** ~30 min (CC). Colonne déjà en base, il ne manque que la lecture/écriture côté UI.
- **Depends on:** rien. Le correctif est déjà en prod.

### Bandeau des lignes écartées absent de deux écrans
- **What:** `/api/wallets/sync` renvoie `skipped_from_mere` + `skipped_details`, mais seul
  `components/ledger/extras/SyncWalletsButton.tsx` les affiche. `app/akpoker/pnl/TELEClient.tsx`
  et `app/qqpk/pnl/QqpkStakingClient.tsx` appellent le même endpoint et n'affichent que `imported`.
- **Why:** Sur ces deux écrans, une ligne écartée reste invisible — c'est le silence qui a coûté
  les 7 dépôts de Raph. AKS notamment a 16 lignes écartées en attente d'arbitrage (Maxime, pid 181).
- **Effort:** ~20 min (CC). Extraire le bandeau de SyncWalletsButton en composant partagé.
- **Depends on:** rien.

### Le résumé d'un sync disparaît quand tout s'est bien passé
- **What:** `SyncWalletsButton` recharge la page 1,2 s après un sync dès que `imported > 0` et
  qu'aucune ligne n'a été écartée. Le rechargement efface le compteur « +N importés » avant
  qu'on ait pu le lire. Le cas `skipped_from_mere > 0` est déjà protégé (pas de rechargement) ;
  c'est le cas nominal qui reste illisible.
- **Why:** Demande Baki, 2026-09-23. On veut pouvoir lire le résumé d'un sync même quand il
  s'est bien passé : combien de dépôts, combien de retraits, par joueur. Aujourd'hui, la seule
  façon de savoir ce qu'un sync a fait est d'aller lire la base. Constaté pendant la validation
  du correctif room_hot : le re-sync a bien importé les 7 dépôts de Raph, mais la capture d'écran
  n'a rien pu montrer — la page s'était déjà rechargée.
- **How:** Garder le résumé affiché et remplacer le rechargement automatique par un bouton
  « Actualiser », ou différer le rechargement jusqu'à ce que l'utilisateur ferme le résumé.
  Afficher le détail par joueur (`results[]` est déjà dans la réponse de l'API, jamais affiché).
- **Effort:** ~20 min (CC). Aucun changement côté API.
- **Depends on:** rien. À faire avec l'extraction du bandeau en composant partagé (entrée
  ci-dessus) : c'est le même composant.
