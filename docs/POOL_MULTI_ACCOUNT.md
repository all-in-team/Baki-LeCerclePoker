# AK multi-Account — règlement sur le POOL des soldes

Chantier ouvert le 2026-09-13 (GO Baki). Nouvelle game `AK multi-Account`, tout passe
par OkPay (0 frais, aucune ligne TRON). Le joueur a N comptes (2 à 8, variable), chacun
avec une wallet de jeu AK et une OkPay de transit, plus SA wallet main OkPay.

## Le modèle en trois lignes

```
pool     = solde main + Σ AK + Σ OkPay
résultat = (pool fin + sorties externes) − (pool début + entrées externes)
ma part  = résultat × action_pct / 100        (player_game_deals, figé au lock)
```

C'est la grandeur du moteur bankroll NEXAPOKER : `lib/pool/engine.ts` **délègue** à
`computeBankrollWeek` (`lib/funnels/nexa/bankroll-engine.ts`). Un moteur, une grandeur.
Convention repo : `action_amount > 0` = le joueur doit au Cercle.

**Une seule table de résultat : `pool_periods`** (provenance figée + `result`). Pas
`nexa_player_weekly_winloss` — NEXA-only, sans `game_id`, hebdo, et elle alimente le
moteur rakeback NEXA. `manual_settlements` (`kind='action'`, `game_id`) porte la dérivée
`result × pct`, relié par `settlement_id` (FK **NO ACTION**). Schéma commenté :
`lib/pool/schema.ts`.

## ⚠️ Le point critique — les règlements TRAVERSENT le pool

La wallet main du joueur est DANS le pool. Donc :

| Période | Qui paie | Effet sur le pool | Mouvement écrit au `markPaid` |
|---|---|---|---|
| perdante (`action_amount < 0`) | agence → sa main | grossit | `pool_external_movements` `'in'`, `kind='settlement'` |
| gagnante (`action_amount > 0`) | sa main → agence | rétrécit | `'out'`, `kind='settlement'` |

Chez NEXA le second était `'none'`. Ici les DEUX sens comptent, **datés du paiement réel**,
jamais supposés au lock. Non comptés : il me devrait une part de mon propre versement, ou je
paierais ma part de mon propre encaissement (démontré : +45 → 13,50 fantômes, −60 → 18).

`paid_date` est un JOUR (calendrier UTC de `/payments`), les bornes sont à la SECONDE, et
le jour OkPay peut différer d'un jour (fuseau OkPay **non établi**). `settlementOccurredAt`
date le mouvement `max(paid_date 00:00:00, closed_at réglé + 1 s)` avec
`occurred_precision='day'`, refuse un paiement antérieur à la clôture. La **seconde réelle**
est résolue depuis la ligne agence (`1486389037`) du grand livre de la main — même sens,
même montant au centime, fenêtre `[jour−1, jour+1]`, après la clôture réglée, une seule
candidate **parmi les lignes non encore portées par un mouvement** (index unique
`okpay_line_id` : deux règlements égaux à un jour d'écart ne partagent jamais une ligne, R1),
ligne mémorisée — au `markPaid` ou à l'ingestion de la page
(`resolveSettlementInstantsOn`), jamais rejouée sur un mouvement déjà `second`.
**Tant qu'un règlement au jour est à ±1 jour d'une clôture (dans ou hors intervalle), la
preview BLOQUE** : payé à 19:00 après une photo à 17:59, ou « le 21 » OkPay pour un
`paid_date` du 20, il serait compté contre une photo qui ne le contient pas (audit phase 2,
A puis A'). À ≥ 2 jours, l'instant réel est du même côté de la clôture quel que soit le
fuseau. En pratique la page de la main, nécessaire à la clôture, porte la ligne agence et
résout tout à l'ingestion. Warnings : `resolution_ambiguous` (2ᵉ ligne identique arrivée
après coup), `paid_before_close` (ligne agence identique ≤ clôture réglée : le montant était
déjà dans la photo, la période réglée est surévaluée — à traiter à la main).
**Règle d'exploitation indispensable** (héritée de NEXA) : on ne clôture pas une période
tant que le règlement de la précédente est `locked` — imposée par un blocker.

**Une wallet OkPay, un pool** : `main_okpay_tg_id` et `okpay_tg_id` (comptes ouverts) sont
uniques par game (index partiels) et croisés (main ≠ compte ≠ agence) dans
`enrollPoolPlayerOn` / `addAccountOn` / réouverture à l'unlock — sinon un solde compte deux
fois (audit phase 2, B, B1). **Changer de main** est refusé tant que le dernier solde main
figé ≠ 0 — même danger que clore un compte plein (B4).

## Retours d'usage (2026-09-15)

- **Le pool de départ n'est pas modifiable, mais il se CORRIGE** : « corriger… » crée un
  mouvement externe déclaré daté clôture + 1 s, avec motif obligatoire, delta calculé
  contre le départ **effectif** (reprise + corrections déjà posées). La clôture figée reste
  vraie ; la correction se retire comme tout mouvement déclaré ; l'unlock de cette
  clôture est refusé tant qu'une correction y est posée (sinon elle deviendrait
  orpheline). Un règlement reçu ou versé n'est PAS une correction : il compte comme
  mouvement de la période, l'écran affiche « le pool de fin qui donne un résultat nul ».
- **« préciser l'heure »** d'un règlement daté au jour : déclaration de l'instant réel du
  virement (jour ± 1, après la photo réglée, pas dans une période figée, pas dans le
  futur) — lève le blocker ±1 jour quand la page OkPay de la main n'est pas disponible.
  Irréversible si l'heure est du mauvais côté de la photo (le `confirm()` le dit) ; une
  page OkPay ultérieure qui contredit l'heure déclare `declared_time_mismatch`, même si
  la ligne a été revendiquée par un autre règlement.
- Bug corrigé : l'aperçu (qui porte la liste des mouvements) n'était pas recalculé après
  « retirer » / « déclarer » — un mouvement supprimé restait affiché.
- L'instant de clôture saisi est préservé après ces actions (remis à « maintenant »
  seulement au changement de joueur et après lock/unlock).

## Cas limites (décidés)

1. Supprimer un compte = soft-close (`closed_at`), refusé si ses derniers soldes figés ≠ 0.
2. Compte ajouté : `pool_open` = `pool_close` précédent, indépendant de la liste → neutre.
3. Argent en vol : `observed_at` par solde, alerte si écart > 30 min (avertissement +
   confirmation, pas blocker). OkPay ≠ 0 → signal (transit resté en route).
4. Clôture à date libre : périodes `]opened_at, closed_at]` contiguës, milieu de semaine et
   rétroactif ok ; antérieur à la dernière période figée → refus.
5. Solde main lu sur le message OkPay transféré (`Changed balance` de la dernière ligne
   ≤ `closed_at`), dédup `dedup_key UNIQUE` au schéma.

**Format OkPay réel** (confronté le 2026-09-13, fixture dans le harnais) : `Type: ➕|➖` (emoji
U+2795/U+2796, pas « + »/« − »), mentions `Transfer To :` / `Transfer From :` / `轉賬給 :`
mélangées dans un même message, **soldes à 6 décimales** (`1539.817733`). Le grand livre
garde les 6 décimales et la chaîne se vérifie au millionième ; l'arrondi au centime n'a lieu
qu'à la frontière ledger → solde de clôture (`balanceAt().pool_balance`), parce que le
moteur de règlement travaille au centime. Toute forme non vue (mention chinoise de
l'entrant, séparateur de milliers, Type ASCII…) est **refusée en nommant le bloc** : Baki
fournit l'échantillon, on l'ajoute — on ne devine pas.

**Horodatages** : un seul format, `YYYY-MM-DD HH:MM:SS`, heure murale OkPay, lus comme UTC
en interne (jamais l'heure locale du serveur — Railway ≠ Mac). Le fuseau réel d'OkPay reste
à confirmer sur un vrai message.

## Phases

- **1 — FAIT** : schéma + migration `add_pool_settlement_v1` + moteur pur + parseur OkPay
  + harnais `scripts/pool-engine.test.ts` (164 assertions, contrefactuels, fixture réelle). Audit
  money-auditor : NO-GO → corrections A1/A2/A3 → GO SOUS RÉSERVE (réserves ci-dessous).
- **2 — FAIT** : couche DB `lib/pool/periods.ts` (comptes soft-close, ingestion, mouvements,
  preview = lock, unlock, hook `markPaid`, refus nommé dans `unlockSettlement`, entrée
  `SETTLE_ROOMS` « AK MULTI » → `/ak-multi`) + harnais `scripts/pool-periods.test.ts`
  (141 assertions). Audits : NO-GO (A précision du jour, B unicité des wallets, C état prod
  du schéma) → NO-GO (A' jour UTC ≠ jour OkPay, B1 réouverture, B4 changement de main) →
  GO SOUS RÉSERVE (R1 une ligne agence ne date qu'un règlement — appliqué + index unique ;
  R4 veille tolérée — appliqué). Ces deux derniers correctifs sont postérieurs au dernier
  passage de l'auditeur : couverts par tests (section 8), pas ré-audités.
- **3 — FAIT** : handler bot `lib/pool/okpay-forward.ts` (branché dans le webhook AVANT
  funnels et sessions ; propriétaires et joueurs connus seulement ; réponse : wallet,
  propriétaire, lignes nouvelles/connues, dernier solde, état de la chaîne, règlements
  résolus), écran `/ak-multi` (`app/ak-multi/`, routes `app/api/ak-multi/*` fines,
  `now` serveur en heure murale via `lib/pool/clock.ts`), textarea de secours, entrée
  sidebar, hub `/payments` : date obligatoire (« entre dans le calcul ») pour AK multi.
  Vérifié en local sur base de test : preview 850,12 / −149,88 / −44,96, lock, markPaid
  depuis le hub → mouvement `in 44.96` à clôture + 1 s en précision jour, blocker ±1 jour
  à la clôture suivante, message réel ingéré via le webhook (5 lignes, wallet agence).
  Non vérifié : la réponse Telegram du bot (pas de token en local).
- **Archivage AKS** : phase séparée, APRÈS inventaire de ce qui reste ouvert (tx non
  réglées, règlements `locked`, soldes ≠ 0) — masquer, jamais supprimer ; désarchivage =
  `UPDATE games SET status='active'`, sans migration. Aucun report de solde AKS → pool.

## Cahier de la phase 3 (bot + écran) — à IMPOSER

Issu des trois passes d'audit de la phase 2 (2026-09-13) :

- **`paid_date` = la date affichée par OkPay sur la ligne agence**, pas la date du clic ni la
  date UTC. La fenêtre ±1 jour absorbe UN glissement (fuseau ou saisie), pas deux : une
  `paid_date` à 2 jours de la vraie ligne n'est jamais résolue et compte sans signal (R3).
  L'écran doit le dire à côté du champ, et afficher en rouge un règlement `day` jamais
  résolu alors qu'une ligne agence identique existe hors fenêtre.
- `markPaid` pool tolère `paid_date` = veille de la clôture (→ clôture + 1 s, `day`) et
  `todayUTC + 1` (OkPay peut être en avance) — fait en phase 2 (R4).
- `resolution_ambiguous` en rouge, avec proposition d'unlock si la période n'est pas payée ;
  `paid_before_close` en rouge : la période réglée est surévaluée, à traiter à la main.
- Refus B1 (« wallet maintenant … ») et B4 (« main portait X ») : afficher le chemin
  (détacher / vider vers la nouvelle / clôturer à 0).
- **R1-b** (4ᵉ passe) : un mouvement `declared` créé depuis une ligne agence (prêt, avance)
  devrait porter `okpay_line_id` pour que `NOT IN` l'exclue ; et `double_declared` doit se
  taire si le `declared` porte une ligne. Aujourd'hui : montants égaux + page partielle →
  le règlement peut se résoudre sur la ligne du prêt (±13,50 entre deux périodes, signalé
  par `resolution_ambiguous` + `double_declared` — ne PAS supprimer la déclaration).
- **R1-d** : à montants égaux, l'attribution des lignes entre deux règlements peut être
  échangée — neutre en argent, à savoir en lecture d'audit.
- Assertion nommée « `NOT IN` retiré → le hook jette UNIQUE » (le harnais meurt au lieu
  d'asserter).
- **Fuseau OkPay** : `lib/pool/clock.ts` suppose Europe/Paris (heure du téléphone) pour
  `now`. Le mismatch d'hydratation vu en local sur `/ak-multi` vient d'une extension
  navigateur (`bis_skin_checked`), pas de la page.

- `now` passé à `previewPoolPeriodOn` doit être en **heure murale OkPay** (même convention que
  `closed_at`) — pas `new Date()` serveur UTC. Fuseau OkPay à confirmer sur un message
  (comparer la `date` d'une ligne à l'heure de réception Telegram).
- L'écran ne pré-remplit **jamais** `pool_open` sur une première période, et n'expose pas
  `pool_open_manual` quand une période existe (il est ignoré côté serveur, testé).
- Compte clos à 0 qui **reçoit** de l'argent avant la clôture suivante : limite connue, non
  détectable sans sa page OkPay. Règle d'usage : supprimer un compte juste après une clôture
  à 0, jamais avant d'avoir cessé de l'alimenter.
- La page `/ak-multi` doit exister (le hub `/payments` y pointe déjà).

## Cahier de la phase 2 — réserves de l'audit (2026-09-13), état

Tous imposés dans `lib/pool/periods.ts` et testés (mutants tués, audit phase 2) : blocker
« règlement précédent `locked` », ceinture `occurred_at ≤ closed_at` figé, calendrier de
`closed_at`, contiguïté `opened_at = dernier closed_at` (+ index partiel
`UNIQUE(opened_at) WHERE opened_at != closed_at` — la 1ʳᵉ période a `opened_at = closed_at`),
compte d'un autre joueur → blocker, soft-close garde solde 0 et réouverture à l'unlock,
ambiguïté de la main → blocker, doublons / main avec `account_id` → blocker,
`pool_open_manual` ignoré sous carry, mouvement déclaré avant la 1ʳᵉ clôture → refus,
warnings `main_conflict` (main saisie ≠ grand livre) et `double_declared` (versement déclaré
en plus du règlement).
- `ON DELETE CASCADE` sur `players` : supprimer un joueur efface ses périodes figées —
  même risque assumé qu'en NEXA, à garder en tête.
- Format OkPay : un seul vrai message vu (wallet agence). Variantes à collecter au fil de
  l'eau (forme chinoise de l'entrant, dépôts sans contrepartie) — chaque refus « mention
  inconnue » est un échantillon à demander.

## Limites documentées (pas des bugs)

- Dédup : deux opérations réelles identiques à la même seconde encadrant une opération
  inverse (+100→200, −100→100, +100→200) partagent la clé ; la 3ᵉ est avalée, rupture
  irréparable par réémission. Symptôme : une rupture que le renvoi de la page ne referme
  pas. (`schema.ts`, B8.)
- Tri intra-seconde : une ligne manquante absorbée par une paire compensante peut donner
  un ordre cohérent « par accident » ; rattrapé par la ligne suivante s'il y en a une.
  (`engine.ts` `sortLedgerDetailed`, B2.) Groupes > 6 lignes à la même seconde : repli id.
