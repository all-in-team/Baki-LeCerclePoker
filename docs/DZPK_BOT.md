# Bot d'acquisition dzpk

Bot Telegram **dédié**, en chinois, destination de toutes les pubs dzpk. Il
capture l'identité du lead au `/start`, pousse le lien du club @dzpk, et sert de
base au suivi du funnel `start → join → rattaché`.

**Il est entièrement séparé du bot principal et du funnel NEXA** : token
distinct, webhook distinct, tables distinctes. Aucun code NEXA ne le lit, il ne
lit aucune table NEXA. Cette séparation est structurelle, pas conventionnelle —
elle tient au fait que les deux bots ont des tokens différents, donc des URL de
webhook différentes.

---

## 1. Variables d'environnement

**Nécessaires dès la phase 1** — sans elles le bot ne fonctionne pas :

| Variable | Rôle | Sans elle |
|---|---|---|
| `DZPK_BOT_TOKEN` | Token BotFather du bot dzpk | Le bot est **muet**, erreur loggée une fois |
| `DZPK_CLUB_INVITE_URL` | Lien d'affiliation du club @dzpk | Accueil envoyé **sans bouton** (jamais de silence) |
| `DZPK_WEBHOOK_SECRET` | Authentifie les appels de Telegram | Webhook **non authentifié**, avertissement au setup |

**Phases suivantes** :

| Variable | Rôle | Phase |
|---|---|---|
| `DZPK_AGENT_NAME` | Identifiant agent dans le club (`🍓`) | 2 |
| `DZPK_CLUB_LABEL` | Libellé du club (`德州扑克 ♠️❤️ @dzpk`) | 2 |
| `DZPK_CLUB_BOT` | @username du bot du club qui envoie les notifs en DM | 2 |
| `DZPK_USERBOT_SESSION` | Session GramJS du compte qui reçoit les DM du club | 2 |
| `DZPK_INGEST_BATCH` | Taille du lot d'ingestion (défaut 100, borné 1–200) | 2, optionnel |
| `DZPK_ADMIN_CHAT_ID` | Supergroupe « Support DZPK » (Sujets activés) | 3 |
| `PROPELLER_POSTBACK_URL` | Postback de conversion PropellerAds, avec `{CB}` | 5 |
| `RICHADS_POSTBACK_URL` | Postback de conversion RichAds, avec `{CB}` | 5 |

Les deux dernières sont **sans repli l'une sur l'autre** : une source `tgads-`
ne poste que sur Propeller. Absente ⇒ la conversion n'est pas remontée et
`[DZPK POSTBACK]` le dit en erreur (cf. § 7 ter).

### ⚠️ La session dzpk est une SECONDE session, sur un autre compte

| Session | Compte | Sert à |
|---|---|---|
| `TELEGRAM_SESSION` | `@Baki77777` | création et gestion des groupes joueurs |
| `DZPK_USERBOT_SESSION` | `@strawberry5421` | **lecture des DM du club** (🍓 = strawberry) |

Deux comptes Telegram distincts, donc deux sessions. `TELEGRAM_API_ID` et
`TELEGRAM_API_HASH` sont ceux de l'application et se partagent — seule la session
diffère.

**Aucun repli de `DZPK_USERBOT_SESSION` sur `TELEGRAM_SESSION`.** Session absente ⇒
l'ingestion refuse de tourner et le dit. Un repli silencieux ferait lire le mauvais
compte en croyant lire le bon, ce qui est exactement le bug ci-dessous.

> **Constat du 2026-08-12, à ne pas refaire.** L'ingestion a tourné une heure avec la
> session de `@Baki77777` : peer résolu, aucune erreur, curseur qui avance, alarme de
> fraîcheur au silence — et `fetched: 0` à chaque passe, parce que les DM du club
> arrivent sur `@strawberry5421`. Une session valide sur le mauvais compte est
> **indistinguable d'une conversation vide**. C'est pourquoi le diagnostic expose
> désormais le compte réellement lu.

```bash
curl .../api/admin/dzpk-ingest -H "x-admin-token: $ADMIN_RECONCILE_TOKEN"
# → "reading_as": {"username":"strawberry5421","user_id":…,"connected":true}
```

Si `reading_as.username` n'est pas le compte qui reçoit les notifications, rien
d'autre n'a d'importance : c'est la première chose à regarder.

### Générer `DZPK_USERBOT_SESSION`

Deux étapes, depuis la racine du dépôt, avec le numéro du compte **strawberry** :

```bash
# 1. Demander le code (arrive dans Telegram sur @strawberry5421)
TELEGRAM_API_ID=… TELEGRAM_API_HASH=… PHONE='+33…' npx tsx scripts/send-code.ts

# 2. Fichier de mot de passe 2FA — OBLIGATOIRE même sans 2FA (le script le lit
#    inconditionnellement). Vide si le compte n'a pas de mot de passe.
echo 'MON_MOT_DE_PASSE_2FA' > /tmp/tg-2fa-password.txt

# 3. Valider avec le code reçu → imprime SESSION=1Bx...
TELEGRAM_API_ID=… TELEGRAM_API_HASH=… PHONE='+33…' CODE='12345' npx tsx scripts/verify-code.ts

# 4. Poser la valeur sur Railway, puis effacer le fichier de mot de passe
rm -f /tmp/tg-2fa-password.txt /tmp/tg-auth-state.json
```

⚠️ Poser la chaîne dans **`DZPK_USERBOT_SESSION`**, surtout pas dans
`TELEGRAM_SESSION` — l'écraser repointerait la gestion des groupes joueurs sur un
compte qui ne les a pas créés.

> **Emoji.** `🍓` et `♠️❤️` se comparent sur une forme normalisée (sélecteurs de
> variante U+FE0F retirés). Un même emoji arrive avec ou sans VS selon le client
> émetteur : une comparaison brute échouerait un jour sur deux, en silence, et
> ferait tomber tout le filtre agent. Coller la valeur telle quelle suffit.

Aucune de ces variables ne se replie sur une variable NEXA. Un repli ferait
atterrir des leads dzpk dans le chat NEXA, ce qui est pire que l'absence de
fonctionnalité.

---

## 2. Ajouter une source de trafic

**Rien à faire.** La source **est** le start param, et il n'existe aucune liste
blanche : une source jamais vue est valide dès le premier clic.

```
https://t.me/<bot>?start=tgads
https://t.me/<bot>?start=tgads_cn_video3
https://t.me/<bot>?start=n_importe_quoi
https://t.me/<bot>                          → source « organic »
```

Ce qui se passe à la réception :

- casse pliée (`TgAds` et `tgads` = un seul canal) ;
- caractères de contrôle retirés, longueur bornée à 64 ;
- payload brut conservé à part dans `source_raw` ;
- vide ou absent ⇒ `organic` — une **vraie** source, pas une donnée manquante,
  pour que le trafic organique ait son propre taux de conversion.

### La source est FIRST-TOUCH

Un lead qui refait `/start` depuis une autre pub **ne change pas de source**.
Le second contact incrémente `start_count` et laisse une trace dans
`dzpk_lead_events` (avec la source observée), mais l'attribution reste à la pub
qui a payé le premier contact.

---

## 3. Mettre le bot en service

```bash
# 1. Poser les variables sur Railway (DZPK_BOT_TOKEN, DZPK_CLUB_INVITE_URL, DZPK_WEBHOOK_SECRET)

# 2. Enregistrer le webhook
curl -X POST https://lecerclepoker-production.up.railway.app/api/telegram/dzpk/setup \
  -H "x-admin-token: $ADMIN_RECONCILE_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl":"https://lecerclepoker-production.up.railway.app/api/telegram/dzpk/webhook"}'

# 3. Vérifier (identité du bot + état du webhook + variables posées)
curl https://lecerclepoker-production.up.railway.app/api/telegram/dzpk/setup \
  -H "x-admin-token: $ADMIN_RECONCILE_TOKEN"
```

Le setup demande **`allowed_updates: ["message"]` uniquement**. Ni
`chat_member`, ni `callback_query` : la détection du join ne passe pas par les
événements d'appartenance mais par les notifs du club (phase 2), et demander des
updates qu'on ne traite pas remplit la file Telegram pour rien.

`drop_pending_updates: true` est posé : sans ça, un webhook réenregistré
rejouerait d'un coup une file d'updates périmés, donc des messages d'accueil
envoyés à contretemps.

---

## 4. Ce que fait le bot aujourd'hui (phase 1)

| Événement | Effet |
|---|---|
| `/start <source>` | Crée ou retrouve le lead, envoie l'accueil chinois + bouton club |
| `/start` (nu) | Idem, source `organic` |
| re-`/start` | Aucun doublon ; identité rafraîchie, source conservée, événement loggé |
| Message libre du lead | **Enregistré (texte inclus), pas de réponse** — le relais humain arrive en phase 3 |
| Autre commande | Journalisée, ignorée en silence |
| Message d'un inconnu | Tracé dans les logs, **aucun lead créé** (un lead sans `/start` n'a pas de source) |
| Message hors conversation privée | Ignoré, aucun effet de bord |

Les messages reçus avant la phase 3 ne sont pas perdus : leur texte est stocké
dans `dzpk_lead_events`.

---

## 5. Données

| Table | Rôle |
|---|---|
| `dzpk_leads` | Un lead = un `telegram_id`. Source first-touch + horodatages de faits |
| `dzpk_lead_events` | Journal append-only, avec l'**identité observée à chaque contact** |
| `dzpk_updates` | Dédoublonnage des updates rejoués par Telegram |

Deux partis pris à connaître avant de toucher au schéma :

**Pas de colonne `state`.** Les états ne sont pas ordonnés — un lead peut
répondre sans avoir rejoint, ou être rattaché sans avoir jamais écrit. On stocke
des horodatages de faits (`club_joined_at`, `bound_at`, `first_reply_at`…) et
`deriveState()` calcule l'affichage. Une colonne unique imposerait un ordre faux
et tout taux de conversion calculé dessus serait faux avec lui.

**L'identité est recopiée sur chaque événement.** C'est redondant et voulu : le
club ne renvoie qu'un nom libre, et un lead qui renomme son compte Telegram
entre son `/start` et sa première partie ne serait plus appariable si seule la
dernière identité subsistait.

**`dzpk_updates` duplique `telegram_updates` volontairement** : deux bots ont des
séquences d'`update_id` indépendantes. Partager la table ferait passer un
`/start` dzpk pour un doublon parce que le bot principal a déjà vu ce numéro.

**`click_id` suit exactement la règle de `source`** — écrit à la création, jamais
réécrit. `postback_sent_at` est un **verrou**, pas un accusé de réception : il
est posé avant l'appel réseau, et `postback_result` dit seul si l'envoi a abouti
(cf. § 7 ter).

---

## 6. Tests

```bash
npx tsx scripts/dzpk-leads.test.ts      # /start, first-touch, idempotence
npx tsx scripts/dzpk-go-bridge.test.ts  # clic pub → start param
npx tsx scripts/dzpk-matcher.test.ts    # appariement nom-de-club ↔ lead
npx tsx scripts/dzpk-postback.test.ts   # postbacks de conversion (§ 7 ter)
```

Base SQLite en mémoire, alimentée par `DZPK_SCHEMA_SQL` — **la chaîne SQL de la
migration elle-même**, pas une recopie. Les trois propriétés invisibles
(first-touch, idempotence, historique d'identité) sont vérifiées par
contrefactuel : le bug est remis, et le test doit tomber.

---

## 7. Phase 2 — ingestion, parsing, appariement

### Le modèle de revenu

Le revenu se scelle au **premier jeu**, pas au join. Le club envoie quatre types de
notification en DM au compte de Baki, et **un bot ne peut pas lire les DM d'un autre
bot** : la lecture passe par le userbot GramJS.

| Gabarit | Marqueur | Effet | Agent nommé ? |
|---|---|---|---|
| join | `已进群` | `club_joined_at` | **non** |
| rattaché | `已绑定为代理` | `bound_at` — **le revenu** | oui |
| commission | `申请的分佣` | ligne `dzpk_commissions` | oui |
| banni | `已被封号/冻结` | `banned_at` | oui |

Le gabarit *join* ne porte aucun nom d'agent : son appartenance est **présumée** du
canal (DM privé), pas prouvée. Le risque est borné par construction — seul le
gabarit *rattaché* crédite du revenu, et lui porte le filtre.

### Ingestion : pull, jamais listener

`messages.getHistory` sur **un seul peer** (`DZPK_CLUB_BOT`), depuis un curseur.

- **`reverse: true` est obligatoire.** GramJS rend par défaut du plus récent au plus
  ancien : avec `limit: 100` et un curseur à zéro, on n'aurait ingéré que les 100
  derniers messages avant de faire sauter le curseur au maximum — enterrant tout
  l'historique sous `minId`, en silence.
- **Confidentialité par la portée**, pas par un filtre : aucune autre conversation
  n'est jamais demandée.
- **Non-perte** : le curseur n'avance qu'après écriture, et ne recule jamais
  (`MAX(last_msg_id, ?)`).
- **Dédup** par `UNIQUE(peer, src_msg_id)`, jamais par contenu : deux commissions du
  même montant sont deux paiements.

### Parsing : strict, et bruyant quand il échoue

Le nom du joueur est extrait en **ancrant sur le libellé du club**, pas sur le mot
suivant : `从` est un caractère courant qui peut appartenir à un nom (`从容`).

Un montant ne se devine jamais. Toute virgule est refusée — `811,628` vaut 811628 ou
811.628 selon la convention, un facteur 1000 que rien dans la chaîne ne tranche. Un
refus tombe en `unparsed`, donc **visible** ; un montant deviné se comptabilise.

Toute notification non reconnue est stockée en `unparsed` **avec son motif**, comptée
à l'écran, et **notifiée** — un gabarit qui change doit se voir en heures.

### Appariement

Le club reprend **automatiquement le nom du compte Telegram** du joueur : le nom des
notifs est donc le `display_name` capturé au `/start`, d'où une colonne dédiée et
indexée sur `dzpk_leads`.

1. **Lien mémorisé** (`dzpk_name_links`) → auto. L'identité la plus forte : un humain
   l'a validée.
2. **Égalité exacte normalisée** sur un lead unique → auto, et le lien est appris.
3. **Homonymes** → filtre de causalité (`started_at <= posted_at` : on ne peut pas
   être rattaché avant d'avoir parlé au bot), puis proximité de date **avec une marge
   de 24 h**. En-deçà, la date ne tranche rien et l'humain décide.
4. **Renommage entre `/start` et join** → aucun auto, réconciliation.

Aucun rapprochement approximatif : ni distance d'édition, ni sous-chaîne, ni prénom
seul. Un rattachement faux ne change pas le revenu total — il **déplace le crédit
d'une source de pub vers une autre**, sans qu'aucun total ne cloche.

Un lien appris dont la clé devient ambiguë (un second lead du même nom apparaît) est
marqué `contested` et cesse de servir : son unicité d'hier était un accident du volume.

### Commissions

`dzpk_commissions` est **isolée de la comptabilité** : elle n'alimente ni
`wallet_transactions`, ni les P&L, ni les settlements. Le rapprochement avec les USDT
réellement reçus est une tâche séparée, à décider explicitement.

Une commission n'est enregistrée **que si l'agent est le nôtre**. Celles des autres
agents restent lisibles dans `dzpk_club_messages` pour la traçabilité.

Les deux montants sont stockés en REAL **et** en brut ; l'écart d'arrondi n'est jamais
stocké, il se calcule à la lecture.

### Piloter

```bash
# État : curseur, fraîcheur, compteurs, unparsed, file de réconciliation,
# et le taux d'auto-appariement qu'on OBTIENDRAIT (dry run, aucune écriture)
curl .../api/admin/dzpk-ingest -H "x-admin-token: $ADMIN_RECONCILE_TOKEN"

# Passe d'ingestion immédiate
curl -X POST .../api/admin/dzpk-ingest -H "x-admin-token: $T" \
  -H 'Content-Type: application/json' -d '{"action":"ingest"}'

# Appliquer les appariements (ajouter "dry_run":true pour seulement mesurer)
curl -X POST .../api/admin/dzpk-ingest -H "x-admin-token: $T" \
  -H 'Content-Type: application/json' -d '{"action":"match"}'

# Rattacher à la main — le lien est mémorisé pour les fois suivantes
curl -X POST .../api/admin/dzpk-ingest -H "x-admin-token: $T" \
  -H 'Content-Type: application/json' \
  -d '{"action":"resolve","club_message_id":42,"lead_id":7,"operator":"baki"}'
```

`match` n'est **pas** enchaîné après `ingest` : tant que le taux réel n'est pas
mesuré, appliquer les effets reste un geste délibéré.

### Alarmes

| Situation | Signal |
|---|---|
| Aucune ingestion réussie depuis 6 h | notification ops (cron horaire) |
| Notifications non reconnues dans une passe | notification ops |
| Des commissions passent, **aucune** n'est retenue | notification ops — signature d'un `DZPK_AGENT_NAME` désaccordé |

Une session userbot morte ne produit **aucun** symptôme : elle ressemble à une journée
sans nouveau joueur. C'est la raison d'être de la première alarme.

### Tests

```bash
npx tsx scripts/dzpk-club-parser.test.ts   # 4 gabarits réels, montants, filtre agent
npx tsx scripts/dzpk-ingest.test.ts        # dédup, curseur, isolation comptable
npx tsx scripts/dzpk-matcher.test.ts       # exact, homonymes, self-learning
npx tsx scripts/dzpk-dashboard.test.ts     # étapes, statut de matching, devises
```

## 7 bis. Écran back-office — `/dzpk-funnel`

Même gabarit que le funnel Nexa (cards de conversion, chips de filtre, table),
composants partagés de `components/funnel/`. Tout le SQL vit dans
`lib/funnels/dzpk/dashboard.ts` ; les étapes et les cards dans
`lib/funnels/dzpk/stages.ts` (module pur, importable côté client — `config.ts`
ne l'est pas, il lit `process.env`).

| Compteur | Source |
|---|---|
| Started | un lead = un `/start` |
| A rejoint 已进群 | `club_joined_at` |
| **Rattaché 已绑定为代理 🍓** | `bound_at` — **le KPI, seul gabarit qui crée du revenu** |
| Banni | `banned_at` |
| Commissions encaissées | `dzpk_commissions.paid_amount`, **par devise** (invariant #3) |

Colonne **Matching**, par lead : 🟢 auto-certain · 🔗 lié à la main ·
🟡 à réconcilier · —. `à réconcilier` prime sur tout le reste : un lead déjà
rattaché peut être cité dans une AUTRE notification qui, elle, attend une
décision — afficher « auto-certain » masquerait le travail restant.

Deux choix à connaître avant de lire l'écran :

- **« Banni » n'est pas une étape**, c'est un badge. Un banni a bel et bien été
  rattaché : le sortir de « Rattaché » ferait baisser le taux de conversion de
  sa source pour un événement postérieur.
- **Les notifications sans candidat** (nom inconnu du funnel) ne peuvent avoir
  aucune ligne dans le tableau. Elles sont donc annoncées à part (bandeau
  « ⚠️ N notifications ne correspondent à aucun lead »), jamais tues.

L'écran est en **lecture seule** : trancher passe toujours par
`POST /api/admin/dzpk-ingest` (action `resolve`).

---

## 7 ter. Postbacks S2S de conversion

Quand un lead **rejoint le club** (`已进群`), le réseau qui a vendu le clic est
prévenu par un GET sortant portant le **click id** de ce lead. C'est ce qui
permet à Propeller et RichAds d'optimiser leurs enchères sur notre budget.

| Variable | Réseau | Déclenchée par une source |
|---|---|---|
| `PROPELLER_POSTBACK_URL` | PropellerAds | `tgads-…` ou `tgads_…` |
| `RICHADS_POSTBACK_URL` | RichAds | `richads-…` ou `richads_…` |

Chacune contient `{CB}`, remplacé par le click id (URL-encodé). Toute autre
source — `organic`, `direct`, achat direct, source inventée — **n'envoie rien**,
et ce n'est pas une anomalie.

### Le click id voyage dans le deep link

C'est le point qui n'existait pas avant, et sans lequel rien du reste ne
fonctionne. `richads_clicks` connaît le click id, mais **rien ne le relie au
compte Telegram** qui fera `/start` : il n'y a aucune requête de rattrapage
possible. Le seul canal est donc le lien lui-même.

```
/go?cre=tgads-26845722&cb=A1b2C3d4
   → https://t.me/Poker5A_bot?start=tgads_26845722--A1b2C3d4
                                     └── source ──┘  └ click id ┘
```

- Séparateur `--` : `creToStartParam` ne produit **jamais** de tiret (les siens
  deviennent `_`), donc la première occurrence est forcément le séparateur.
  Les liens écrits à la main (`?start=tgads_cn_video3`, `?start=tgads-cn`) sont
  intacts — pas de `--`, donc pas de découpe.
- Plafond Telegram de 64 caractères : si les deux ne tiennent pas, c'est la
  **source** qui est rognée, jamais le click id. Une source tronquée dégrade un
  libellé ; un click id tronqué casse la conversion en silence.
- Le click id garde sa **casse** et ses tirets — c'est une clé opaque, elle doit
  arriver au réseau à l'octet près.

### `click_id` est FIRST-TOUCH, comme la source

Écrit à la création du lead, jamais réécrit par un re-`/start`. La raison est
plus dure que la symétrie : le réseau à qui l'on poste est déduit de `source`
(first-touch). Un click id remplissable plus tard enverrait un click id RichAds
à l'endpoint Propeller — réponse 200, aucun crédit, aucun symptôme.

> **Conséquence à connaître : les leads créés avant le 2026-08-13 n'ont pas de
> click id et ne posteront jamais.** Il n'y a pas de rattrapage — l'information
> n'existait nulle part côté lead au moment de leur `/start`.

### Un lead ne poste qu'une fois, par construction

`postback_sent_at` est posé par un `UPDATE … WHERE postback_sent_at IS NULL`
**avant** l'appel réseau. Deux passes du cron sur le même join ne peuvent pas
envoyer deux fois.

Le prix est assumé : **un envoi qui échoue n'est pas rejoué automatiquement.**
Un postback manquant se voit (`postback_result`, logs) et se rejoue à la main ;
un postback en double ne se voit nulle part et fausse le chiffre sur lequel on
achète du trafic. Un rejeu automatique après timeout est précisément ce qui
produit des doublons quand l'échec était un succès mal accusé.

### Vérifier dans les logs Railway

```
railway logs 2>&1 | grep "DZPK POSTBACK"
```

```
[DZPK START]    lead=42 tg=…  source=tgads_26845722 cb=A1b2C3d4 nouveau
[DZPK POSTBACK] lead=42 réseau=propeller cb=A1b2C3d4 url=ad.propellerads.com/conversion.php http=200 ✅
```

`cb=aucun` au `/start` = le click id n'a pas voyagé : vérifier que la campagne
passe bien `cb=` à `/go` (macro `${SUBID}` côté Propeller, `[CLICK_ID]` côté
RichAds). Le constater au join serait trop tard.

### Tester sans attendre un vrai join

`POST /api/admin/dzpk-postback` avec un click id factice — celui que fournit
l'outil **« Test conversion »** de PropellerAds. Ne touche à **aucun lead** :
impossible de consommer le verrou d'un lead réel ou de marquer envoyée une
conversion qui n'a pas eu lieu.

```bash
BASE=https://lecerclepoker-production.up.railway.app
TOK=$ADMIN_RECONCILE_TOKEN

# 1. Ce que le serveur voit : URL configurées, {CB} présent, état des leads
curl -s $BASE/api/admin/dzpk-postback -H "x-admin-token: $TOK" | jq

# 2. Envoi de test avec un cb factice
curl -s -X POST $BASE/api/admin/dzpk-postback -H "x-admin-token: $TOK" \
     -H 'content-type: application/json' \
     -d '{"network":"propeller","cb":"TEST-CONV-1"}' | jq

# 3. Rejeu explicite pour un lead réel (lève le verrou — à faire en connaissance)
curl -s -X POST $BASE/api/admin/dzpk-postback -H "x-admin-token: $TOK" \
     -H 'content-type: application/json' \
     -d '{"leadId":42,"retry":true}' | jq
```

Le `GET` expose `joins_sans_postback` : les leads attribuables qui ont rejoint
sans qu'aucun postback ne parte. Zéro ailleurs peut être normal (pas encore de
trafic) ; une valeur **ici** ne l'est jamais.

> Un `2xx` prouve que l'appel est parti et a été accepté. Qu'il ait été
> **compté** se lit chez le réseau — répondre 200 est le comportement par défaut
> d'un pixel de tracking.

### Tests

```bash
npx tsx scripts/dzpk-postback.test.ts    # 68 assertions
```

---

## 8. Prévu, pas encore livré

- **Bouton « rattacher » dans l'écran** — aujourd'hui la file s'affiche mais la
  décision passe par l'API admin. Attribuer du revenu d'un clic mérite sa passe
  de revue.
- **Étape « pseudo club »** dans le funnel — à caler avec Baki (copy à valider).
- **Phase 3** — relais humain vers « Support DZPK » (un sujet par lead).
- **Phase 4** — relance J+1 unique, broadcasts segmentés throttlés.

### Décisions de phase 2 déjà arbitrées par Baki

Consignées ici parce qu'elles ne se déduisent d'aucun code et qu'elles ont coûté
plusieurs allers-retours.

**Le revenu se scelle au premier JEU, pas au join.** Le club poste quatre
notifications en DM au compte de Baki. Seul le gabarit 2 (`已绑定为代理`) crée du
revenu ; le gabarit 1 (`已进群`) n'est qu'une étape intermédiaire.

**Ingestion en PULL, jamais en listener.** Le userbot GramJS interroge
l'historique d'un **seul peer** (`DZPK_CLUB_BOT`) depuis un curseur. Deux
conséquences voulues : aucune autre conversation privée n'est jamais lue, et une
coupure réseau ou un redémarrage Railway ne perd rien — le curseur n'a pas
avancé, le tick suivant rattrape.

**Le gabarit 1 ne porte AUCUN nom d'agent**, contrairement aux trois autres. Un
join ne peut donc pas être prouvé « à nous » par son texte, seulement présumé du
fait qu'il arrive dans le DM. Le risque est borné par construction : seul le
gabarit 2 attribue du revenu, et lui porte le filtre agent.

**Le nom est extrait en ancrant sur le libellé du club**, pas sur le mot qui
suit. Le caractère `从` du gabarit 2 peut appartenir à un nom de joueur
(`从容`) : un découpage naïf couperait le nom en deux, silencieusement.

**Démarrage en 100 % réconciliation manuelle.** L'ingestion et le parsing
tournent, mais aucun rattachement automatique n'est appliqué. Le système affiche
le taux d'auto-match qu'il **aurait** obtenu ; l'activation se décide sur ce
chiffre, pas sur une intuition. Sur du revenu, quelques jours de pointage manuel
coûtent moins cher qu'un auto qui se trompe.

**Aucun auto-rattachement sur le prénom seul**, même unique. L'unicité d'un
`mark` ou d'un `Rom` est un accident du volume actuel : le prochain homonyme
rendrait le rattachement d'hier faux rétroactivement.

**`normalizeForMatch` (`lib/normalize.ts`) est INUTILISABLE ici.** Sa classe
`[^\w\s]` réduit tout nom chinois à la chaîne vide (`"张伟" → ""`), ce qui
ferait matcher tous les leads chinois entre eux. Un normaliseur dédié conserve
le CJK.

**`dzpk_commissions` est isolée de la comptabilité.** Elle n'alimente ni
`wallet_transactions`, ni les P&L, ni les settlements. Rapprocher ces montants
des USDT réellement reçus est une tâche séparée, à décider explicitement.
L'écart demandé/payé n'est jamais stocké : il se calcule à la lecture, et les
chaînes brutes (`requested_raw`, `paid_raw`) restent la source de vérité.
