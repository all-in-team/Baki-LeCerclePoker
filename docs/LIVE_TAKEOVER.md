# Live takeover — reprendre la main sur le bot funnel

Le bot `@LeCercle_Lebot` est scripté. Avant cette feature, un lead qui posait une
question hors scénario recevait une réponse générique et **personne ne voyait sa
question**. Le live takeover ajoute le chaînon manquant :

```
lead ──DM──> bot ──relais──> sujet du chat admin ──> bot ──DM──> lead
```

Chaque lead a **son propre Sujet** (topic) dans le chat admin. Écrire dedans suffit
à lui répondre. Côté lead, **c'est toujours le bot qui parle** : jamais de forward,
jamais de nom d'opérateur, jamais de mention du back-office.

Portée : le funnel **Nexa** (`nexa_leads`, deep links `?start=nexa`, `?start=nexa_tg`,
`?start=nexa_ig`…). Le funnel QQPK et l'onboarding joueur ne sont pas concernés.

---

## 1. Configurer le chat admin

### Créer le groupe

1. Crée un **supergroupe** dédié (ex. « LeCercle · Leads »).
2. Réglages du groupe → **active « Sujets »** (Topics).
3. Ajoute **@LeCercle_Lebot** et passe-le **administrateur**, avec au minimum :
   - **Gérer les sujets** (`can_manage_topics`) — sans ça, aucun topic n'est créé ;
   - **Épingler les messages** (`can_pin_messages`) — pour la carte contexte ;
   - le droit de supprimer/gérer les messages n'est pas nécessaire.

> ⚠️ Ce groupe doit être **différent** du chat de l'agent Claude
> (`AGENT_TELEGRAM_CHAT_ID`). Dans le chat agent, tout message non-commande part vers
> Claude et consomme des tokens.

### Récupérer l'ID du chat

Poste n'importe quel message dans le groupe, puis :

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
  | python3 -c 'import json,sys; [print(u.get("message",{}).get("chat")) for u in json.load(sys.stdin)["result"]]'
```

L'ID d'un supergroupe est négatif (`-100…`). Alternative sans curl : les logs Railway
tracent chaque update — cherche `[WEBHOOK_RAW] type=message chat=…`.

### Déclarer la variable

```bash
railway variables --set "ADMIN_CHAT_ID=-1002XXXXXXXXX"
```

**Si `ADMIN_CHAT_ID` n'est pas défini**, le relais retombe sur
`AGENT_TELEGRAM_CHAT_ID` et logge un avertissement au démarrage. Choix délibéré :
une variable oubliée doit dégrader de façon visible, pas faire disparaître les
questions en silence — c'est exactement le bug que cette feature corrige.

### Vérifier

Au démarrage, les logs Railway indiquent :

```
[TOPICS] chat admin -1002XXXXXXXXX — Sujets activés
```

Si tu lis `NON activés (mode plat)`, les Sujets ne sont pas activés sur le groupe ou
le bot n'a pas « Gérer les sujets ». Le relais **fonctionne quand même**, à plat,
comme avant la bascule (§5).

Envoie ensuite `/start nexa` au bot depuis un compte de test, puis écris-lui.
Un sujet doit apparaître :

```
🚀 Jo · @jo · Compte
   ├─ [épinglé] Jo · @jo
   │            Étape : 📝 Compte créé
   │            Source : tg
   │            ID joueur : 2518550
   │            🔗 Fiche dans le back-office
   └─ salut, ça marche comment le bonus ?
```

Écris dans ce sujet : le compte de test reçoit ton message **du bot**, et une
réaction ✅ apparaît sur le tien.

---

## 2. Utilisation quotidienne

### Répondre

**Écris simplement dans le sujet du lead.** Pas de « Répondre », pas de commande.
Texte, photo, document et voix sont relayés à l'identique (le média est copié, pas
transféré : pas d'en-tête « transféré de »).

- ✅ posé sur ton message = envoyé.
- Un échec d'envoi (lead qui a bloqué le bot) est signalé dans **General**, avec un
  lien vers le sujet concerné. Le lead est alors flagué 🚫 dans le back-office et
  sort des relances.

Si l'emoji ✅ n'est pas autorisé dans ton groupe, le bot retombe sur 👍.

### Le sujet suit le lead

- **Nom** : `Prénom · @handle · Étape` (`tg:<id>` s'il n'y a pas de handle).
  Renommé automatiquement à chaque avancement — `Jo · @jo · Déposé`.
- **Icône** : une par étape (🚀 📲 📝 💰 ✅ ♠️). La **couleur** est posée à la
  création — Telegram ne permet pas de la changer ensuite — et passe au **vert dès
  le dépôt** : les leads qui ont payé se repèrent dans la liste des sujets sans lire
  les noms.
- **Carte contexte** épinglée en tête : étape, source, ID joueur, lien vers la fiche
  du back-office. Elle est **éditée** à chaque changement d'étape, jamais repostée.

### Commandes (dans le sujet du lead)

| Commande        | Effet                                                        |
|-----------------|--------------------------------------------------------------|
| `/bot`          | Rend la main au scénario automatique immédiatement            |
| `/stop`         | Désactive **définitivement** les relances de ce lead           |
| `/note <texte>` | Ajoute une note interne horodatée sur la fiche lead            |

Une commande non reconnue n'est **jamais** relayée au lead : le bot répond
« Commande inconnue » dans le sujet. C'est vrai de **toute** commande tapée dans un
sujet de lead, y compris les commandes habituelles du bot (`/pnl`, `/solde`…) —
tape-les ailleurs.

### General

Le sujet **General** est réservé aux alertes système : échecs d'envoi, configuration
manquante, incidents. **Aucun message de lead n'y est jamais posté.** Écrire dans
General ne déclenche rien.

### Le mode takeover

Toute réponse d'opérateur (Telegram **ou** back-office) pousse `takeover_until` à
**now + 6 h**. Tant qu'il est actif :

- ❌ aucune relance automatique ni manuelle,
- ❌ aucune confirmation d'import (« ton compte est vérifié »),
- ❌ aucune réponse scriptée au texte libre du lead,
- ✅ **les clics de bouton continuent de fonctionner**.

Ce dernier point est un choix délibéré : un lead qui pilote lui-même le funnel ne
doit pas se retrouver sans réponse parce qu'un humain a la main. En contrepartie, le
sujet reçoit une ligne discrète à chaque clic :

```
→ Le lead a cliqué « 💰 J'ai déposé » · le bot a répondu automatiquement
```

`/bot` rend la main immédiatement, sans attendre les 6 h.

### Depuis le back-office (`/nexa-funnel`)

- Colonne **💬** : pastille jaune = message non lu, + horodatage du dernier message
  du lead. 🎙 = takeover actif.
- Filtre **« À répondre »** en tête de table.
- **Un clic sur la ligne** ouvre le panneau conversation : historique complet
  (lead en bleu, bot en gris, opérateur en vert), lien **🧵 Sujet Telegram**, et
  champ de réponse.
- La réponse envoyée depuis le panneau passe par **exactement la même fonction**
  (`replyToLead`) que la réponse Telegram — même envoi, même journalisation, même
  effet sur `takeover_until`.
- Boutons « 🤖 Rendre la main au bot » et « 🔕 Stop relances » = équivalents de
  `/bot` et `/stop`.

---

## 3. Robustesse

**Aucun message de lead n'est perdu.** C'est garanti par un curseur, pas par un
espoir : `nexa_leads.last_relayed_msg_id` n'avance qu'**après** un post réussi dans
le sujet. Tant qu'il n'a pas avancé, le message reste « à relayer ».

Un job de reprise (`relay-drain`) passe **toutes les 5 minutes** et repose tout ce
qui est en attente. Il couvre :

| Situation                                   | Comportement                                             |
|---------------------------------------------|----------------------------------------------------------|
| Rate limit Telegram sur `createForumTopic`   | Attente du `retry_after`, puis reprise. Les créations sont sérialisées : dix leads simultanés attendent une fois, pas dix. |
| Création trop lente (> 8 s)                  | Le webhook rend la main, la création continue en fond, le drain poste ensuite |
| Sujet supprimé côté Telegram                 | Recréé, `admin_thread_id` mis à jour, message reposté      |
| Sujet fermé                                  | Rouvert à la volée avant l'envoi                           |
| Telegram indisponible                        | Rien n'est marqué relayé ; repris au tick suivant          |

**Hygiène.** Un sujet sans activité depuis **30 jours** est fermé automatiquement
(cron quotidien, 5h50 Paris). Rien n'est supprimé : la conversation reste lisible, et
le premier message du lead **rouvre le sujet** tout seul.

**Salves.** Trois messages en moins de 60 s produisent **un seul** post : le post
initial est édité au fil de la salve. La borne de la salve est un id de message
(`relay_map.from_msg_id`), pas une heure — la reconstruction ne dépend d'aucune
horloge. Les médias, qui ne s'éditent pas dans un post texte, sont copiés en plus.

---

## 4. Ce qui est stocké

Migrations `add_live_takeover_v1` et `add_live_takeover_topics_v1` (`lib/db.ts`).

| Table / colonne                     | Rôle                                                       |
|-------------------------------------|-------------------------------------------------------------|
| `bot_messages`                      | Historique **complet**, entrant et sortant, takeover ou pas  |
| `relay_map`                         | `admin_message_id → lead_id` — **repli** de résolution + ancre de salve |
| `telegram_updates`                  | Dédoublonnage des updates rejoués par Telegram               |
| `nexa_leads.admin_thread_id`        | **Le routage principal** : sujet → lead                      |
| `nexa_leads.admin_topic_chat_id`    | Chat du sujet (un thread_id n'a de sens que dans son chat)   |
| `nexa_leads.admin_topic_name`       | Dernier nom appliqué — évite un renommage identique           |
| `nexa_leads.admin_card_message_id`  | Carte épinglée, pour l'éditer au lieu de la reposter          |
| `nexa_leads.admin_topic_closed`     | Sujet fermé (hygiène 30 j) — rouvert à la volée               |
| `nexa_leads.admin_topic_last_at`    | Dernière activité du sujet                                   |
| `nexa_leads.last_relayed_msg_id`    | **Curseur de relais** — la garantie « aucun message perdu »   |
| `nexa_leads.takeover_until` / `_by` | Fin du takeover ; `NULL` = le bot a la main                   |
| `nexa_leads.relances_off`           | `/stop` — exclusion définitive des relances                   |
| `nexa_leads.last_lead_msg_at`       | Horodatage affiché à côté de la pastille                      |
| `nexa_leads.last_read_msg_id`       | Curseur de lecture du panneau conversation                    |

`sender` vaut `lead`, `bot_auto` ou `operator:<nom>`.

**Rétention.** `relay_map` est purgé à 30 jours (cron quotidien) et
`telegram_updates` à 24 h. **`bot_messages` n'est jamais purgé** : c'est l'historique
de conversation, il doit rester complet.

L'historique démarre au déploiement de la v1 — les conversations antérieures ne sont
pas reconstituables (rien ne les stockait).

---

## 5. Compatibilité

**Sujets non activés** (`getChat` → `is_forum: false`) : le relais bascule en **mode
plat**, exactement comme avant. Les posts portent alors leur en-tête
`[nom] · étape · source · ID`, et on répond avec « Répondre ». Un avertissement est
loggé au démarrage. Aucune exception, aucun message perdu.

**Leads d'avant la bascule** : ils n'ont pas de sujet tant qu'ils n'ont pas réécrit.
En attendant, `relay_map` continue de résoudre le « Répondre » sur leurs anciens
posts. Dès leur prochain message, un sujet est créé et le routage passe par lui.

**Ordre de résolution** d'un message d'opérateur : le **sujet** d'abord, `relay_map`
ensuite. Aucun risque de confusion entre les deux.

**Non touché** : le tracking d'étapes (Started / App installée / Compte créé /
Dépôt / Débloqué), l'import hebdo XLSX, le funnel QQPK, l'onboarding joueur. Un
palier est enregistré même pendant un takeover — seul le message au lead est
suspendu.

---

## 6. Dépannage

| Symptôme                                     | Cause probable                                              |
|----------------------------------------------|-------------------------------------------------------------|
| Aucun sujet créé, tout arrive à plat          | Sujets non activés, ou bot sans « Gérer les sujets ». Vérifie le log `[TOPICS]` au démarrage |
| Rien n'arrive dans le chat admin              | `ADMIN_CHAT_ID` absent/erroné, ou bot pas membre du groupe   |
| Un message tarde à apparaître                 | Rate limit Telegram — le drain le poste dans les 5 min ; cherche `relais différé` dans les logs |
| La carte n'est pas épinglée                   | Bot sans « Épingler les messages » — elle reste le 1ᵉʳ message du sujet |
| J'écris dans General, rien ne part            | Normal : General est réservé aux alertes système             |
| Pas de ✅                                     | Réactions désactivées sur le groupe → l'envoi a quand même eu lieu |
| Le bot répond alors que j'ai la main          | C'est un **clic de bouton** du lead — voir la ligne « a cliqué » ; `/bot` ou attends |
| Un lead ne reçoit plus de relance             | `takeover_until` encore actif, ou `/stop` posé (`relances_off = 1`) |
| Le sujet d'un lead a disparu                  | Supprimé côté Telegram : il sera recréé à son prochain message |
