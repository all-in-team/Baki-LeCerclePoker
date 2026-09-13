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

`paid_date` est un JOUR, les bornes sont à la SECONDE : `settlementOccurredAt` date le
mouvement `max(paid_date 00:00:00, closed_at réglé + 1 s)`, refuse un paiement antérieur
à la clôture. **Règle d'exploitation indispensable** (héritée de NEXA) : on ne clôture pas
une période tant que le règlement de la précédente est `locked`.

## Cas limites (décidés)

1. Supprimer un compte = soft-close (`closed_at`), refusé si ses derniers soldes figés ≠ 0.
2. Compte ajouté : `pool_open` = `pool_close` précédent, indépendant de la liste → neutre.
3. Argent en vol : `observed_at` par solde, alerte si écart > 30 min (avertissement +
   confirmation, pas blocker). OkPay ≠ 0 → signal (transit resté en route).
4. Clôture à date libre : périodes `]opened_at, closed_at]` contiguës, milieu de semaine et
   rétroactif ok ; antérieur à la dernière période figée → refus.
5. Solde main lu sur le message OkPay transféré (`Changed balance` de la dernière ligne
   ≤ `closed_at`), dédup `dedup_key UNIQUE` au schéma.

**Horodatages** : un seul format, `YYYY-MM-DD HH:MM:SS`, heure murale OkPay, lus comme UTC
en interne (jamais l'heure locale du serveur — Railway ≠ Mac). Le fuseau réel d'OkPay reste
à confirmer sur un vrai message.

## Phases

- **1 — FAIT** : schéma + migration `add_pool_settlement_v1` + moteur pur + parseur OkPay
  + harnais `scripts/pool-engine.test.ts` (156 assertions, contrefactuels). Audit
  money-auditor : NO-GO → corrections A1/A2/A3 → GO SOUS RÉSERVE (réserves ci-dessous).
- **2 — couche DB** `lib/pool/periods.ts` : comptes, preview = lock (même fonction, rien
  persisté avant le clic), unlock (dernière période seulement, jamais si payée), hook
  `markPaid` → mouvement `settlement`, refus nommé dans `unlockSettlement`, entrée
  `SETTLE_ROOMS`.
- **3 — handler bot** (message OkPay transféré, v1) + écran `app/ak-multi/pool/…` +
  textarea de secours. Captures réelles avant commit.
- **Archivage AKS** : phase séparée, APRÈS inventaire de ce qui reste ouvert (tx non
  réglées, règlements `locked`, soldes ≠ 0) — masquer, jamais supprimer ; désarchivage =
  `UPDATE games SET status='active'`, sans migration. Aucun report de solde AKS → pool.

## Cahier de la phase 2 — réserves de l'audit (2026-09-13) à IMPOSER

- **Blocker** : refuser la clôture si un règlement pool du joueur est `locked` (règle
  d'exploitation ci-dessus). **Ceinture** : refuser tout mouvement `settlement` dont
  `occurred_at ≤ closed_at` d'une période figée du joueur.
- Valider `closed_at` au **calendrier** (`isPoolTimestamp`), pas seulement au format.
- Contiguïté : `opened_at` = `closed_at` de la dernière période (le schéma n'impose que
  `UNIQUE(opened_at)` et `UNIQUE(closed_at)`).
- Cohérence croisée à l'écriture : soldes d'un compte du joueur B dans la période du
  joueur A, période du joueur 1 sur un règlement du joueur 2, montant/sens du mouvement
  `settlement` = `settlementMovementFor(action_amount)` de la période réglée.
- Soft-close : garde « derniers soldes figés = 0 » ; `closed_at` ⇒ `closed_in_period_id`.
- `balanceAt(...).ambiguity` non nul → la main n'est pas déterminable : demander la page
  suivante, ne pas figer ce solde.
- `pool_period_balances` : preview doit refuser deux AK du même compte et une main avec
  `account_id` (subsumé par le schéma à l'INSERT, pas sur le chemin preview).
- `ON DELETE CASCADE` sur `players` : supprimer un joueur efface ses périodes figées —
  même risque assumé qu'en NEXA, à garder en tête.
- Format réel OkPay : confronter le parseur à un vrai message AVANT mise en service
  (si le vrai format porte un `Transaction: <id>` par bloc, tout est refusé — sûr, mais
  inutilisable).

## Limites documentées (pas des bugs)

- Dédup : deux opérations réelles identiques à la même seconde encadrant une opération
  inverse (+100→200, −100→100, +100→200) partagent la clé ; la 3ᵉ est avalée, rupture
  irréparable par réémission. Symptôme : une rupture que le renvoi de la page ne referme
  pas. (`schema.ts`, B8.)
- Tri intra-seconde : une ligne manquante absorbée par une paire compensante peut donner
  un ordre cohérent « par accident » ; rattrapé par la ligne suivante s'il y en a une.
  (`engine.ts` `sortLedgerDetailed`, B2.) Groupes > 6 lignes à la même seconde : repli id.
