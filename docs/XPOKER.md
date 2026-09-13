# XPoker Twd — le modèle, ses règles, ce qui est figé

> Document de référence du chantier `feat/xpoker-twd` (septembre 2026). À lire avant de
> toucher à `lib/games/xpoker/*`, à `manual_settlements` côté XPoker, ou au hub `/payments`.
> Écrit pour être relu dans six mois par quelqu'un qui a tout oublié.

## 1. En une page

- **La room** : XPoker (x-poker.net), club **花順** (ID club 246579 — assertion Baki, l'ID
  n'apparaît pas dans le sheet), agent **3970004** (« LeCercleAdmin2 »), format 72o · 10bb.
- **La devise** : tout est en **chips (TWD)**. Le taux chips/USD (33 à l'origine) est
  historisé dans `xpoker_chip_rates`, **figé** sur chaque import et chaque règlement, et ne
  sert **qu'à l'affichage**. Aucun montant club, aucun règlement joueur ne transite par une
  colonne USDT.
- **Le club règle l'agence en chips** chaque semaine, d'après un sheet ; l'agence est
  **dépositaire des jetons** et redistribue aux joueurs (buy-ins, cash-outs, parts d'action,
  rakeback). Un seul grand livre : `xpoker_chip_ledger`.
- **Un joueur = N Player ID** (`player_game_ids`, game `XPOKER_TWD`). Le deal (action %,
  RB %) est porté par le **joueur**, versionné par semaine (`xpoker_player_deals`), et
  s'applique à tous ses comptes. Calculs et règlement au niveau joueur ; le détail par compte
  reste lisible (`xpoker_week_rows`).
- **Deux compteurs, jamais un seul** : le stock de jetons de l'agence (Σ in − Σ out du grand
  livre) et la position d'un joueur (Σ dû de ses semaines) sont deux lectures distinctes.
- Une seule page, `/xpoker` ; les règlements se paient depuis `/payments`.

Fichiers : `lib/games/xpoker/{config,schema,club-math,parse-sheet,tab-date,engine,settlement,dashboard}.ts`,
`app/xpoker/*`, `app/api/xpoker/*`, harnais `scripts/xpoker-*.test.ts` (fixtures dans
`scripts/xpoker-fixture.ts`, **jamais le classeur réel**).

## 2. Le règlement club — formule et cas d'acceptation

Le sheet hebdo du club (un onglet par semaine, nommé par le **lundi** : « 3/23 », « 8/3 »)
porte un bloc par club. Le nôtre se repère **par ses libellés** — paramètres `幣值 / 反水 / TAX`,
en-tête `Player ID … Rake(without MTT)`, pied `Total Win/Lose … Total` — jamais par des
adresses de cellules (`parse-sheet.ts`, libellés en paramètre).

```
Total = 反水% × Σ Rake  +  TAX% × (−Σ Win/Lose − Σ Rake)
```

Expression implémentée **telle quelle** (`club-math.ts` → `clubSettlement`) : la TAX est
**signée**, pas de valeur absolue, pas de plancher à zéro, pas de branche selon le signe.
Dans la feuille : `U20 = (U18+U19) × −5 %`, `U21 = U19 × C2`, `U22 = U21 + U20`. La formule
TAX est **figée dans la feuille** (−5 %) et ne lit pas la cellule TAX des paramètres : on lit
la cellule (source déclarée), et si elle diverge, le checksum refuse (onglet 3/23 : D2 = 0).

Σ porte sur **toutes** les lignes que le club additionne : `Agent ID = 3970004` **ou**
`Super Agent ID = 3970004` (décision Q4 — le filtre strict du brief cassait le checksum sur
8 onglets sur 19), comptes agence compris (3970004, 3999050 : `xpoker_agency_accounts`,
comptés dans le total, jamais dans une position joueur).

**Cas d'acceptation** (au 1/100 de centime, `scripts/xpoker-parse.test.ts`) :

| | Win/Lose | Rake | 反水 80 % | TAX 5 % | Total |
|---|---|---|---|---|---|
| 1 joueur — 3062825 | −136,20 | 256,43 | **205,144** | **−6,0115** | **199,1325** |
| 3 joueurs — 3062825 / 4136708 / 4107823 | −31 267,40 / −11 722,87 / +14 053,56 = −28 936,71 | 4 647,88 / 2 731,06 / 2 845,38 = 10 224,32 | **8 179,456** | **+935,6195** | **9 115,0755** |

**Checksum obligatoire** : le recalcul ligne à ligne doit retomber sur le `Total` du pied
(tolérance 0,005). Écart ⇒ import **refusé**, zéro ligne écrite. Seule sortie : « importer
quand même, écart acté » avec motif (`override_reason`) ; la semaine reste marquée
`check_ok = 0` et **n'est jamais réglable en un clic**.

Le sheet a **deux totaux** : `Total` (U22, le pied) et `總交收` (B20, le bloc de règlement).
Les deux sont stockés (`sheet_total`, `sheet_cleared`, plus la ligne club B11 dans
`sheet_cleared_club_line`) ; `cleared_matches` dit s'ils divergent (4 semaines de mars-avril
2026 avaient B11 = U21). **Le montant reçu est celui que Baki confirme** au grand livre
(`club_settlement`, un par import), jamais celui que la feuille calcule.

Pièges confirmés : `R` (ID) et `T` (nickname) sont des **libellés** — `XP40049772` est un
pseudo, pas l'ID `4025681` ; on ne rattache **jamais** dessus, uniquement sur `S` (Player ID).
Grille à hauteur fixe avec lignes vides au milieu : on lit toute la zone. Champ vide = non
saisi, **jamais zéro** (refus). CSV natif : taux en texte « 80% », nom d'onglet perdu.
Année absente du nom d'onglet, et « 111 » = 1/11 ou 11/1 : la semaine est une **plage de dates
confirmée à la main** (`tab-date.ts` ne fait que proposer).

## 3. Le sens de l'action — confirmé, symétrique, sans exception

```
part d'action = action_pct × Win/Lose du joueur, du point de vue AGENCE
  joueur gagne 1 000 → action 10 % = +100 → LE JOUEUR ME DOIT 100
  joueur perd  1 000 → action 10 % = −100 → JE DOIS 100 AU JOUEUR
```

Pas de plancher à zéro, pas de makeup. Calculée **ligne par ligne** sur le Win/Lose de chaque
compte, jamais un % appliqué au total du bloc puis réparti. Même convention que
`manual_settlements` et le hub (`due > 0` = « Il nous doit », vert ; `due < 0` = « On lui
doit », rouge).

Cas de référence (semaine 7/20, action 10 %) :

| Player ID | Win/Lose | Part d'action | Lecture |
|---|---|---|---|
| 4107823 | +14 053,56 | **+1 405,356** | il me doit |
| 4136708 | −11 722,87 | **−1 172,287** | je lui dois |
| 3062825 | −31 267,40 | **−3 126,74** | je lui dois |

Ces trois lignes coexistent avec un règlement club de **+9 115,0755** la même semaine : deux
flux distincts, jamais nettés. Le test `12bis` échoue si quelqu'un retourne le signe
(vérifié : 11 ✘ avec le signe inversé).

**Rakeback joueur** : `rb_pct × rake` du compte, ≥ 0. **Dû net d'une semaine** = part
d'action − rakeback. Buy-ins et cash-outs sont de la **trésorerie**, jamais dans un
règlement (règle NEXA, Q11).

## 4. Pourquoi XPoker est hors compensation du hub

Baki verse et encaisse **en chips** (Q1bis = A). Une ligne XPoker de `manual_settlements`
porte le montant réglé dans `amount_due_native` (`native_currency = 'TWD'`) ;
`amount_due_usdt` n'est qu'un **équivalent d'affichage** au taux figé (`fx_rate_applied`),
jamais un montant à payer. Compenser un dû en chips contre des USDT d'une autre room
produirait un net que personne ne peut payer tel quel : **deux lignes vraies plutôt qu'un
net faux** (Q1).

Concrètement (`manual-settlement-engine.ts`, `isNativeSettlement`) : les lignes natives sont
listées dans le hub, mais **exclues** de `groupPendingByPlayer.net_usdt / incoming /
outgoing`, de `getPaymentsTotals` (comptées dans `native_pending_count`), des sommes client
de `/payments`, du net du résumé quotidien et de `get_unpaid_settlements`. Libellé partout :
« X chips (≈ Y USD — équivalent d'affichage, jamais un montant à payer) », badge `CHIPS`.
Un joueur qui n'a que des règlements en chips affiche « rien en USDT ».

## 5. Pourquoi le deal est hors `player_game_deals`

La commande bot `/deal` (`lib/telegram-commands/player-self-service.ts`) liste
`player_game_deals` **avec le rakeback** au joueur. Or le **RB XPoker n'est jamais notifié**
— aucun message Telegram, aucune ligne de récap, aucune comm automatique : c'est de la donnée
interne. Stocker le deal XPoker dans `xpoker_player_deals` rend la règle **structurelle** :
si quelqu'un touche `player-self-service.ts` dans un an, XPoker ne fuit pas. Vérifié aussi :
`/payments`, `manual-settlement-engine`, `ops-notifications` n'émettent rien vers un joueur.

## 6. Les unités — deux noms, jamais le même mot

| Côté | Colonne | Unité | Exemple |
|---|---|---|---|
| sheet / import | `xpoker_imports.rb_fraction`, `tax_fraction`, `ClubParams` | **fraction** | `0.8` = 80 % |
| deal / règlement | `xpoker_player_deals.action_pct`, `rb_pct`, `xpoker_settlement_weeks.*_pct` | **pourcent** | `10` = 10 % |

Fermé des quatre côtés (R2 money-auditor) : nom, `CHECK` (`[0,1]` vs `= 0 OR [1,100]`),
assertion à l'exécution (`assertFraction` / `assertPct` refusent l'unité inverse — `0.8`
saisi comme pourcent est refusé, pas interprété comme 0,8 %), typage (`ClubParams`).
Contrefactuel : `(0.8/100) × 256.43 = 2.05144 ≠ 205.144`. La TAX n'existe qu'en fraction.
0 % est accepté (défaut de la plupart des joueurs).

## 7. Ce qui est figé, et ne se recalcule jamais

- **À l'import** (`xpoker_imports`) : paramètres et pied tels que lus, B20 et B11, recalcul,
  `check_delta`, **taux chips/USD à la date de fin de semaine**, `club_id`. Un nouveau taux
  n'y touche pas.
- **Au lock d'un règlement** (`xpoker_settlement_weeks`) : par semaine, win/lose, rake,
  `action_pct`, `rb_pct`, `action_chips`, `rb_chips`, `due_chips`, taux, `import_id`. Le
  montant est **recalculé par le moteur** au lock (l'écran envoie des semaines, jamais des
  montants) puis ne bouge plus.
- **Garde F2** : un deal ne commence jamais avant ni sur une semaine **importée** (donc a
  fortiori réglée) — sauf le premier deal d'un joueur, qui peut couvrir l'historique. Le refus
  liste les semaines qui bloquent.
- **Garde R1** : déplacer un Player ID (`relinkMemberIdOn`) recalcule les deux joueurs mais
  **refuse** si une semaine concernée est réglée (liste nommée), et laisse une trace
  (`xpoker_relink_log`). Rattacher un ID orphelin sur une semaine déjà réglée chez le joueur
  cible est refusé de même (F1).
- **Grand livre** : rien au lock ; au `markPaid` seulement, dans la même transaction :
  `action_paid` (in s'il me doit, out si je lui dois) + `rb_paid` (out), datés de la **date
  réelle du transfert, obligatoire**. Une fois par nature (UNIQUE schéma). Un règlement payé
  ne se déverrouille pas ; un règlement porteur de mouvements ne se supprime pas (NO ACTION).
  Le grand livre est **append-only** : une ligne fausse se contre-passe
  (`reverseLedgerLineOn`, `reverses_id`, une fois, motif obligatoire), jamais sur une ligne
  née d'un règlement.
- **Jamais lockable** : semaine incalculable (joueur sans deal), import en écart (acté ou
  non), semaine déjà réglée. Refus nommés avant SQL ; `UNIQUE(player_id, week_start)` en
  dernier rempart. `deleteImportOn` refuse si une semaine réglée s'appuie sur l'import.

## 8. Réserves laissées ouvertes, sciemment

- **`CHECK (= 0 OR [1,100])`** sur `action_pct` / `rb_pct` : un deal à 0,5 % est refusé.
  Choix A de Baki (aucun cas < 1 %) ; le jour venu, migration `_v2` qui relâche la borne.
- **`member_id` sans clé étrangère** vers `player_game_ids` (clé composite
  `(game_id, external_id)`) : la cohérence vit dans `linkMemberIdOn` / `addLedgerLineOn`.
- **Pas de colonne `actor`** hors `xpoker_relink_log` (`'baki'` en dur) : pas d'auth en v1.
- **Pas de `status` sur `xpoker_imports`** : `check_ok`, `override_reason` et le mouvement
  `club_settlement` couvrent les états réels.
- **Lignes sous-agent** (`is_sub_agent = 1`, ex. wisdomcomes sous Shangyu) : comptées dans le
  dû du joueur — conforme à Q4 (c'est un joueur de Baki). Les 9 semaines historiques
  concernées portent `sub_agent_present = 1` et un champ d'ajustement manuel **non utilisé**
  tant que le club n'a pas confirmé un partage.
- **`playerWeeksOn` calculé deux fois** par joueur dans `dashboard.ts` : perf, pas argent.
- **Import hebdo non câblé** sur le classeur réel tant que le club n'a pas confirmé :
  花順 = 246579 ? quel classeur fait foi (le dernier onglet est le 8/3, cinq lundis sans onglet
  au 13/09) ? format inchangé ? Le parseur est dérivé des libellés : un nouveau classeur se
  teste en changeant la config, pas le code.

## 9. Au premier déploiement — à savoir avant le `railway up`

- **`add_xpoker_twd_v1` n'a jamais tourné en prod.** Rejouée sur une copie de la base prod
  (2026-09-13) : 0 cellule modifiée sur 34 lignes `player_game_ids` et 207 lignes
  `manual_settlements`, `integrity_check ok`, colonnes additives à `NULL` / `'active'`.
  Marqueur posé après le travail, ROLLBACK dans le catch, corps rejouable, report si une
  transaction étrangère est ouverte.
- **`add_pool_settlement_v1` (AK multi-Account) part dans le même boot** : elle est sur
  `main` mais pas en prod (111 fixes en prod → 113 après). Inerte (`CREATE TABLE IF NOT
  EXISTS` + une ligne `games`), aucune route ne lit ses tables ; seul effet visible : la game
  « AK multi-Account » dans les sélecteurs génériques. Cf. TODOS.md.
- **Plus aucune édition en place du schéma XPoker après ce déploiement.** L'index
  `UNIQUE(settlement_id, kind)` et les `CHECK` ont été réécrits en place pendant le chantier
  parce que rien n'était déployé ; ensuite, chaque changement = une migration `_v2`
  append-only (invariant #6), et un oubli coûte une migration.
- Après `Deploy complete` : vérifier le log `[MIGRATION] add_xpoker_twd_v1 applied`, ouvrir
  `/xpoker` (page vide, « Aucune semaine importée… »), et `/payments` (aucune régression sur
  les rooms USDT — `isNativeSettlement` est faux pour toutes leurs lignes).
- Séquence prévue ensuite : rattachement des Player ID connus (3062825, 4136708, 4107823,
  4100859, 3999960, 4025681, 4031876, 4004977, 4015766) aux @ Telegram donnés par Baki, deals,
  puis premier import — uniquement après confirmation de la source.
