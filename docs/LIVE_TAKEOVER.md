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

Trois issues possibles, à ne pas confondre :

| Log                              | Signification                                                |
|----------------------------------|---------------------------------------------------------------|
| `Sujets activés`                 | Tout est bon                                                  |
| `Sujets NON activés`             | Sujets désactivés sur le groupe, ou bot sans « Gérer les sujets ». Le relais fonctionne quand même, **à plat** (§5) |
| `sonde impossible (réseau)`      | **Pas un diagnostic de configuration.** Le réseau sortant du conteneur n'était pas prêt au boot ; l'état est resondé au premier message de lead |

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

### Deux états de silence, pas un seul

Le bot se tait pour **deux** raisons distinctes. Il fallait les deux : `takeover_until`
n'est armé qu'à la première réponse d'opérateur, donc sur le tout premier message
d'un lead il est encore vide — et le scénario répondait par-dessus la conversation
humaine (incident du 04/08 : le lead écrit « Je ne veux pas », le bot lui renvoie
« Bienvenue au Cercle »).

| État                       | Armé par                                                     | Levé par                                        |
|----------------------------|--------------------------------------------------------------|-------------------------------------------------|
| 🙋 **Attend une réponse**  | Clic « J'ai une question », ou tout texte libre hors scénario | Réponse d'opérateur, `/bot`, **ou 90 min**      |
| ❓ **Question ouverte**     | Idem                                                         | Réponse d'opérateur, ou `/bot` — **jamais le temps** |
| 🎙 **Takeover**            | Une réponse d'opérateur (Telegram ou back-office) → +6 h      | Expiration des 6 h, ou `/bot`                   |

### Le filet : le silence expire, la question non

Un silence qui n'expire jamais est pire que le bug qu'il corrige : un prospect qui
écrit à 2 h du matin sortirait **définitivement** du funnel automatique sans que
personne en soit averti.

Au bout de **90 minutes** sans réponse, le bot reprend donc la main — poliment :

> Désolé pour l'attente 🙏 En attendant, tu peux continuer ici 👇

…suivi des boutons de l'étape courante (EN : « Sorry for the wait 🙏 In the meantime,
you can keep going here 👇 »). La reprise est tracée dans le sujet :
`🤖 90 min sans réponse — le bot a repris la main`.

**La reprise ne se déclenche JAMAIS si un opérateur a déjà répondu au moins une fois**
dans la conversation (`first_operator_reply_at`). Le silence protège une conversation
humaine *réelle*, pas hypothétique — et une fois qu'elle existe, le bot ne s'y invite
plus jamais tout seul, même après l'expiration du takeover de 6 h. Les leads sous
`/stop` et ceux qui ont bloqué le bot ne sont pas réveillés non plus.

**La question, elle, reste ouverte.** Que le scénario ait redémarré ne veut pas dire
que quelqu'un a répondu : le lead reste dans le filtre **« À répondre »** jusqu'à ce
qu'un humain lui parle (ou `/bot`). Ce filtre remonte aussi les leads en attente
**même s'ils n'ont écrit aucun message** — un simple clic sur « J'ai une question »
suffit.

### Ce que le bot répond encore, et ce qu'il ne répond plus

- **Clic « ❓ J'ai une question »** → « 👍 Vas-y, pose ta question ici — un membre de
  l'équipe te répond d'ici quelques minutes. » (EN : « ask right here… »). Le lead
  **reste dans le bot** ; plus de renvoi vers un DM externe.
- **Texte libre hors scénario** → le même accusé, **une seule fois** (à l'entrée en
  attente), puis silence total. Le bot ne rejoue plus jamais l'étape courante en
  réponse à une phrase.
- **Texte 100 % numérique à l'étape ID** → toujours traité par le scénario (c'est une
  tentative d'ID, pas une phrase), avec le rappel de format si besoin.
- **Pendant un silence**, un ID valide envoyé par le lead est quand même
  **enregistré en silence** : le tracking d'étapes ne dépend pas de qui tient le
  micro, et tu n'as pas à lui redemander un ID qu'il vient d'envoyer.

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

- Colonnes **Lead** et **💬** sont **figées à gauche** : elles restent visibles quand
  on scrolle vers les colonnes Σ.
- Colonne **💬** : pastille jaune = message non lu ou lead en attente, + horodatage du
  dernier message. 🙋 = attend une réponse · 🎙 = takeover actif.
- Filtre **« À répondre »** en tête de table (non lus **et** leads en attente).
- Toggle **« Σ Colonnes chiffres »** : les colonnes Σ sont masquées d'office sur écran
  étroit, ce qui supprime le scroll horizontal dans l'usage courant.
- **Un clic sur la ligne** ouvre un **drawer latéral** ancré à l'écran (~520 px) :
  en-tête lead (nom, étape, source, ID, 🧵 Sujet Telegram, badges) → conversation
  scrollable → champ de réponse **toujours visible** → Parcours / Historique /
  Actions / Notes en dessous. Fermeture par **Échap**, clic extérieur ou **✕**.
  Le tableau reste utilisable : cliquer une autre ligne change de lead sans fermer.
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
| `nexa_leads.awaiting_human_since`   | 🙋 silence scripté — expire à 90 min si aucun opérateur n'a répondu |
| `nexa_leads.question_open_since`    | ❓ question sans réponse — n'expire pas, pilote « À répondre »   |
| `nexa_leads.first_operator_reply_at`| Verrou : un humain a répondu ⇒ le bot ne reprend jamais la main seul |
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
| Un lead ne reçoit plus de relance             | `takeover_until` actif, `awaiting_human_since` non levé, ou `/stop` posé |
| Le bot ne répond plus du tout à un lead       | Il est en 🙋 attente : réponds-lui, `/bot`, ou attends la reprise à 90 min |
| Le bot a relancé un lead à qui je parlais     | Ne devrait pas arriver : la reprise s'interdit dès qu'un opérateur a répondu une fois. Vérifie `first_operator_reply_at` sur ce lead |
| Le sujet d'un lead a disparu                  | Supprimé côté Telegram : il sera recréé à son prochain message |
