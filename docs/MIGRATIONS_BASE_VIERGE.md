# `initSchema()` sur base vierge — cassé (constat du 2026-08-04)

> **Portée : nulle en production.** La base de prod existe depuis longtemps, ses
> 93 migrations sont passées, les colonnes concernées sont là. Rien à corriger en urgence.
>
> **Mordant à la première recréation d'instance** : staging, restauration de sauvegarde,
> nouvel environnement, base de dev locale repartie de zéro. Dans ces cas-là, la base
> obtenue est **incomplète et silencieusement figée dans cet état** — voir §3.

Constaté en voulant vérifier qu'une nouvelle migration (`add_nexa_affiliate_v1`) passait
bien dans la séquence réelle. Le test n'a jamais pu aller au bout, pour des raisons
antérieures et sans rapport avec elle. Reproduit à l'identique sur `git show HEAD:lib/db.ts`,
donc présent bien avant ce chantier.

**Aucun correctif n'a été appliqué.** Ce document est un constat, à traiter comme un
chantier à part entière : il touche `games`, une table centrale.

---

## 1. Premier boot — clé étrangère en dur, `lib/db.ts:589`

Migration `shared_cashout_wallets_v1` :

```ts
db.exec(`INSERT OR IGNORE INTO player_wallet_cashouts (player_id, address)
         VALUES (2, 'TNBf7UHvahKbodkH8PEtwFoQk6xMLSAvNd')`);
```

```
→ FOREIGN KEY constraint failed
```

`player_id = 2` est écrit en dur. Sur une base vierge, aucun joueur n'existe encore.
`INSERT OR IGNORE` ne couvre **pas** les violations de clé étrangère — il n'absorbe que
les conflits `UNIQUE` / `CHECK` / `NOT NULL`. Le premier boot s'arrête donc là.

## 2. Second boot — `BEGIN` sans `COMMIT`, cascade, `lib/db.ts:1045`

Le boot 1 ayant posé les marqueurs des migrations traversées (§3), le boot 2 repart plus
loin et bute sur `add_a5poker_game_v1` :

```
[MIGRATION:add_a5poker_game_v1] FAILED: no such column: default_action_pct
```

C'est précisément la migration censée **ajouter** `default_action_pct` à `games`. Son SQL
ouvre par `BEGIN;` et meurt avant le `COMMIT` : **la transaction reste ouverte**. Tout ce
qui suit et qui ouvre une transaction tombe en chaîne :

```
add_aapkmy_game_v1        FAILED: cannot start a transaction within a transaction
fix_player_game_ids_fk_v1 FAILED: cannot start a transaction within a transaction
drop_games_name_check_v1  FAILED: cannot start a transaction within a transaction
add_aks_game_v1     FAILED: table games has no column named default_action_pct
add_qqpk_game_v1    FAILED: table games has no column named default_action_pct
add_nutspk_game_v1  FAILED: table games has no column named default_action_pct
add_okpoker_game_v1 FAILED: table games has no column named default_action_pct
add_jvip_game_v1    FAILED: table games has no column named default_action_pct
add_ttpoker_game_v1 FAILED: table games has no column named default_action_pct
add_wn_game_v1      FAILED: table games has no column named default_action_pct
```

Une base ainsi créée n'a **aucune des rooms** en table `games`.

## 3. Le vrai amplificateur — marqueur écrit AVANT l'exécution

Le motif employé par les 93 migrations du fichier :

```ts
const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("nom_v1");
if (fix.changes > 0) {
  db.exec(`...`);          // ← si ça jette, le marqueur est DÉJÀ posé
}
```

Le marqueur est posé **avant** que le travail ne soit tenté. Si `db.exec` échoue :

- la migration est enregistrée comme appliquée,
- le boot suivant la saute (`fix.changes === 0`),
- **elle ne se rejouera jamais**,
- et l'erreur n'apparaît que dans un `console.error` d'un log de démarrage.

Autrement dit : chacun des dix échecs du §2 est **définitif**. La base reste durablement
incomplète, sans que rien ne le signale ensuite.

Observé en conditions réelles : `add_nexa_affiliate_v1` s'est retrouvée en position
**94/94** de `_applied_fixes` avec **zéro table créée**.

### Ce qui a été fait à ce sujet

`add_nexa_affiliate_v1` (commit `1b5250d`) est la **seule** migration à inverser l'ordre —
marqueur écrit après le succès du `db.exec`. Dérogation délibérée, documentée sur place.
Contrepartie assumée : son corps doit être rejouable, ce qui est vérifié par un test
d'injection de panne (application partielle → aucun marqueur → rejeu complet au boot
suivant).

**Les 93 autres n'ont pas été touchées.**

### ⚠️ `add_group_single_door_v1` a exactement la même exposition

Ajoutée le **2026-08-04** par le chantier « porte unique de création de groupe »
(incident Alexis), elle utilise le motif marqueur-avant-exec :

```ts
const fix = db.prepare(`INSERT OR IGNORE INTO _applied_fixes (name) VALUES (?)`).run("add_group_single_door_v1");
if (fix.changes > 0) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS group_claims (...);
    CREATE TABLE IF NOT EXISTS group_review_cases (...);
    CREATE TABLE IF NOT EXISTS group_room_notices (...);
  `);
}
```

Si ce `db.exec` échoue pour une raison quelconque, `group_claims` — **le verrou anti-double
création de groupe**, la raison d'être du chantier — n'existe pas, et la migration ne se
rejouera jamais. C'est le mode de panne le plus coûteux du lot : le garde-fou est absent
alors que tout le code en amont le suppose présent.

Le correctif est d'une ligne : déplacer l'`INSERT INTO _applied_fixes` après le `db.exec`,
comme dans `add_nexa_affiliate_v1`.

---

## Reproduire

```bash
# base vierge, séquence réelle — boucler car chaque boot avance d'un cran
BASE=$(mktemp -d); mkdir -p "$BASE/data"
# charger lib/db.ts (jiti) avec process.cwd() = $BASE, puis appeler getDb()
# boot 1 → FOREIGN KEY constraint failed  (db.ts:589)
# boot 2 → cascade du §2, puis la séquence "termine" avec une base incomplète
```

Le `cwd` doit être déplacé **avant** de charger `lib/db.ts` : `DATA_DIR` est calculé au
chargement du module (`path.join(process.cwd(), "data")`), sinon la base du repo est visée.

## Pistes, non tranchées

1. **§1** — remplacer le `player_id = 2` en dur par une résolution par identité
   (`SELECT id FROM players WHERE ...`), et ne rien insérer si absent.
2. **§2** — comprendre pourquoi `add_a5poker_game_v1` ne voit pas `default_action_pct`,
   et remplacer les `BEGIN;`/`COMMIT;` écrits à la main dans `db.exec` par
   `db.transaction()` de better-sqlite3, qui garantit le `ROLLBACK` en cas d'exception.
   Sans ça, une migration qui échoue continuera d'empoisonner toutes les suivantes.
3. **§3** — généraliser l'ordre marqueur-après-exec. Suppose de vérifier la rejouabilité
   de chaque corps au cas par cas : à ne pas faire en bloc.

Le point 2 est le plus rentable : il supprime la cascade, donc neuf échecs sur dix.
