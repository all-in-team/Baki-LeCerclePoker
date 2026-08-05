# Réserves ouvertes — miroir NEXAPOKER et bornes de deal

Issues des audits `money-auditor` du chantier NEXA (commits `6658d24` et `ade7f63` — verdicts
**GO SOUS RÉSERVE, 0 faille**). Aucune ne produit un montant faux sur l'état actuel des données.
Elles sont ici parce qu'elles peuvent en produire un plus tard, et qu'aucune n'est corrigée.

Réserves **1 à 5** : miroir `player_game_deals` et bornes de deal (audit du 6658d24).
Réserves **6 et 7** : règlement de la part d'action (audit de C4, ade7f63).

Contexte : `player_game_deals` sert de **cache de période courante** pour NEXAPOKER. La vérité est
historisée dans `nexa_player_action_shares` / `nexa_player_rakeback`. Le commit `6658d24` a rendu
`player_game_deals.start_date` opérante pour NEXA — c'est ce qui donne du poids aux réserves
ci-dessous : une borne qui ne servait à rien borne désormais de l'argent.

---

## ✅ CLOS — chiffrage de l'impact du backfill en prod : **0 ligne**

La migration `nexa_mirror_start_date_v1` (`lib/db.ts`) pose
`player_game_deals.start_date = MIN(nexa_player_action_shares.start_week)` sur les deals NEXAPOKER
qui l'avaient à NULL. Une fois posée, la borne
`pgd.start_date IS NULL OR wt.tx_datetime >= pgd.start_date` **exclut des lignes entières** — pas
seulement un pourcentage — dans une quinzaine de requêtes d'argent (`getPlayerWalletStats`,
`getPlayerBalance`, `getWalletKPIs`, `getNetPnlSeries`, `getWalletSummaryByPlayer`…).

**Passé en prod le 2026-08-05, avant le déploiement : résultat `0`.** La migration a d'ailleurs
loggué `nexa_mirror_start_date_v1 applied — 0 deal(s) NEXAPOKER datés` : aucune borne posée, donc
aucune transaction exclue, donc aucun montant affiché n'a bougé. Requête conservée ici pour la
prochaine fois qu'un deal NEXA sera créé en prod :

```sql
-- Mouvements NEXAPOKER qui SORTIRONT des agrégats à cause de la nouvelle borne.
-- Résultat attendu : 0. Tout résultat > 0 = des montants déjà affichés vont changer.
SELECT wt.player_id, p.name, COUNT(*) AS tx_exclues,
       SUM(CASE WHEN wt.type = 'deposit'    THEN wt.amount ELSE 0 END) AS depots_exclus,
       SUM(CASE WHEN wt.type = 'withdrawal' THEN wt.amount ELSE 0 END) AS retraits_exclus,
       MIN(wt.tx_datetime) AS plus_ancien, d.start_date AS borne
FROM wallet_transactions wt
JOIN player_game_deals d ON d.player_id = wt.player_id AND d.game_id = wt.game_id
JOIN games   g ON g.id = d.game_id
JOIN players p ON p.id = wt.player_id
WHERE g.name = 'NEXAPOKER'
  AND d.start_date IS NOT NULL
  AND wt.tx_datetime < d.start_date
  AND (wt.source IS NULL OR wt.source != 'unknown')
GROUP BY wt.player_id, p.name, d.start_date;
```

Accès prod : la clé SSH Railway n'est pas enregistrée (`railway ssh keys add`). Le chiffrage a été
passé via `POST /api/admin/db-diagnostic` (action `run-sql`, SELECT seul) — cette route est hors du
matcher d'auth et gardée par une clé en dur, voir le point de sécurité dans CLAUDE.md.

---

## Réserve 1 — `PATCH /api/games {status:'archived'}` : le dernier chemin NEXA non gardé

**Risque accepté par Baki (2026-08-05) : il n'archivera pas NEXAPOKER.** Documenté ici, non corrigé.

`app/api/games/route.ts` pose `end_date = date('now')` sur tous les deals ouverts du game, **sans
exclusion NEXAPOKER**. C'est le seul écrivain de `player_game_deals` pour NEXA qui échappe à la
garde de `lib/queries.ts`.

Ce qui rend la chose irréversible :
- le désarchivage (`status:'active'`) ne remet **pas** `end_date` à NULL — délibérément : un
  `SET end_date = NULL WHERE game_id = ?` détruirait aussi les clôtures posées joueur par joueur
  (`stopQqpkPlayer`, décochage d'une game dans `PlayerEditModal`). La modale de confirmation
  l'annonce déjà : « Les deals des joueurs ne seront PAS réactivés automatiquement » ;
- `setActionShareOn` ne fait un `COALESCE` que sur `start_date`, jamais sur `end_date` ;
- `PATCH /api/games/deals/[id]` répond 409 pour NEXA.

→ Archiver puis réactiver NEXAPOKER exclurait **définitivement** tous les mouvements NEXA de
`getPlayerWalletStats` / `getPlayerBalance`, réparable uniquement par un UPDATE SQL manuel.
NEXAPOKER est le seul game dont le deal ne peut pas être réparé depuis l'UI.

**Correctif propre** : ajouter `games.archived_at` (migration append-only), et borner la réouverture
à `WHERE game_id = ? AND end_date = date(archived_at)` — ce qui distingue enfin « fermé par
l'archivage » de « fermé à la main ». Aujourd'hui rien ne permet cette distinction.

## Réserve 2 — `PlayerEditModal` ne teste pas `res.ok`

`app/players/PlayerEditModal.tsx` (`handleSave`) ignore le statut HTTP. Éditer l'Action % NEXA
depuis `/players` paraît réussir — modale fermée, aucune erreur — puis la valeur revient au
`router.refresh()`. Rien de faux n'est persisté (le 409 bloque l'écriture), mais l'écran affirme une
écriture qui n'a pas eu lieu.

C'est exactement le défaut corrigé dans `PlayerDetailClient` (`removeDeal`, `updateDeal`) par
`6658d24`, non couvert ici. Même remarque, moins grave, sur `PlayersKanbanView.tsx:42`.

## Réserve 3 — champ « Rakeback % » trompeur pour NEXAPOKER

`PlayerEditModal` affiche un champ RB alimenté par `player_game_deals.rakeback_pct`, qui pour NEXA
vaut **toujours 0** : le rakeback n'est délibérément jamais mirroité (voir `setRakebackOn`).
`nexa_player_rakeback` est vide aujourd'hui, donc rien de faux à l'écran. Dès le premier RB NEXA
saisi, cette modale affichera 0 % comme un fait. `PlayerDetailClient` porte l'avertissement,
pas cette modale.

## Réserve 4 — la borne exclut des lignes, elle ne neutralise pas un %

Voir l'encadré de chiffrage ci-dessus. Un buy-in enregistré **avant** que la part d'action ne soit
saisie sortirait de `deposited` / `withdrawn` / `net`, pas seulement de `my_pnl`, et **sans aucun
signal**. `setActionShareOn` refuse le backdating (`players.ts`), donc la borne ne peut pas reculer :
pas de dérive future, mais le cas « mouvement saisi avant la part » reste possible.

## Réserve 5 — nits

- `app/api/reports/save/route.ts` : le `SELECT name FROM games` de la garde NEXA est invariant de
  boucle, exécuté une fois par ligne de report. À hisser au-dessus du `for`.
- `nexa_mirror_start_date_v1` utilise `SELECT 1 … puis INSERT OR IGNORE` au lieu du pattern
  `INSERT OR IGNORE … if (changes > 0)` de CLAUDE.md §6. Inoffensif (l'UPDATE est idempotent via
  `WHERE start_date IS NULL`), mais non canonique.

---

## Réserve 6 — « déjà réglé » ne distingue pas `locked` de `paid`

`getNexaPlayerDetailOn` calcule `action_settled` à partir de **toutes** les lignes de
`nexa_action_settlement_weeks`, sans regarder le `status` du `manual_settlements` qui les porte. Une
semaine verrouillée mais **pas encore encaissée** sort donc de la position nette au même titre
qu'une semaine payée.

C'est correct pour l'anti-double-comptage — la semaine ne doit pas repartir dans un second
règlement — mais le libellé du pied de page (« un dû éteint ne doit plus s'afficher comme dû ») est
inexact pour une ligne `locked` : elle n'est pas éteinte, elle est en attente de paiement dans
`/payments`. Le montant reste visible là-bas, donc rien ne disparaît ; c'est la formulation qui
ment.

Correctif : scinder `action_settled` par statut (`action_locked` / `action_paid`), ou au minimum
reformuler le pied de page. Aucune math à changer.

## Réserve 7 — aucun détecteur d'oubli sur une semaine d'action jamais verrouillée

Depuis l'exclusion de NEXAPOKER de `getOverdueBuckets` (réserve fermée par le commit du
2026-08-05), **rien ne signale une semaine d'action réglable qu'on aurait oublié de verrouiller** :

- pas dans les impayés — NEXA en est exclu, et à raison : son règlement n'est pas adossé aux
  transactions, donc `wallet_transactions.settled` ne peut rien détecter ;
- pas dans les règlements en attente — `getPendingSettlements` ne voit que les lignes **déjà**
  `locked` ;
- pas dans le résumé Telegram quotidien ni dans `get_unpaid_settlements`.

Elle n'est visible que si on ouvre `/nexapoker` et qu'on clique « Détail » sur le joueur. C'est un
angle mort assumé, pas un bug : le détecteur qu'on a retiré ne détectait rien d'utile et polluait
l'alerte. Mais il n'a pas été remplacé.

Correctif possible : un compteur « N semaine(s) réglables non verrouillées » sur la vue agence
(la donnée existe déjà via `getSettleableActionWeeksOn`), ou une ligne dédiée dans le résumé
quotidien.

## Limite constatée — la reprise sur 529 ne couvre pas une saturation longue

`app/api/nexa/affiliate/extract/route.ts` retente un 529 trois fois (2 s, 5 s, 10 s), soit **~17 s de
saturation absorbée**. Constaté en vrai le 2026-08-05 sur les trois semaines de juillet : le
screenshot du **20.07 est passé par l'extraction**, celui du **13.07 a échoué malgré les reprises** et
a été saisi à la main. La saturation a donc duré plus longtemps que la fenêtre.

Ce n'est pas un bug : le chemin de repli — saisir la semaine à la main dans la grille — existe et a
fonctionné. Mais si le cas se répète, la piste est d'allonger l'échelle (`RETRY_DELAYS_MS`) plutôt
que d'ajouter des reprises rapprochées. À arbitrer avec le temps d'attente à l'écran, déjà de ~17 s
avant que le message n'apparaisse.

## Trou de couverture connu

Les gardes NEXA de `lib/queries.ts` (`upsertPlayerGameDeal`, `deletePlayerGameDeal`,
`updatePlayerActionPct`) **ne sont couvertes par aucun test automatisé**. Ces fonctions passent par
`getDb()`, dont le `DB_PATH` est figé au chargement du module et ne suit pas le `process.chdir()` du
harnais : les exercer depuis `scripts/*.test.ts` écrit dans la vraie `data/lecercle.db` (constaté,
puis nettoyé). Elles sont vérifiées manuellement par HTTP (`PATCH`/`DELETE`/`POST` → 409, aucune
écriture). Pour les couvrir proprement il faudrait leur donner une forme `xOn(db, …)`, comme les
modules NEXA.
