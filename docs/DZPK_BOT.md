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
| `DZPK_ADMIN_CHAT_ID` | Supergroupe « Support DZPK » (Sujets activés) | 3 |

`TELEGRAM_API_ID` / `TELEGRAM_API_HASH` / `TELEGRAM_SESSION` existent déjà (userbot
GramJS) et sont réutilisées telles quelles en phase 2 — rien à créer.

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

---

## 6. Tests

```bash
npx tsx scripts/dzpk-leads.test.ts
```

Base SQLite en mémoire, alimentée par `DZPK_SCHEMA_SQL` — **la chaîne SQL de la
migration elle-même**, pas une recopie. Les trois propriétés invisibles
(first-touch, idempotence, historique d'identité) sont vérifiées par
contrefactuel : le bug est remis, et le test doit tomber.

---

## 7. Prévu, pas encore livré

- **Phase 2** — ingestion des notifs du club, parsing, appariement, réconciliation.
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
