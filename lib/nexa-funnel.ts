// NEXAPOKER Funnel — leads → bot Telegram (DM) → groupe privé au premier dépôt.
// Deep link : https://t.me/LeCercle_Lebot?start=nexa  (ou ?start=nexa_<source>)
//
// Différences avec QQPK : pas de rakeback (le pitch repose sur le code bonus), et
// la room est en système d'agent → tous les dépôts/retraits passent par nous, dans
// un groupe Telegram privé créé au moment du premier dépôt.
//
// Les leads vivent dans nexa_leads : ce ne sont PAS des players, donc aucun lien
// avec le money engine, les settlements ou les rappels cashout.
//
// Règles structurantes :
//   • stage = palier MAX atteint, n'avance jamais à reculons ; les timestamps par
//     palier sont indépendants (un import peut vérifier un lead jamais marqué "dépôt").
//   • Idempotence : re-cliquer un bouton ne duplique ni transition, ni notif admin,
//     ni création de groupe.
//   • Tout est journalisé dans nexa_lead_events (transitions, relances, questions,
//     groupe, actions admin) avec son déclencheur (bot / import / admin).
import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, sendForceReply, answerCbQuery, AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";
import {
  NEXA_ROOM_LABEL, NEXA_BONUS_CODE, NEXA_DOWNLOADS, NEXA_MEMBER_ID_RE, NEXA_MEMBER_ID_DIGITS,
  NEXA_STAGE_ORDER, NEXA_REMINDER_THRESHOLDS_H, NEXA_MAX_REMINDERS, NEXA_REMINDER_MIN_GAP_H,
  type NexaStage, type NexaOs,
} from "@/lib/funnels/nexa/config";
import { nexaCopy, NEXA_LANG_CB_PREFIX, type NexaCopy } from "@/lib/funnels/nexa/copy";
import { SUPPORT_HANDLE } from "@/lib/funnels/shared";
import { coerceLang, langKeyboard, langPromptText, parseLangCallback, type Lang } from "@/lib/i18n";
import {
  esc, isTakeoverActiveForTgId, logBotMessage, notifyAutoReplyDuringTakeover,
  postAnchoredNotice,
} from "@/lib/funnels/live-takeover";

export type NexaLead = {
  id: number;
  tg_user_id: number;
  tg_username: string | null;
  first_name: string | null;
  source: string;
  os: string | null;
  member_id: string | null;
  stage: NexaStage;
  started_at: string | null;
  installed_at: string | null;
  account_at: string | null;
  deposit_at: string | null;
  verified_at: string | null;
  played_at: string | null;
  group_chat_id: string | null;
  group_invite_link: string | null;
  /** Verrou de création (anti double-groupe) et garde d'annonce (anti double-message). */
  group_claimed_at: string | null;
  group_announced_at: string | null;
  /** Join constaté via l'event Telegram `chat_member` ; flag posé si le groupe est nettoyé faute de join. */
  group_joined_at: string | null;
  group_not_joined: number;
  /** Langue du funnel — 'fr' par défaut ; `lang_chosen_at` NULL = sélecteur jamais posé. */
  lang: string;
  lang_chosen_at: string | null;
  relances_count: number;
  last_reminder_at: string | null;
  last_interaction_at: string | null;
  duplicate_id: number;
  cold: number;
  blocked: number;
  notes: string | null;
  /** Live takeover — voir lib/funnels/live-takeover.ts. */
  takeover_until: string | null;
  takeover_by: string | null;
  /** /stop dans le chat admin : plus aucune relance, définitivement. */
  relances_off: number;
  /** Horodatage affiché à côté de la pastille (cosmétique). */
  last_lead_msg_at: string | null;
  /** Curseur de lecture du panneau conversation — comparé à bot_messages. */
  last_read_msg_id: number;
  created_at: string;
  updated_at: string;
};

const STAGE_TS_COL: Record<NexaStage, string> = {
  started: "started_at",
  app_installed: "installed_at",
  account_created: "account_at",
  deposit_done: "deposit_at",
  room_verified: "verified_at",
  played: "played_at",
};

type Actor = "bot" | "import" | "admin";

// ── Accès DB ──────────────────────────────────────────────

export function getNexaLeadByTgId(tgId: number): NexaLead | undefined {
  return getDb().prepare(`SELECT * FROM nexa_leads WHERE tg_user_id = ?`).get(tgId) as NexaLead | undefined;
}

export function getNexaLeadById(id: number): NexaLead | undefined {
  return getDb().prepare(`SELECT * FROM nexa_leads WHERE id = ?`).get(id) as NexaLead | undefined;
}

export function logNexaEvent(
  leadId: number,
  kind: "stage_change" | "question" | "reminder" | "group_created" | "admin",
  opts: { stage?: string | null; payload?: string | null; actor?: Actor } = {},
) {
  try {
    getDb().prepare(
      `INSERT INTO nexa_lead_events (lead_id, kind, stage, payload, actor) VALUES (?, ?, ?, ?, ?)`
    ).run(leadId, kind, opts.stage ?? null, opts.payload ?? null, opts.actor ?? "bot");
  } catch (e: any) {
    console.error(`[NEXA] logEvent failed (lead=${leadId}, kind=${kind}):`, e?.message ?? e);
  }
}

function touchInteraction(leadId: number) {
  getDb().prepare(
    `UPDATE nexa_leads SET last_interaction_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(leadId);
}

// ── Envois vers le lead ───────────────────────────────────
// TOUT message sortant du scénario passe par ces trois wrappers, jamais par sendMsg
// directement : c'est la seule façon que `bot_messages` soit un historique COMPLET
// et pas seulement l'historique des messages du takeover (§1 du brief). Les notifs
// vers AGENT_CHAT_ID, elles, continuent d'utiliser sendMsg — ce ne sont pas des
// messages au lead.
//
// En DM, chat_id == tg_user_id : la résolution du lead se fait donc sur le chat.
// Un chat qui n'est pas un lead Nexa n'est pas journalisé, sans erreur.
function logLeadOutbound(chatId: number | string, text: string, messageId?: number) {
  const row = getDb().prepare(`SELECT id FROM nexa_leads WHERE tg_user_id = ?`).get(Number(chatId)) as
    { id: number } | undefined;
  if (!row) return;
  logBotMessage({
    leadId: row.id, direction: "out", sender: "bot_auto",
    text, telegramMessageId: messageId ?? null,
  });
}

async function dmMsg(chatId: number | string, text: string) {
  const res = await sendMsg(chatId, text);
  logLeadOutbound(chatId, text, res?.messageId);
}

async function dmKeyboard(chatId: number | string, text: string, keyboard: any[][]) {
  const res = await sendMsgKeyboard(chatId, text, keyboard);
  logLeadOutbound(chatId, text, res?.messageId);
}

async function dmForceReply(chatId: number | string, text: string) {
  const res = await sendForceReply(chatId, text);
  logLeadOutbound(chatId, text, res?.messageId);
}

/**
 * Enregistre un palier : le timestamp est posé au premier passage (COALESCE), le
 * stage n'avance que s'il progresse. Retourne true si le stage a réellement avancé
 * (⇒ un seul event `stage_change`, une seule notif possible côté appelant).
 */
export function recordMilestone(leadId: number, target: NexaStage, actor: Actor = "bot"): boolean {
  const lead = getNexaLeadById(leadId);
  if (!lead) return false;
  const advances = (NEXA_STAGE_ORDER[target] ?? 0) > (NEXA_STAGE_ORDER[lead.stage] ?? 0);
  const col = STAGE_TS_COL[target]; // clé d'un map figé — jamais une entrée utilisateur
  const adv = advances ? 1 : 0;
  getDb().prepare(`
    UPDATE nexa_leads
    SET ${col} = COALESCE(${col}, datetime('now')),
        stage = CASE WHEN ? THEN ? ELSE stage END,
        relances_count = CASE WHEN ? THEN 0 ELSE relances_count END,
        last_reminder_at = CASE WHEN ? THEN NULL ELSE last_reminder_at END,
        cold = CASE WHEN ? THEN 0 ELSE cold END,
        last_interaction_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(adv, target, adv, adv, adv, leadId);
  if (advances) logNexaEvent(leadId, "stage_change", { stage: target, actor });
  return advances;
}

function leadName(lead: Pick<NexaLead, "tg_username" | "first_name" | "tg_user_id">): string {
  return lead.tg_username ? `@${lead.tg_username}` : (lead.first_name ?? `tg:${lead.tg_user_id}`);
}

// ── Messages du flow ──────────────────────────────────────
// TOUT le texte vu par un lead vient de lib/funnels/nexa/copy.ts, par langue.
// Aucun littéral destiné au lead ne doit réapparaître dans ce fichier ; les notifs
// AGENT_CHAT_ID, elles, restent en français (c'est Baki qui les lit).
//
// Convention : chaque helper d'envoi prend la langue en premier argument, obtenue
// par `leadLang(lead)`. Le copy est résolu une fois en tête de fonction (`c`).

/** Langue d'un lead — repli 'fr' pour toute valeur absente ou inconnue. */
function leadLang(lead: Pick<NexaLead, "lang">): Lang {
  return coerceLang(lead.lang);
}

/** Hint du Member ID (« 7 chiffres » / « 7 digits ») — nombre en config, formulation en copy. */
function memberIdHint(c: NexaCopy): string {
  return c.memberIdHint(NEXA_MEMBER_ID_DIGITS);
}

// Le bouton « ❓ J'ai une question » est présent à CHAQUE étape (§2 du brief) :
// il notifie l'admin et logge l'étape où le lead a bloqué.
function questionBtn(c: NexaCopy) {
  return { text: c.btn.question, callback_data: "nf_q" };
}

function withQuestion(c: NexaCopy, rows: any[][]): any[][] {
  return [...rows, [questionBtn(c)]];
}

/** Clavier de l'étape 2 : « Mon ID Player » (ForceReply) + « J'ai une question ». */
function signupKeyboard(c: NexaCopy): any[][] {
  return [[{ text: c.btn.myId, callback_data: "nf_myid" }], [questionBtn(c)]];
}

/**
 * Sélecteur de langue — posé AVANT le message d'accueil, tant que le lead n'a
 * jamais choisi (`lang_chosen_at` NULL). Le texte est multilingue : à cet instant
 * précis on ne sait justement pas quelle langue il parle.
 */
async function sendLangPicker(chatId: number) {
  await dmKeyboard(chatId, langPromptText(), langKeyboard(NEXA_LANG_CB_PREFIX));
}

async function sendWelcome(chatId: number, lang: Lang) {
  const c = nexaCopy(lang);
  await dmKeyboard(chatId,
    c.welcome({ room: NEXA_ROOM_LABEL, code: NEXA_BONUS_CODE }),
    withQuestion(c, [
      [{ text: c.btn.go, callback_data: "nf_go" }],
      [{ text: c.btn.deal, callback_data: "nf_deal" }],
    ])
  );
}

/** Transparence business — le lead reste à `started` tant qu'il n'a pas cliqué « C'est parti ». */
async function sendDealExplainer(chatId: number, lang: Lang) {
  const c = nexaCopy(lang);
  await dmKeyboard(chatId, c.dealExplainer,
    withQuestion(c, [[{ text: c.btn.go, callback_data: "nf_go" }]])
  );
}

async function sendDownloadStep(chatId: number, lang: Lang) {
  const c = nexaCopy(lang);
  // Les labels d'OS (🪟 Windows…) sont neutres : identiques dans toutes les langues.
  await dmKeyboard(chatId, c.downloadStep,
    withQuestion(c, [
      [{ text: NEXA_DOWNLOADS.windows.label, callback_data: "nf_os:windows" }],
      [{ text: NEXA_DOWNLOADS.android.label, callback_data: "nf_os:android" }],
      [{ text: NEXA_DOWNLOADS.mac.label, callback_data: "nf_os:mac" }],
    ])
  );
}

/** Bloc « crée ton compte » — commun au message combiné et aux relances. */
function signupBlock(c: NexaCopy): string {
  return c.signupBlock({ code: NEXA_BONUS_CODE, hint: memberIdHint(c) });
}

/**
 * Message COMBINÉ lien de téléchargement + création de compte (Hugo 2026-07-24).
 * Le clic sur la plateforme vaut confirmation d'installation : il n'y a plus de
 * bouton « App installée ✅ ». Identique pour Windows / Android / Mac — seule la
 * première ligne change. `os` null (OS inconnu, vieux lead) → bloc compte seul.
 */
function downloadHead(c: NexaCopy, os: NexaOs | null): string {
  if (!os) return "";
  return c.downloadHead({ label: NEXA_DOWNLOADS[os].label, url: NEXA_DOWNLOADS[os].url });
}

async function sendDownloadAndSignup(chatId: number, lang: Lang, os: NexaOs | null) {
  const c = nexaCopy(lang);
  await dmKeyboard(chatId, downloadHead(c, os) + signupBlock(c), signupKeyboard(c));
}

async function sendDepositStep(chatId: number, lang: Lang) {
  const c = nexaCopy(lang);
  await dmKeyboard(chatId, c.depositStep({ room: NEXA_ROOM_LABEL }),
    withQuestion(c, [[{ text: c.btn.deposit, callback_data: "nf_deposit" }]])
  );
}

async function sendGroupReady(chatId: number, lang: Lang, link: string) {
  const c = nexaCopy(lang);
  await dmKeyboard(chatId, c.groupReady, [[{ text: c.btn.joinGroup, url: link }]]);
}

/** Rappel du lien de groupe — message léger, sans le 🎉 d'accueil. */
async function sendChannelLink(chatId: number, lang: Lang, link: string) {
  const c = nexaCopy(lang);
  await dmKeyboard(chatId, c.hereIsChannel, [[{ text: c.btn.joinGroup, url: link }]]);
}

/**
 * Annonce du groupe — EXACTEMENT UNE FOIS par lead (fix du double message).
 * La garde est un UPDATE conditionnel : deux exécutions concurrentes du même
 * callback (webhook rejoué par Telegram) ne peuvent pas toutes les deux gagner.
 */
async function announceGroupOnce(leadId: number, chatId: number, lang: Lang, link: string) {
  const claimed = getDb().prepare(
    `UPDATE nexa_leads SET group_announced_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND group_announced_at IS NULL`
  ).run(leadId);
  if (claimed.changes === 0) return; // déjà annoncé → on ne renvoie rien
  await sendGroupReady(chatId, lang, link);
}

/** Renvoie le prompt de l'étape courante (reprise après /start ou relance). */
async function sendCurrentStep(chatId: number, lead: NexaLead) {
  const lang = leadLang(lead);
  switch (lead.stage) {
    case "started":
      await sendWelcome(chatId, lang); return;
    case "app_installed":
      await sendDownloadAndSignup(chatId, lang, (lead.os as NexaOs | null) ?? null); return;
    case "account_created":
      await sendDepositStep(chatId, lang); return;
    default:
      // Dépôt fait / vérifié / joue : plus rien à demander. Message léger — le 🎉
      // d'accueil du groupe ne part qu'une seule fois (announceGroupOnce).
      if (lead.group_invite_link) {
        await sendChannelLink(chatId, lang, lead.group_invite_link);
        return;
      }
      await dmMsg(chatId, nexaCopy(lang).allSet({ handle: SUPPORT_HANDLE }));
  }
}

// ── /start nexa ───────────────────────────────────────────

export async function handleNexaFunnelStart(chatId: number, from: any, payload?: string) {
  const db = getDb();
  const tgId: number = from?.id ?? chatId;
  const username = from?.username ?? null;
  const firstName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || null;
  // "nexa" → direct ; "nexa_ig" → source "ig".
  const source = (payload && payload.includes("_")) ? payload.slice(payload.indexOf("_") + 1) : "direct";

  const existing = getNexaLeadByTgId(tgId);
  if (existing) {
    db.prepare(
      `UPDATE nexa_leads SET tg_username = ?, first_name = ?, blocked = 0,
        last_interaction_at = datetime('now'), updated_at = datetime('now') WHERE tg_user_id = ?`
    ).run(username, firstName, tgId);
    // Le sélecteur n'est reposé qu'à un lead qui n'a RIEN commencé : les leads
    // créés avant la feature (lang_chosen_at NULL, déjà à mi-parcours) reprennent
    // leur étape en français au lieu de se voir interrompus par une question.
    if (!existing.lang_chosen_at && existing.stage === "started") {
      await sendLangPicker(chatId);
      return;
    }
    await sendCurrentStep(chatId, existing);
    return;
  }

  // La SOURCE est écrite ici, avant tout choix de langue : le callback nf_lang:*
  // ne fait qu'un UPDATE de `lang`, il ne touche jamais `source`. Un lead venu de
  // ?start=nexa_ig reste attribué à « ig » quelle que soit la langue choisie.
  const info = db.prepare(
    `INSERT INTO nexa_leads (tg_user_id, tg_username, first_name, source, stage, started_at, last_interaction_at)
     VALUES (?, ?, ?, ?, 'started', datetime('now'), datetime('now'))`
  ).run(tgId, username, firstName, source);
  const leadId = Number(info.lastInsertRowid);
  logNexaEvent(leadId, "stage_change", { stage: "started", actor: "bot", payload: `source=${source}` });

  // Sélecteur de langue AVANT le message d'accueil : le welcome part depuis le
  // callback nf_lang:*, dans la langue choisie.
  await sendLangPicker(chatId);
  await sendMsg(AGENT_CHAT_ID,
    `🚀 <b>Nexa Funnel</b> — nouveau lead : <b>${username ? `@${username}` : (firstName ?? `tg:${tgId}`)}</b> ` +
    `(tg_id <code>${tgId}</code> · source <code>${source}</code>)`
  ).catch(() => {});
}

// ── Callbacks nf_* ────────────────────────────────────────

/** Libellé lisible d'un bouton — pour la ligne de traçage du chat admin. */
function callbackLabel(data: string, c: NexaCopy): string {
  if (data.startsWith(NEXA_LANG_CB_PREFIX)) return "choix de langue";
  const known: Record<string, string> = {
    nf_q: c.btn.question, nf_deal: c.btn.deal, nf_myid: c.btn.myId,
    nf_go: c.btn.go, nf_deposit: c.btn.deposit, nf_installed: "App installée",
  };
  if (known[data]) return known[data];
  const os = data.match(/^nf_os:(windows|android|mac)$/);
  if (os) return NEXA_DOWNLOADS[os[1] as NexaOs].label;
  return data;
}

export async function handleNexaFunnelCallback(callbackId: string, data: string, chatId: number, from: any) {
  await answerCbQuery(callbackId);
  const tgId: number = from?.id ?? chatId;
  const lead = getNexaLeadByTgId(tgId);
  if (!lead) {
    // Pas de lead → pas de langue connue. Repli DEFAULT_LANG assumé.
    await dmMsg(chatId, nexaCopy(undefined).noLead);
    return;
  }
  const db = getDb();
  const lang = leadLang(lead);
  const c = nexaCopy(lang);

  // Un clic de bouton reste FONCTIONNEL pendant un takeover (décision Hugo) : un
  // lead qui pilote lui-même ne doit pas rester sans réponse parce qu'un humain a
  // la main. En contrepartie l'opérateur voit passer une ligne dans le chat admin,
  // pour ne pas avoir à deviner ce que le bot vient d'envoyer par-dessus lui.
  // Non bloquant : si la notif échoue, le scénario continue.
  void notifyAutoReplyDuringTakeover(lead.id, callbackLabel(data, c)).catch(() => {});

  // 🌍 Choix de langue — pilote TOUT le reste du funnel. Traité en premier, et
  // idempotent : re-cliquer réécrit la même langue et rejoue l'accueil.
  const picked = parseLangCallback(data, NEXA_LANG_CB_PREFIX);
  if (picked) {
    db.prepare(
      `UPDATE nexa_leads SET lang = ?, lang_chosen_at = datetime('now'),
        last_interaction_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(picked, lead.id);
    logNexaEvent(lead.id, "admin", { stage: lead.stage, actor: "bot", payload: `lang=${picked}` });
    // Le sélecteur précède l'accueil pour un nouveau lead ; si un lead déjà avancé
    // rechoisit sa langue, on lui rejoue son étape courante plutôt que l'accueil.
    if (lead.stage === "started") await sendWelcome(chatId, picked);
    else await sendCurrentStep(chatId, { ...lead, lang: picked });
    return;
  }

  // ❓ Question — le bot ne promet plus de répondre « ici » (personne ne voyait la
  // question) : il renvoie le lead en DM vers SUPPORT_HANDLE. Le log reste identique
  // (compteur par étape dans l'historique du lead), mais la notif admin part à CHAQUE
  // clic et non plus une fois par étape : c'est le signal d'entrée d'Hugo, un DM raté
  // est un lead perdu. Le coût d'une notif en double est nul comparé à celui d'un silence.
  if (data === "nf_q") {
    logNexaEvent(lead.id, "question", { stage: lead.stage, actor: "bot" });
    touchInteraction(lead.id);
    await dmMsg(chatId, c.questionAck({ handle: SUPPORT_HANDLE }));
    await sendMsg(AGENT_CHAT_ID,
      `❓ <b>Nexa Funnel</b> — <b>${leadName(lead)}</b> a une question\n` +
      `Étape : <code>${lead.stage}</code> · tg_id <code>${lead.tg_user_id}</code>\n` +
      `→ redirigé vers @${SUPPORT_HANDLE}`
    ).catch(() => {});
    // Post ANCRÉ dans le chat admin : depuis le live takeover, Hugo peut répondre
    // directement dessus et le lead reçoit la réponse dans sa conversation avec le
    // bot, sans avoir à ouvrir un DM séparé.
    await postAnchoredNotice(lead.id,
      `❓ a cliqué « ${esc(c.btn.question)} »\n<i>Réponds à ce message : le lead le recevra du bot.</i>`
    ).catch(() => {});
    return;
  }

  // 💡 « C'est quoi le deal ? » — loggé comme les questions, ne fait PAS avancer
  // le lead : il reste à `started` tant qu'il n'a pas cliqué « C'est parti ».
  if (data === "nf_deal") {
    logNexaEvent(lead.id, "question", { stage: lead.stage, actor: "bot", payload: "deal" });
    touchInteraction(lead.id);
    await sendDealExplainer(chatId, lang);
    return;
  }

  // 📝 « Mon ID Player » — ouvre le champ de réponse du lead via ForceReply. La
  // capture de l'ID passe par le même chemin que la saisie libre (handleNexaFunnelDm) :
  // les deux marchent, validation 7 chiffres inchangée.
  if (data === "nf_myid") {
    touchInteraction(lead.id);
    await dmForceReply(chatId, c.myIdPrompt({ hint: memberIdHint(c) }));
    return;
  }

  if (data === "nf_go") {
    touchInteraction(lead.id);
    await sendDownloadStep(chatId, lang);
    return;
  }

  // Choix de la plateforme = confirmation d'installation : on enregistre l'OS,
  // on marque app_installed, et on envoie le message combiné (lien + compte).
  // Comportement identique pour les trois OS.
  const osMatch = data.match(/^nf_os:(windows|android|mac)$/);
  if (osMatch) {
    const os = osMatch[1] as NexaOs;
    db.prepare(`UPDATE nexa_leads SET os = ?, updated_at = datetime('now') WHERE id = ?`).run(os, lead.id);
    recordMilestone(lead.id, "app_installed", "bot");
    await sendDownloadAndSignup(chatId, lang, os);
    return;
  }

  // Legacy : bouton « App installée ✅ » des messages envoyés avant le passage au
  // message combiné. Conservé pour ne pas laisser un vieux message sans effet.
  if (data === "nf_installed") {
    recordMilestone(lead.id, "app_installed", "bot");
    const fresh = getNexaLeadByTgId(tgId);
    if (fresh && NEXA_STAGE_ORDER[fresh.stage] > NEXA_STAGE_ORDER.app_installed) {
      await sendCurrentStep(chatId, fresh);
    } else {
      await sendDownloadAndSignup(chatId, lang, (fresh?.os as NexaOs | null) ?? null);
    }
    return;
  }

  if (data === "nf_deposit") {
    touchInteraction(lead.id);
    // Groupe déjà là → on redonne juste le lien (message léger, pas le 🎉 d'accueil
    // qui, lui, ne part qu'une fois via announceGroupOnce).
    if (lead.group_invite_link) {
      await sendChannelLink(chatId, lang, lead.group_invite_link);
      return;
    }

    await dmMsg(chatId, c.depositPreparing);

    // FIX du double message : la création (CreateChat + MigrateChat + 5 topics +
    // seed + invite) dépassait le délai du webhook, que Telegram rejouait ensuite.
    // On rend la main IMMÉDIATEMENT et on crée en tâche de fond ; le verrou dans
    // ensureNexaGroup empêche de toute façon deux créations concurrentes.
    void ensureNexaGroup(lead.id, "bot")
      .then(async (res) => {
        if (res.ok && res.link) await announceGroupOnce(lead.id, chatId, lang, res.link);
        else if (!res.pending) {
          await dmMsg(chatId, c.groupFailed).catch(() => {});
        }
      })
      .catch((e) => console.error(`[NEXA] group flow failed for lead ${lead.id}:`, e?.message ?? e));
    return;
  }
}

// ── Capture de l'ID joueur en DM ──────────────────────────
// Appelé par le dispatcher du webhook pour tout texte privé non-commande.
// Retourne true si le message a été consommé par le funnel Nexa.

export async function handleNexaFunnelDm(chatId: number, fromId: number, text: string): Promise<boolean> {
  const lead = getNexaLeadByTgId(fromId);
  if (!lead) return false;
  const lang = leadLang(lead);
  const c = nexaCopy(lang);

  // Takeover actif : le bot se TAIT sur le texte libre. Le message a déjà été
  // capturé et relayé dans le chat admin par le webhook ; laisser le scénario
  // répondre par-dessus ferait parler deux voix au lead. Le message est consommé
  // (true) pour qu'aucun autre handler ne reprenne la main.
  // Garde de défense en profondeur : le webhook coupe déjà en amont.
  if (isTakeoverActiveForTgId(fromId)) return true;

  // Pas encore de langue choisie et rien de commencé → on repose le sélecteur
  // plutôt que d'entamer la séquence dans une langue qu'il n'a pas demandée.
  if (!lead.lang_chosen_at && lead.stage === "started") {
    await sendLangPicker(chatId);
    touchInteraction(lead.id);
    return true;
  }

  // Avant l'étape ID, les boutons pilotent : on renvoie l'étape courante.
  if (NEXA_STAGE_ORDER[lead.stage] < NEXA_STAGE_ORDER.app_installed) {
    await sendCurrentStep(chatId, lead);
    touchInteraction(lead.id);
    return true;
  }
  // ID déjà fourni : on ne parse plus rien, on route vers l'humain.
  if (lead.member_id) {
    await dmMsg(chatId, c.idAlreadyKnown({ handle: SUPPORT_HANDLE }));
    touchInteraction(lead.id);
    return true;
  }

  const candidate = text.trim();
  if (!NEXA_MEMBER_ID_RE.test(candidate)) {
    await dmMsg(chatId, c.idBadFormat({ hint: memberIdHint(c) }));
    touchInteraction(lead.id);
    return true;
  }

  const db = getDb();
  // Unicité : un ID déjà pris par un AUTRE lead n'écrase rien → flag + alerte admin.
  const owner = db.prepare(`SELECT id FROM nexa_leads WHERE member_id = ? AND id != ?`).get(candidate, lead.id) as { id: number } | undefined;
  if (owner) {
    db.prepare(`UPDATE nexa_leads SET duplicate_id = 1, last_interaction_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(lead.id);
    logNexaEvent(lead.id, "admin", { stage: lead.stage, actor: "bot", payload: `duplicate_id:${candidate} (lead #${owner.id})` });
    await dmMsg(chatId, c.idDuplicate);
    await sendMsg(AGENT_CHAT_ID,
      `⚠️ <b>Nexa Funnel</b> — ID en double\n` +
      `<b>${leadName(lead)}</b> (tg_id <code>${lead.tg_user_id}</code>) a envoyé l'ID <code>${candidate}</code>, ` +
      `déjà rattaché au lead #${owner.id}. Rien n'a été écrasé.`
    ).catch(() => {});
    return true;
  }

  db.prepare(`UPDATE nexa_leads SET member_id = ?, updated_at = datetime('now') WHERE id = ?`).run(candidate, lead.id);
  recordMilestone(lead.id, "account_created", "bot");

  await dmMsg(chatId, c.idSaved({ id: candidate }));
  await sendDepositStep(chatId, lang);

  await sendMsg(AGENT_CHAT_ID,
    `📝 <b>Nexa Funnel</b> — <b>${leadName(lead)}</b> a créé son compte\n` +
    `ID joueur : <code>${candidate}</code>`
  ).catch(() => {});

  return true;
}

// ── Groupe privé (userbot) ────────────────────────────────
// L'API Bot ne peut pas créer de groupe ; le userbot GramJS du repo si (il le fait
// déjà pour l'onboarding joueur). Idempotent : un lead qui a déjà un groupe ne peut
// pas en déclencher un second. En cas d'échec (userbot HS, CHANNELS_TOO_MUCH…),
// l'admin est notifié pour créer le groupe à la main — le lead n'est jamais bloqué.

export async function ensureNexaGroup(
  leadId: number, actor: Actor = "bot",
): Promise<{ ok: boolean; link?: string; error?: string; pending?: boolean }> {
  const lead = getNexaLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  if (lead.group_invite_link) return { ok: true, link: lead.group_invite_link };

  // DOUBLON INTER-FUNNEL (audit Hugo 2026-07-25) : ce lead peut déjà avoir un groupe
  // LeCercle créé par le funnel joueur — Hakim AMIRUL et Phua avaient chacun 2 groupes
  // vivants pour cette raison. On réutilise le groupe existant (mêmes 5 topics, dont
  // Dépôt) plutôt que d'en créer un second. Pas de re-seed des topics, pas d'écriture
  // dans `group_creations` : ce groupe est déjà suivi côté joueur.
  const { findExistingGroupForTgUser, ensureInviteLink } = await import("@/lib/group-lifecycle");
  const already = findExistingGroupForTgUser(lead.tg_user_id);
  if (already) {
    const link = await ensureInviteLink(already.chatId, already.inviteLink);
    if (link) {
      getDb().prepare(
        `UPDATE nexa_leads SET group_chat_id = ?, group_invite_link = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(already.chatId, link, lead.id);
      logNexaEvent(lead.id, "group_created", {
        stage: lead.stage, actor,
        payload: `réutilisation du groupe existant ${already.chatId} (source ${already.source}) — pas de doublon`,
      });
      await sendMsg(AGENT_CHAT_ID,
        `♻️ <b>Nexa Funnel</b> — <b>${leadName(lead)}</b> avait déjà un groupe LeCercle : on le réutilise ` +
        `(<code>${already.chatId}</code>), aucun second groupe créé.`
      ).catch(() => {});
      return { ok: true, link };
    }
  }

  // VERROU ATOMIQUE : une seule exécution crée le groupe. Un webhook rejoué (ou un
  // double clic) perd la course et repart en `pending` sans rien envoyer ni créer.
  // Le verrou expire après 5 min pour ne pas bloquer un retry après un vrai crash.
  const claim = getDb().prepare(`
    UPDATE nexa_leads SET group_claimed_at = datetime('now'), updated_at = datetime('now')
    WHERE id = ? AND group_chat_id IS NULL
      AND (group_claimed_at IS NULL OR (julianday('now') - julianday(group_claimed_at)) * 1440 > 5)
  `).run(leadId);
  if (claim.changes === 0) return { ok: false, pending: true, error: "Création déjà en cours" };

  const display = lead.first_name || lead.tg_username || `Lead ${lead.id}`;
  try {
    const { createPlayerGroup } = await import("@/lib/telegram-userbot");
    // Pas de suffixe d'agent : même format que les groupes existants « X x LeCercle ».
    const res = await createPlayerGroup(
      lead.tg_user_id,
      display,
      process.env.TELEGRAM_BOT_TOKEN,
      lead.tg_username ?? undefined,
    );
    if (!res || !res.inviteLink) {
      const err = res?.errors?.join("; ") || "userbot indisponible";
      // Verrou relâché : l'admin peut relancer depuis la fiche lead.
      getDb().prepare(`UPDATE nexa_leads SET group_claimed_at = NULL WHERE id = ?`).run(leadId);
      await notifyGroupFailure(lead, err);
      return { ok: false, error: err };
    }

    getDb().prepare(
      `UPDATE nexa_leads SET group_chat_id = ?, group_invite_link = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(String(res.chatId), res.inviteLink, lead.id);
    logNexaEvent(lead.id, "group_created", { stage: lead.stage, actor, payload: String(res.chatId) });

    // Registre partagé : arme le nettoyage 24 h si le lead ne rejoint jamais son canal.
    const { recordGroupCreation } = await import("@/lib/group-lifecycle");
    recordGroupCreation({
      chatId: res.chatId,
      ownerKind: "nexa_lead",
      ownerKey: lead.tg_user_id,
      ownerLabel: leadName(lead),
      title: `${display} x LeCercle`,
      inviteLink: res.inviteLink,
      topicIds: res.topicIds,
    });

    // Seed des topics — mêmes templates que les groupes existants (TOPIC_MESSAGES),
    // notamment le topic Dépôt avec les coordonnées bancaires/crypto. Le bot est
    // promu admin avant la création des topics, donc il poste même dans les topics
    // fermés en lecture seule.
    try {
      const { TOPIC_MESSAGES } = await import("@/lib/telegram-commands/onboarding");
      for (const [key, msg] of Object.entries(TOPIC_MESSAGES)) {
        const topicId = res.topicIds[key];
        if (topicId) await sendMsg(res.chatId, msg, topicId);
      }
    } catch (e: any) {
      console.error(`[NEXA] topic seeding failed for lead ${lead.id}:`, e?.message ?? e);
    }

    // Retry lancé depuis le back-office : le lead n'a jamais reçu son lien → on le
    // lui envoie ici (le chemin bot, lui, annonce côté appelant).
    if (actor === "admin") await announceGroupOnce(lead.id, lead.tg_user_id, leadLang(lead), res.inviteLink);

    await sendMsg(AGENT_CHAT_ID,
      `🔐 <b>Nexa Funnel</b> — groupe dépôt créé pour <b>${leadName(lead)}</b>\n` +
      `ID joueur : <code>${lead.member_id ?? "—"}</code>\n` +
      `Groupe : ${res.inviteLink}` +
      (res.status !== "full_success" ? `\n⚠️ statut userbot : ${res.status} (${res.failedSteps.join(", ")})` : "")
    ).catch(() => {});

    return { ok: true, link: res.inviteLink };
  } catch (e: any) {
    const err = e?.message ?? String(e);
    console.error(`[NEXA] group creation failed for lead ${lead.id}:`, err);
    getDb().prepare(`UPDATE nexa_leads SET group_claimed_at = NULL WHERE id = ?`).run(leadId);
    await notifyGroupFailure(lead, err);
    return { ok: false, error: err };
  }
}

async function notifyGroupFailure(lead: NexaLead, error: string) {
  await sendMsg(AGENT_CHAT_ID,
    `❌ <b>Nexa Funnel</b> — création du groupe impossible pour <b>${leadName(lead)}</b>\n` +
    `tg_id <code>${lead.tg_user_id}</code> · ID joueur <code>${lead.member_id ?? "—"}</code>\n` +
    `Erreur : <code>${error}</code>\n\n` +
    `👉 Crée le groupe à la main, ou relance depuis la fiche lead (bouton « Créer le groupe »).`
  ).catch(() => {});
}

// ── Promotions à l'import hebdo ───────────────────────────
// Premier match d'un Member ID → room_verified (+ played si rake > 0) + message bot.

export async function applyNexaImportPromotions(
  rows: { member_id: string; rake: number }[],
): Promise<{ newlyVerified: number; newlyPlayed: number }> {
  const db = getDb();
  let newlyVerified = 0, newlyPlayed = 0;

  for (const row of rows) {
    const lead = db.prepare(`SELECT * FROM nexa_leads WHERE member_id = ?`).get(row.member_id) as NexaLead | undefined;
    if (!lead) continue;

    const wasVerified = !!lead.verified_at;
    recordMilestone(lead.id, "room_verified", "import");
    if (row.rake > 0) {
      if (recordMilestone(lead.id, "played", "import")) newlyPlayed++;
    }

    if (!wasVerified) {
      newlyVerified++;
      await sendDmRaw(lead.tg_user_id, nexaCopy(lead.lang).roomConfirmed).catch(() => {});
    }
  }

  return { newlyVerified, newlyPlayed };
}

// ── Relances automatiques ─────────────────────────────────
// Leads bloqués sur started / app_installed / account_created : J+1, J+3, J+7 après
// la dernière interaction. Après la 3ᵉ relance sans réponse → flag `cold`, on lâche.

/**
 * Envoi AUTOMATIQUE au lead (relances, confirmations, promotions d'import).
 *
 * Point de passage unique de tout ce que le système envoie sans que le lead l'ait
 * demandé — donc l'endroit où le takeover doit couper (§4 du brief). Les réponses
 * aux clics de bouton ne passent PAS par ici : elles restent actives.
 * `skipped` distingue « pas envoyé parce qu'un humain a la main » d'un vrai échec.
 */
async function sendDmRaw(tgId: number, text: string, keyboard?: any[][]): Promise<{ ok: boolean; status: number; skipped?: boolean }> {
  if (isTakeoverActiveForTgId(tgId)) {
    console.log(`[NEXA] envoi auto supprimé — takeover actif sur tg_id=${tgId}`);
    return { ok: false, status: 0, skipped: true };
  }
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, status: 0 };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: tgId, text, parse_mode: "HTML",
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }),
  });
  if (res.ok) {
    const json = await res.json().catch(() => null);
    logLeadOutbound(tgId, text, json?.result?.message_id);
  }
  return { ok: res.ok, status: res.status };
}

function reminderContent(lead: NexaLead): { text: string; keyboard?: any[][] } {
  const c = nexaCopy(lead.lang);
  if (lead.stage === "started") {
    return {
      text: c.reminderStarted({ room: NEXA_ROOM_LABEL, code: NEXA_BONUS_CODE }),
      keyboard: withQuestion(c, [[{ text: c.btn.go, callback_data: "nf_go" }]]),
    };
  }
  // A choisi son OS mais n'a pas envoyé son ID → on rejoue le message combiné
  // (lien de SON OS + création de compte), précédé d'un nudge.
  if (lead.stage === "app_installed") {
    return {
      text: c.reminderInstalled + downloadHead(c, (lead.os as NexaOs | null) ?? null) + signupBlock(c),
      keyboard: signupKeyboard(c),
    };
  }
  return {
    text: c.reminderDeposit,
    keyboard: withQuestion(c, [[{ text: c.btn.deposit, callback_data: "nf_deposit" }]]),
  };
}

export async function runNexaFunnelReminders(): Promise<{ sent: number; blocked: number; cold: number; skipped: number }> {
  const db = getDb();
  const stuck = db.prepare(`
    SELECT *,
      (julianday('now') - julianday(COALESCE(last_interaction_at, created_at))) * 24 AS hours_stuck,
      CASE WHEN last_reminder_at IS NULL THEN 999999
           ELSE (julianday('now') - julianday(last_reminder_at)) * 24 END AS hours_since_reminder
    FROM nexa_leads
    WHERE stage IN ('started','app_installed','account_created')
      AND blocked = 0 AND cold = 0 AND relances_count < ?
      -- /stop dans le chat admin : exclusion définitive, indépendante du flag cold
      -- (qui, lui, est remis à 0 dès que le lead avance d'une étape).
      AND relances_off = 0
      -- Takeover actif : un humain a la main, rien d'automatique ne part.
      AND (takeover_until IS NULL OR takeover_until <= datetime('now'))
  `).all(NEXA_MAX_REMINDERS) as Array<NexaLead & { hours_stuck: number; hours_since_reminder: number }>;

  let sent = 0, blockedCount = 0, coldCount = 0, skipped = 0;
  for (const lead of stuck) {
    const threshold = NEXA_REMINDER_THRESHOLDS_H[lead.relances_count] ?? Infinity;
    if (lead.hours_stuck < threshold || lead.hours_since_reminder < NEXA_REMINDER_MIN_GAP_H) { skipped++; continue; }

    const { text, keyboard } = reminderContent(lead);
    try {
      const res = await sendDmRaw(lead.tg_user_id, text, keyboard);
      if (res.ok) {
        const next = lead.relances_count + 1;
        const goesCold = next >= NEXA_MAX_REMINDERS ? 1 : 0;
        db.prepare(
          `UPDATE nexa_leads SET relances_count = ?, last_reminder_at = datetime('now'), cold = ?, updated_at = datetime('now') WHERE id = ?`
        ).run(next, goesCold, lead.id);
        logNexaEvent(lead.id, "reminder", { stage: lead.stage, actor: "bot", payload: `#${next}` });
        sent++;
        if (goesCold) coldCount++;
      } else if (res.status === 403) {
        db.prepare(`UPDATE nexa_leads SET blocked = 1, updated_at = datetime('now') WHERE id = ?`).run(lead.id);
        blockedCount++;
      } else {
        skipped++;
      }
    } catch (e: any) {
      console.error(`[NEXA] reminder failed for tg_id=${lead.tg_user_id}:`, e?.message ?? e);
      skipped++;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  return { sent, blocked: blockedCount, cold: coldCount, skipped };
}

/** Relance déclenchée à la main depuis la fiche lead (back-office). */
export async function sendNexaManualReminder(leadId: number): Promise<{ ok: boolean; error?: string }> {
  const lead = getNexaLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  if (lead.blocked) return { ok: false, error: "Ce lead a bloqué le bot." };
  if (lead.relances_off) return { ok: false, error: "Relances désactivées sur ce lead (/stop)." };
  // Une relance manuelle reste une relance : elle ne doit pas s'inviter au milieu
  // d'une conversation humaine. L'opérateur reprend la main avec /bot s'il la veut.
  if (isTakeoverActiveForTgId(lead.tg_user_id)) {
    return { ok: false, error: `Takeover actif jusqu'à ${lead.takeover_until} — envoie /bot dans le chat admin pour rendre la main au scénario.` };
  }

  const { text, keyboard } = reminderContent(lead);
  const res = await sendDmRaw(lead.tg_user_id, text, keyboard);
  if (!res.ok) {
    if (res.status === 403) {
      getDb().prepare(`UPDATE nexa_leads SET blocked = 1, updated_at = datetime('now') WHERE id = ?`).run(leadId);
      return { ok: false, error: "Le lead a bloqué le bot (flagué)." };
    }
    return { ok: false, error: `Telegram HTTP ${res.status}` };
  }
  getDb().prepare(
    `UPDATE nexa_leads SET relances_count = relances_count + 1, last_reminder_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(leadId);
  logNexaEvent(leadId, "reminder", { stage: lead.stage, actor: "admin", payload: "manuelle" });
  return { ok: true };
}

// ── Actions admin ─────────────────────────────────────────

/** « Marquer dépôt fait » — jamais déclaré par le lead lui-même (§2 du brief). */
export async function markNexaDepositDone(leadId: number): Promise<{ ok: boolean; error?: string; warning?: string }> {
  const lead = getNexaLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  if (lead.deposit_at) return { ok: true }; // idempotent
  // Le palier est enregistré DANS TOUS LES CAS (le tracking d'étapes ne dépend pas
  // du takeover) ; seul le message de confirmation au lead peut être supprimé.
  recordMilestone(leadId, "deposit_done", "admin");
  const res = await sendDmRaw(lead.tg_user_id, nexaCopy(lead.lang).depositConfirmed).catch(() => null);
  if (res?.skipped) {
    return { ok: true, warning: "Étape enregistrée, mais la confirmation n'a pas été envoyée : takeover actif. Annonce-lui toi-même, ou /bot pour rendre la main." };
  }
  return { ok: true };
}

export function saveNexaNotes(leadId: number, notes: string): { ok: boolean } {
  getDb().prepare(`UPDATE nexa_leads SET notes = ?, updated_at = datetime('now') WHERE id = ?`).run(notes, leadId);
  return { ok: true };
}

// ── Lectures CRM ──────────────────────────────────────────

export type NexaLeadWithStats = NexaLead & {
  total_rake: number;
  total_deposits: number;
  total_withdrawals: number;
  total_winloss: number;
  weeks_count: number;
  nickname: string | null;
  questions_count: number;
  /** 1 = un message du lead est arrivé après la dernière ouverture du panneau. */
  unread: number;
  messages_count: number;
  /** 1 = un humain a la main sur ce lead en ce moment. */
  takeover_active: number;
};

export function getNexaLeads(): NexaLeadWithStats[] {
  return getDb().prepare(`
    SELECT l.*,
      COALESCE(s.total_rake, 0) AS total_rake,
      COALESCE(s.total_deposits, 0) AS total_deposits,
      COALESCE(s.total_withdrawals, 0) AS total_withdrawals,
      COALESCE(s.total_winloss, 0) AS total_winloss,
      COALESCE(s.weeks_count, 0) AS weeks_count,
      s.nickname AS nickname,
      COALESCE(q.n, 0) AS questions_count,
      COALESCE(m.n, 0) AS messages_count,
      -- Non lu ⇔ il EXISTE un message entrant d'id supérieur au curseur de lecture.
      -- Comparé au contenu réel de bot_messages, pas à une colonne miroir : ni
      -- l'horloge ni l'ordre des écritures ne peuvent faire disparaître une pastille.
      CASE WHEN COALESCE(m.last_in_id, 0) > l.last_read_msg_id THEN 1 ELSE 0 END AS unread,
      CASE WHEN l.takeover_until IS NOT NULL AND l.takeover_until > datetime('now')
           THEN 1 ELSE 0 END AS takeover_active
    FROM nexa_leads l
    LEFT JOIN (
      SELECT lead_id, COUNT(*) AS n,
             MAX(CASE WHEN direction = 'in' THEN id END) AS last_in_id
      FROM bot_messages GROUP BY lead_id
    ) m ON m.lead_id = l.id
    LEFT JOIN (
      SELECT member_id,
        SUM(rake) AS total_rake,
        SUM(deposits) AS total_deposits,
        SUM(withdrawals) AS total_withdrawals,
        SUM(winloss) AS total_winloss,
        COUNT(*) AS weeks_count,
        MAX(nickname) AS nickname
      FROM nexa_weekly_stats GROUP BY member_id
    ) s ON s.member_id = l.member_id
    LEFT JOIN (
      SELECT lead_id, COUNT(*) AS n FROM nexa_lead_events WHERE kind = 'question' GROUP BY lead_id
    ) q ON q.lead_id = l.id
    ORDER BY l.created_at DESC
  `).all() as NexaLeadWithStats[];
}

export type NexaWeeklyStat = {
  member_id: string;
  week_start: string;
  nickname: string | null;
  rake: number;
  deposits: number;
  withdrawals: number;
  winloss: number;
};

export function getNexaWeeklyStats(): NexaWeeklyStat[] {
  return getDb().prepare(`
    SELECT member_id, week_start, nickname, rake, deposits, withdrawals, winloss
    FROM nexa_weekly_stats ORDER BY member_id, week_start
  `).all() as NexaWeeklyStat[];
}

export type NexaLeadEvent = {
  id: number; lead_id: number; kind: string; stage: string | null;
  payload: string | null; actor: string; created_at: string;
};

export function getNexaLeadEvents(): NexaLeadEvent[] {
  return getDb().prepare(
    `SELECT * FROM nexa_lead_events ORDER BY lead_id, created_at`
  ).all() as NexaLeadEvent[];
}
