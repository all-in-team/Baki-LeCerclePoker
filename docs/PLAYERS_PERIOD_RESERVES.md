# Réserves ouvertes — sélecteur de période de la page Joueurs

Issues de la revue adverse + `money-auditor` de la branche `feat/players-period-lifetime`
(money-auditor : **PASS** ; revue de correction : **NO-GO** sur `cb1bbb6`, corrigé par `c429a21`).

La page `/players` expose désormais 4 bornes — 7 jours / 30 jours / Lifetime / Custom — sur la
colonne « Agency cut ». Aucun montant n'est calculé par du code nouveau : la période change, les
fonctions de `lib/queries.ts` sont inchangées. Les réserves ci-dessous ne sont donc pas des
régressions ; ce sont des limites que la fenêtre de 30 jours masquait et que Lifetime met à l'écran.

---

## 🔴 LIFETIME = INDICATIF. NE PAS UTILISER POUR UN RÈGLEMENT.

**Le chiffre Lifetime est retarifé aux conditions de deal d'AUJOURD'HUI.** Il ne représente pas ce
qui a réellement été gagné, et ne doit servir qu'à comparer des joueurs entre eux ou à repérer un
ordre de grandeur. Pour tout règlement, la source reste `weekly_settlements`.

Trois raisons cumulatives, aucune corrigée :

### 1. Pas d'historique de deal — le passé est recalculé au taux courant
`player_game_deals` est `UNIQUE(player_id, game_id)` : une seule ligne par couple joueur/game,
aucune historisation. `my_pnl = net * pgd.action_pct / 100` applique donc l'`action_pct` **actuel**
à toute la fenêtre.

> Joueur X sur TELE. 2024 : net (retraits − dépôts) = +20 000 USDT sous un deal à 50 % → 10 000
> réellement gagnés. 2025-26 après renégociation à 30 % : net = +10 000 → 3 000 gagnés.
> Vrai lifetime = **13 000 USDT**. La page affiche `(20 000 + 10 000) × 30 %` = **9 000 USDT**,
> soit 31 % sous-évalué.

Même mécanisme côté reports avec `rakeback_pct` / `insurance_pct` (`lib/queries.ts:1708-1710`).
La colonne 30 jours n'est pas concernée : la fenêtre récente tient entière dans le deal courant.

### 2. CNY converti au taux du jour sur tout l'historique
`getCnyRate()` lit une unique ligne `settings.exchange_rate_cny_usdt`. Il n'existe aucune table de
taux historiques. Chaque report CNY jamais déposé est multiplié par le taux d'aujourd'hui.

Silencieux et plus grave : si `exchange_rate_cny_usdt` n'est pas renseigné, `convertCnyToUsdt`
renvoie `0` (`lib/currency.ts:5`) et **des années de contribution Wepoker disparaissent de la
colonne sans aucun signal dans l'UI**. `getVolumeByGame` a un flag `missing_rate` pour exactement
ce cas ; `getWepokerPnL` n'en a pas.

### 3. « Lifetime » n'est pas sans borne partout
- La part grindhouse est plafonnée à `[2020-01-01, aujourd'hui]` : `getGrinderProfitability`
  (`lib/queries.ts:1896-1897`) substitue ces valeurs quand la période est vide, alors que les
  legs wallet et Wepoker sont réellement sans borne. Mesuré par la revue adverse sur données
  seedées : 740 affichés contre 1 340 réels.
- Les mouvements antérieurs à `pgd.start_date` sont exclus à **toutes** les périodes
  (`getWalletSummaryByPlayer:639-640`). Lifetime = « depuis le début de chaque deal », pas
  « depuis le premier mouvement ». Le libellé de l'UI le dit désormais.

---

## ⚠️ Custom = journées **UTC**, pas journées Paris

Décision assumée pour ce merge (Baki, 2026-08-13) : on reste en UTC, l'UI l'annonce.

Le sélecteur custom propose des heures ; elles sont **ignorées**, la fenêtre est arrondie à la
journée. Et ces journées sont des journées UTC : `periodToDateRange` (`lib/queries.ts:1556`) envoie
`from + "T00:00:00Z"` et `to + "T23:59:59Z"`, comparés à `tx_datetime` stocké en UTC. En été, « du 1er au 5 août » couvre donc 01/08 02:00 → 06/08 01:59
heure de Paris. **Un cashout de 00:30 tombe dans le mauvais jour.**

Le passage en journées Paris est un chantier séparé, avec son propre audit : il impose de toucher
`periodToDateRange` (`lib/queries.ts:1554-1557`), chemin money. Vérifié au passage : aucun appelant
existant ne passe un `Period` déjà horodaté, donc un pass-through des valeurs contenant `T` serait
additif — mais les legs Wepoker (`report_date`) et grindhouse (`session_date`) comparent des dates
nues et devront être traités dans le même mouvement.

---

## ⚠️ La colonne du tableau et les totaux Kanban/drawer ne couvrent pas les mêmes games

Préexistant, mais les deux portent désormais le **même tampon de période**, ce qui se lit comme une
promesse qu'ils mesurent la même chose.

- Colonne « Agency cut » (`getTopContributors`) : TELE, KKPOKER, A5POKER, AKS, NUTSPK, Wepoker
  (via les **reports**, en CNY) et grindhouse.
- Kanban + drawer (`getWalletSummaryByPlayer` sans filtre de game) : **les 14 games** de
  `player_game_deals`, via les **wallets** uniquement.

Conséquence : Xpoker, ClubGG, AAPKMY, QQPK, OKPOKER, JVIP, TTPOKER, WN et NEXAPOKER produisent des
lignes de drawer qui contribuent **zéro** à la colonne. Inversement grindhouse et le rakeback
Wepoker sont dans la colonne et dans aucune ligne de drawer. Pour Wepoker, ce sont deux nombres
structurellement différents pour le même game (reports CNY vs wallets USDT).

---

## ✅ Levée le 2026-08-13 — devises dans `wallet_transactions`

`getWalletSummaryByPlayer` (`lib/queries.ts:653-656`) somme `wt.amount` **brut**, sans `toUsdt()`.
En pratique tous les écrivains épinglent USDT, sauf `app/api/wallets/route.ts:17`
(`body.currency || "USDT"`). Le money-auditor conditionne son PASS à cette vérification :

```sql
-- Attendu : UNE seule ligne, currency = 'USDT'.
-- Tout autre résultat ⇒ la colonne Lifetime somme des devises à 1:1 (invariant #3 violé).
SELECT currency, COUNT(*) AS n, MIN(tx_datetime) AS plus_ancien
FROM wallet_transactions
GROUP BY currency;
```

**Exécuté en prod le 2026-08-13 par Baki :**

```json
{"ok":true,"rows":[{"currency":"USDT","n":2363}]}
```

Une seule devise, 2 363 lignes. L'invariant #3 n'est pas menacé sur le chemin wallet, y compris en
Lifetime. À ré-exécuter si une intégration se met un jour à écrire une autre devise — le seul point
d'entrée qui le permettrait est `app/api/wallets/route.ts:17`.

---

## Perf — vérifié, rien à faire

`wallet_transactions` n'a **aucun index sur `tx_datetime`** (`lib/db.ts:1689-1691` : seulement
`idx_wallet_tron_hash`, `idx_wallet_tx_unsettled(game_id, player_id, settled)`,
`idx_wallet_tx_settlement`). `EXPLAIN QUERY PLAN` rend des plans **identiques** en 30 jours et en
lifetime : la jointure est pilotée par `(game_id, player_id)` et la borne de date n'est qu'un filtre
résiduel appliqué à des lignes déjà lues. Le 30 jours lisait donc déjà tout et jetait ; lifetime lit
les mêmes pages et en garde davantage.

**Ni cache ni index nouveau ne sont justifiés par ce changement.** Ordre de grandeur mesuré en prod
le 2026-08-13 : **2 363 lignes** dans `wallet_transactions`, tout l'historique confondu — trois
ordres de grandeur sous le seuil où la question se poserait.

Point de vigilance non lié à la période — le bloc grindhouse de `getTopContributors`
(`lib/queries.ts:2343-2351`) émet 3 requêtes par grinder, et l'échec est avalé sur **deux** niveaux :
`getGrinderProfitability` a son propre `try/catch` qui renvoie `empty` (`lib/queries.ts:1892`,
`1921-1923`), donc un grinder en erreur compte 0 et la boucle continue ; le `catch` externe ne se
déclenche que sur le `SELECT` des grinders ou l'accumulation. Dans les deux cas, une page d'argent
affiche 0 au lieu d'échouer bruyamment. Ces `catch` devraient être restreints au cas
« table absente ».
