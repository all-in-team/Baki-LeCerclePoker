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

### Accès admin — suite du hotfix `db-diagnostic` (P0)
- **Fait (2026-09-25).** `db-diagnostic` (run-sql, reset-player, migrate), hors auth, clé en dur
  dans un dépôt alors public : supprimée. `/api/admin/*` exige une session (merge `ba59fb0`,
  vérifié en prod : 36 routes × GET/POST → 401). `ADMIN_RECONCILE_TOKEN` tourné, nouvelle
  valeur en variable Railway uniquement. **Dépôt GitHub encore PUBLIC au 2026-09-25 18:47 UTC
  (`gh api` → `private: false`, page accessible sans connexion) : à passer en privé.** Les 9 clés en dur retirées
  (branche `chore/admin-keys-cleanup`). **Lecture prod = dump `railway volume files download`,
  jamais une route.**
- **Comparaison au 16/08 (sauvegarde locale) : rien d'inexpliqué côté argent.** 2 433 tx
  communes, aucune colonne d'argent modifiée ; les 1 987 tx disparues = purge de l'incident
  « contrat USDT » du 16/08 (joueur 148, cf. `dd45937`), faite à la main hors code. Non
  attribuables faute de trace : 9 `action_pct` modifiés (dont 3 passés à 100 %). Reste ouvert :
  la sauvegarde locale diffère du fichier du volume de même nom (6 336 512 vs 6 320 128 o).
- **Webhooks Telegram / DZPK fail-open** (`app/api/telegram/webhook/route.ts:50-54`,
  `app/api/telegram/dzpk/webhook/route.ts:20-22`) : secret vérifié seulement s'il est défini.
  Les deux secrets sont posés en prod ; passer le code en fail-closed. Même schéma sur
  `app/api/cron/*` (`AGENT_REPORT_SECRET`).
- **Aucune trace de qui fait quoi** : pas d'`archived_by`, pas d'historique des deals, pas de
  log des PATCH. Les 54 archivages du 13/09 et les 9 changements d'`action_pct` depuis le 16/08
  ne sont pas attribuables.
- **`/api/login`** : aucune limite de tentatives ; mot de passe unique ; JWT 30 j sans
  révocation ; rôle du JWT non vérifié par le middleware.
- **Matcher du middleware** : la négation n'a pas d'ancre de fin (`/goals`, `/loginx`,
  `/api/cronjobs` échappent à l'auth). Aucune route concernée aujourd'hui.
- **Routes one-shot dangereuses à supprimer** : `cleanup-shells` (ids 46-49 en dur),
  `test-onboarding` (crée et efface un joueur), `drain-queue`.
- **`/crm/affiliates`** : un 401 (session expirée) laisse une modale vide, sans message.
- **Deux chemins d'archivage de room** : `/crm/games` (`PATCH /api/games/[id]`) ne pose que
  `status`, sans fermer les deals ni retirer les wallets mères, contrairement à
  `PATCH /api/games` (`app/api/games/route.ts:37-45`). India, NUTSPK, JVIP, TTPOKER, WN ont
  été archivées par le premier : leurs deals sont restés ouverts.
- **`query_db` de l'agent IA** (`lib/agent-tools.ts` → `runReadonlyQuery`) : SQL libre en
  lecture seule (`getReadonlyDb()`, SELECT/WITH, denylist, 200 lignes). Risque résiduel =
  lecture/mésinterprétation de chiffres d'argent, pas d'écriture. À cadrer (journalisation).

### Tests `xpoker-schema` / `xpoker-settlement` dépendants de l'ordre d'exécution
- Leur bloc B copie `data/lecercle.db` du dossier courant s'il existe, sinon celui du dépôt
  principal. Un test précédent de la suite crée un `data/lecercle.db` neuf dans un worktree ;
  lancés ensuite, les deux tests échouent (`FOREIGN KEY constraint failed`). Isolés, ils
  passent (84 ✔ / 68 ✔). Rendre la source explicite (`LECERCLE_DB_SRC`) et ne jamais
  prendre une base créée par la suite elle-même.

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

### Filtre d'activité de période — NEXAPOKER et XPoker (chantier séparé, Baki 2026-09-25)
- **Quoi :** le tableau joueurs de `LedgerTable` (A5NUTS, AKS/OK, KKPOKER, JVIP, TTPOKER)
  n'affiche plus que les joueurs avec au moins un mouvement dans la période, plus ceux qui ont
  un règlement en attente (marqués « hors période · à régler »). NEXAPOKER
  (`app/nexapoker/NexaPokerClient.tsx`) et XPoker (`app/xpoker/XpokerClient.tsx`) ont leurs
  propres tableaux : pas encore filtrés.
- **Règles à reprendre telles quelles :** activité calculée sur les vraies transactions, jamais
  sur un snapshot verrouillé ; un règlement en attente n'est jamais masqué ; compteur
  « N actifs · M masqués » avec « tout afficher » ; Lifetime ne masque rien. Logique pure :
  `components/ledger/period-presence.ts`.
- **Attention :** NEXAPOKER = sens du grand livre ≠ sens de la bankroll, XPoker = réglé en chips
  hors `player_game_deals` — « à régler » n'y a pas la même définition, à cadrer avant.

### Filtre d'activité — un joueur dont le seul point ouvert est en quarantaine devient invisible
- **Constat (money-auditor, 2026-09-25) :** « à régler » = tx `settled=0` **actives** ou règlement
  `locked`. Une tx en quarantaine (`status` ≠ `active`) n'est ni comptée ni affichée. Un joueur
  sans mouvement dans la période dont le SEUL point ouvert est une tx en quarantaine à arbitrer
  sort du tableau — même en « tout afficher » il n'est marqué de rien.
- **Pourquoi c'est à traiter :** c'est le même genre de silence que le bug du hot wallet de room
  (dépôts écartés sans que rien ne le dise, `e5cbc3d`) : une décision en attente qui ne s'annonce
  nulle part. Le badge « à régler » l'ignorait déjà, le filtre ajoute la disparition de la ligne.
- **À faire :** traiter « tx en quarantaine à arbitrer » comme un point ouvert (ligne affichée,
  marque dédiée distincte de « à régler »), après avoir cadré quels `status` signifient « à
  arbitrer » vs « écarté définitivement ». Logique : `components/ledger/period-presence.ts`.

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
