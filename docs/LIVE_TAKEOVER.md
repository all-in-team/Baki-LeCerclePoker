# Live takeover — reprendre la main sur le bot funnel

Le bot `@LeCercle_Lebot` est scripté. Avant cette feature, un lead qui posait une
question hors scénario recevait une réponse générique et **personne ne voyait sa
question**. Le live takeover ajoute le chaînon manquant :

```
lead ──DM──> bot ──relais──> chat admin ──« Répondre »──> bot ──DM──> lead
```

Côté lead, **c'est toujours le bot qui parle** : jamais de forward, jamais de nom
d'opérateur, jamais de mention du back-office.

Portée : le funnel **Nexa** (`nexa_leads`, deep links `?start=nexa`, `?start=nexa_tg`,
`?start=nexa_ig`…). Le funnel QQPK et l'onboarding joueur ne sont pas concernés.

---

## 1. Configurer `ADMIN_CHAT_ID`

C'est la seule variable à créer. Elle désigne le chat Telegram où atterrissent les
messages des leads.

### Créer le chat

1. Dans Telegram, crée un **groupe** dédié (ex. « LeCercle · Leads »). Un groupe,
   pas un canal : on répond aux messages, et un canal ne le permet pas correctement.
2. Ajoute **@LeCercle_Lebot** au groupe.
3. Passe le bot **administrateur** du groupe. Sans ça, il ne peut pas poser la
   réaction ✅ de confirmation.

> ⚠️ Ce groupe doit être **différent** du chat de l'agent Claude
> (`AGENT_TELEGRAM_CHAT_ID`). Dans le chat agent, tout message non-commande part vers
> Claude et consomme des tokens.

### Récupérer l'ID du chat

Poste n'importe quel message dans le groupe, puis :

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
  | python3 -c 'import json,sys; [print(u.get("message",{}).get("chat")) for u in json.load(sys.stdin)["result"]]'
```

L'ID d'un groupe est négatif (`-1002…`). Alternative sans curl : les logs Railway
tracent chaque update — cherche `[WEBHOOK_RAW] type=message chat=…`.

### Déclarer la variable

```bash
railway variables --set "ADMIN_CHAT_ID=-1002XXXXXXXXX"
```

Aucun redéploiement n'est nécessaire pour la lecture de la variable, mais Railway
redémarre le service à chaque changement de variable — c'est normal.

**Si `ADMIN_CHAT_ID` n'est pas défini**, le relais retombe sur
`AGENT_TELEGRAM_CHAT_ID` et logge un avertissement au démarrage. Choix délibéré :
une variable oubliée doit dégrader de façon visible, pas faire disparaître les
questions en silence — c'est exactement le bug que cette feature corrige.

### Vérifier

Envoie `/start nexa` au bot depuis un compte de test, puis écris-lui n'importe quoi.
Un post doit apparaître dans le groupe admin :

```
Jo / @jo · account_created · src tg · ID 2518550
———
salut, ça marche comment le bonus ?
```

Réponds à ce post (fonction « Répondre » native de Telegram) : le compte de test
reçoit ta réponse **du bot**, et une réaction ✅ apparaît sur ton message.

---

## 2. Utilisation quotidienne

### Répondre

Utilise « **Répondre** » sur un post du chat admin. Texte, photo, document et voix
sont relayés à l'identique (le média est copié, pas transféré : pas d'en-tête
« transféré de »).

- ✅ posé sur ton message = envoyé.
- Un message d'erreur explicite s'affiche si le lead a bloqué le bot — il est alors
  flagué 🚫 dans le back-office et sort des relances.

Si l'emoji ✅ n'est pas autorisé dans ton groupe, le bot retombe sur 👍.

### Commandes (toujours **en réponse** à un post du lead)

| Commande        | Effet                                                        |
|-----------------|--------------------------------------------------------------|
| `/bot`          | Rend la main au scénario automatique immédiatement            |
| `/stop`         | Désactive **définitivement** les relances de ce lead           |
| `/note <texte>` | Ajoute une note interne horodatée sur la fiche lead            |

Une commande non reconnue n'est **jamais** relayée au lead : le bot répond
« Commande inconnue » dans le chat admin.

### Le mode takeover

Toute réponse d'opérateur (Telegram **ou** back-office) pousse `takeover_until` à
**now + 6 h**. Tant qu'il est actif :

- ❌ aucune relance automatique ni manuelle,
- ❌ aucune confirmation d'import (« ton compte est vérifié »),
- ❌ aucune réponse scriptée au texte libre du lead,
- ✅ **les clics de bouton continuent de fonctionner**.

Ce dernier point est un choix délibéré : un lead qui pilote lui-même le funnel ne
doit pas se retrouver sans réponse parce qu'un humain a la main. En contrepartie, le
chat admin reçoit une ligne discrète à chaque clic :

```
→ Jo / @jo a cliqué « 💰 J'ai déposé » · le bot a répondu automatiquement
```

`/bot` rend la main immédiatement, sans attendre les 6 h.

### Depuis le back-office (`/nexa-funnel`)

- Colonne **💬** : pastille jaune = message non lu, + horodatage du dernier message
  du lead. 🎙 = takeover actif.
- Filtre **« À répondre »** en tête de table.
- **Un clic sur la ligne** ouvre le panneau conversation : historique complet
  (lead en bleu, bot en gris, opérateur en vert) + champ de réponse.
- La réponse envoyée depuis le panneau passe par **exactement la même fonction**
  (`replyToLead`) que la réponse Telegram — même envoi, même journalisation, même
  effet sur `takeover_until`.
- Boutons « 🤖 Rendre la main au bot » et « 🔕 Stop relances » = équivalents de
  `/bot` et `/stop`.

---

## 3. Ce qui est stocké

Migration `add_live_takeover_v1` (`lib/db.ts`).

| Table / colonne                    | Rôle                                                      |
|------------------------------------|-----------------------------------------------------------|
| `bot_messages`                     | Historique **complet**, entrant et sortant, takeover ou pas |
| `relay_map`                        | `admin_message_id → lead_id` (résolution de « Répondre »)   |
| `telegram_updates`                 | Dédoublonnage des updates rejoués par Telegram              |
| `nexa_leads.takeover_until`        | Fin du takeover ; `NULL` = le bot a la main                 |
| `nexa_leads.takeover_by`           | Dernier opérateur à avoir répondu                           |
| `nexa_leads.relances_off`          | `/stop` — exclusion définitive des relances                 |
| `nexa_leads.last_lead_msg_at`      | Horodatage affiché à côté de la pastille                    |
| `nexa_leads.last_read_msg_id`      | Curseur de lecture du panneau conversation                  |

`sender` vaut `lead`, `bot_auto` ou `operator:<nom>`.

**Rétention.** `relay_map` est purgé à 30 jours (cron quotidien, 5h50 Paris) et
`telegram_updates` à 24 h (purge opportuniste). **`bot_messages` n'est jamais
purgé** : c'est l'historique de conversation, il doit rester complet.

L'historique démarre au déploiement — les conversations antérieures ne sont pas
reconstituables (rien ne les stockait).

---

## 4. Points d'attention

**Idempotence.** Deux garde-fous indépendants : dédoublonnage par `update_id` en
tête de webhook (qui protège aussi la création de groupe, cf. `add_nexa_group_claim_v1`),
et index UNIQUE partiel sur `(lead_id, telegram_message_id)` pour les entrants.

**Salves.** Trois messages en moins de 60 s produisent **un seul** post admin :
le post initial est édité au fil de la salve. La fenêtre part du premier message et
ne glisse pas. Les médias, qui ne s'éditent pas dans un post texte, sont copiés en
plus et sont eux aussi répondables.

**Tout est relayé**, y compris ce que le scénario sait traiter (un Member ID envoyé
à l'étape « compte créé » apparaît dans le chat admin). C'est volontaire : le filet
de sécurité ne doit pas dépendre du fait que le bot ait cru comprendre.

**Non touché** : le tracking d'étapes (Started / App installée / Compte créé /
Dépôt / Débloqué), l'import hebdo XLSX, le funnel QQPK, l'onboarding joueur. Un
palier est enregistré même pendant un takeover — seul le message au lead est
suspendu.

---

## 5. Dépannage

| Symptôme                                     | Cause probable                                              |
|----------------------------------------------|-------------------------------------------------------------|
| Rien n'arrive dans le chat admin              | `ADMIN_CHAT_ID` absent/erroné, ou bot pas membre du groupe   |
| « Répondre » ne fait rien                     | Le post visé a plus de 30 j (`relay_map` purgé) → écris au lead depuis le back-office |
| Pas de ✅                                     | Bot non admin du groupe, ou réactions désactivées → l'envoi a quand même eu lieu |
| Le bot répond alors que j'ai la main          | C'est un **clic de bouton** du lead — voir la ligne « a cliqué » ; `/bot` ou attends |
| Un lead ne reçoit plus de relance             | `takeover_until` encore actif, ou `/stop` posé (`relances_off = 1`) |
