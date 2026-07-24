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
import { sendMsg, sendMsgKeyboard, answerCbQuery, AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";
import {
  NEXA_ROOM_LABEL, NEXA_BONUS_CODE, NEXA_DOWNLOADS, NEXA_MEMBER_ID_RE, NEXA_MEMBER_ID_HINT,
  NEXA_STAGE_ORDER, NEXA_REMINDER_THRESHOLDS_H, NEXA_MAX_REMINDERS, NEXA_REMINDER_MIN_GAP_H,
  type NexaStage, type NexaOs,
} from "@/lib/funnels/nexa/config";

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
  relances_count: number;
  last_reminder_at: string | null;
  last_interaction_at: string | null;
  duplicate_id: number;
  cold: number;
  blocked: number;
  notes: string | null;
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
// Le bouton « ❓ J'ai une question » est présent à CHAQUE étape (§2 du brief) :
// il notifie l'admin et logge l'étape où le lead a bloqué.
const QUESTION_BTN = { text: "❓ J'ai une question", callback_data: "nf_q" };

function withQuestion(rows: any[][]): any[][] {
  return [...rows, [QUESTION_BTN]];
}

async function sendWelcome(chatId: number) {
  await sendMsgKeyboard(chatId,
    `🃏 <b>Bienvenue au Cercle — Onboarding ${NEXA_ROOM_LABEL}</b>\n\n` +
    `On t'accompagne de A à Z. Voici les 3 étapes :\n\n` +
    `<b>1</b> — 📲 Tu télécharges l'app (30 sec)\n` +
    `<b>2</b> — 📝 Tu crées ton compte avec le code 🎁 <b>${NEXA_BONUS_CODE}</b> et tu m'envoies ton ID\n` +
    `<b>3</b> — 🤝 On crée ton groupe privé avec Hugo &amp; Baki : dépôts et retraits en direct ⚡, suivi perso, et accès à d'autres games qui peuvent te correspondre\n\n` +
    `En bonus : accès au <b>PokerDex</b> 🧠 — notre data AI sur le field pour jouer avec un coup d'avance.\n\n` +
    `Ça prend 5 minutes, on y va 👇`,
    withQuestion([
      [{ text: "C'est parti →", callback_data: "nf_go" }],
      [{ text: "💡 C'est quoi le deal ?", callback_data: "nf_deal" }],
    ])
  );
}

/** Transparence business — le lead reste à `started` tant qu'il n'a pas cliqué « C'est parti ». */
async function sendDealExplainer(chatId: number) {
  await sendMsgKeyboard(chatId,
    `💡 <b>Comment on gagne de l'argent ?</b>\n\n` +
    `La room nous reverse une part du rake que tu génères — c'est elle qui nous paye, pas toi. ` +
    `Jouer via nous te coûte <b>0</b> et te rapporte le bonus + l'accompagnement.\n\n` +
    `Et si un jour ton niveau fait que la room te tag « pro » et coupe le RB, on te proposera un ` +
    `deal d'action ensemble — on investit sur toi, on gagne quand tu gagnes… et on perd quand tu perds, ` +
    `mais j'espère plutôt que tu nous rendras riche lol 🤝\n\n` +
    `Bref : nos intérêts sont alignés avec les tiens dès le jour 1.`,
    withQuestion([[{ text: "C'est parti →", callback_data: "nf_go" }]])
  );
}

async function sendDownloadStep(chatId: number) {
  await sendMsgKeyboard(chatId,
    `<b>Étape 1/3 — Télécharge l'app</b>\n\n` +
    `Sur quoi tu joues ? Choisis ta plateforme 👇`,
    withQuestion([
      [{ text: NEXA_DOWNLOADS.windows.label, callback_data: "nf_os:windows" }],
      [{ text: NEXA_DOWNLOADS.android.label, callback_data: "nf_os:android" }],
      [{ text: NEXA_DOWNLOADS.mac.label, callback_data: "nf_os:mac" }],
    ])
  );
}

/** Bloc « crée ton compte » — commun au message combiné et aux relances. */
function signupBlock(): string {
  return `<b>Étape 2/3 — Crée ton compte</b>\n\n` +
    `Dans l'app, inscris-toi en entrant le code <b>${NEXA_BONUS_CODE}</b>.\n` +
    `Sans ce code, l'agent ne peut pas créditer tes dépôts.\n\n` +
    `📌 <b>Important</b> : Il faut mettre <b>Andorra</b> comme pays de résidence ` +
    `(pas de justificatif de domicile demandé)\n\n` +
    `Et ton Nom, Prénom et date de naissance doivent correspondre exactement à ton ID.\n\n` +
    `Une fois ton compte créé, envoie-moi ton <b>ID joueur</b> (visible dans ton profil) 👇\n\n` +
    `Envoie juste le numéro ici (${NEXA_MEMBER_ID_HINT}).`;
}

/**
 * Message COMBINÉ lien de téléchargement + création de compte (Hugo 2026-07-24).
 * Le clic sur la plateforme vaut confirmation d'installation : il n'y a plus de
 * bouton « App installée ✅ ». Identique pour Windows / Android / Mac — seule la
 * première ligne change. `os` null (OS inconnu, vieux lead) → bloc compte seul.
 */
function downloadHead(os: NexaOs | null): string {
  if (!os) return "";
  return `${NEXA_DOWNLOADS[os].label} — voici ton lien de téléchargement 👇\n${NEXA_DOWNLOADS[os].url}\n\n`;
}

async function sendDownloadAndSignup(chatId: number, os: NexaOs | null) {
  await sendMsgKeyboard(chatId, downloadHead(os) + signupBlock(), [[QUESTION_BTN]]);
}

async function sendDepositStep(chatId: number) {
  await sendMsgKeyboard(chatId,
    `<b>Étape 3/3 — Ton premier dépôt + ton groupe privé</b>\n\n` +
    `${NEXA_ROOM_LABEL} fonctionne en <b>système d'agent</b> : tous les dépôts et retraits passent par nous.\n\n` +
    `Clique ci-dessous : on ouvre ton canal privé avec Hugo &amp; Baki, et tu reçois ton accès <b>PokerDex</b> 🧠 pour la game 👇`,
    withQuestion([[{ text: "💰 Faire mon premier dépôt", callback_data: "nf_deposit" }]])
  );
}

async function sendGroupReady(chatId: number, link: string) {
  await sendMsgKeyboard(chatId,
    `🎉 <b>Bienvenue en direct avec nous</b>\n\n` +
    `C'est ici que se passent <b>tes dépôts et tes retraits</b>. Rejoins le groupe et dis-nous combien tu veux déposer 👇`,
    [[{ text: "🔐 Rejoindre mon canal privé", url: link }]]
  );
}

/**
 * Annonce du groupe — EXACTEMENT UNE FOIS par lead (fix du double message).
 * La garde est un UPDATE conditionnel : deux exécutions concurrentes du même
 * callback (webhook rejoué par Telegram) ne peuvent pas toutes les deux gagner.
 */
async function announceGroupOnce(leadId: number, chatId: number, link: string) {
  const claimed = getDb().prepare(
    `UPDATE nexa_leads SET group_announced_at = datetime('now'), updated_at = datetime('now')
     WHERE id = ? AND group_announced_at IS NULL`
  ).run(leadId);
  if (claimed.changes === 0) return; // déjà annoncé → on ne renvoie rien
  await sendGroupReady(chatId, link);
}

/** Renvoie le prompt de l'étape courante (reprise après /start ou relance). */
async function sendCurrentStep(chatId: number, lead: NexaLead) {
  switch (lead.stage) {
    case "started":
      await sendWelcome(chatId); return;
    case "app_installed":
      await sendDownloadAndSignup(chatId, (lead.os as NexaOs | null) ?? null); return;
    case "account_created":
      await sendDepositStep(chatId); return;
    default:
      // Dépôt fait / vérifié / joue : plus rien à demander. Message léger — le 🎉
      // d'accueil du groupe ne part qu'une seule fois (announceGroupOnce).
      if (lead.group_invite_link) {
        await sendMsgKeyboard(chatId, `Voici ton canal privé 👇`,
          [[{ text: "🔐 Rejoindre mon canal privé", url: lead.group_invite_link }]]);
        return;
      }
      await sendMsg(chatId, `Tout est bon de ton côté 🃏\nUne question ? Écris-nous ici.`);
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
    await sendCurrentStep(chatId, existing);
    return;
  }

  const info = db.prepare(
    `INSERT INTO nexa_leads (tg_user_id, tg_username, first_name, source, stage, started_at, last_interaction_at)
     VALUES (?, ?, ?, ?, 'started', datetime('now'), datetime('now'))`
  ).run(tgId, username, firstName, source);
  const leadId = Number(info.lastInsertRowid);
  logNexaEvent(leadId, "stage_change", { stage: "started", actor: "bot", payload: `source=${source}` });

  await sendWelcome(chatId);
  await sendMsg(AGENT_CHAT_ID,
    `🚀 <b>Nexa Funnel</b> — nouveau lead : <b>${username ? `@${username}` : (firstName ?? `tg:${tgId}`)}</b> ` +
    `(tg_id <code>${tgId}</code> · source <code>${source}</code>)`
  ).catch(() => {});
}

// ── Callbacks nf_* ────────────────────────────────────────

export async function handleNexaFunnelCallback(callbackId: string, data: string, chatId: number, from: any) {
  await answerCbQuery(callbackId);
  const tgId: number = from?.id ?? chatId;
  const lead = getNexaLeadByTgId(tgId);
  if (!lead) {
    await sendMsg(chatId, `Envoie /start pour commencer !`);
    return;
  }
  const db = getDb();

  // ❓ Question — loggée à chaque clic (compteur), notif admin une seule fois par étape.
  if (data === "nf_q") {
    const already = db.prepare(
      `SELECT 1 FROM nexa_lead_events WHERE lead_id = ? AND kind = 'question' AND stage = ? LIMIT 1`
    ).get(lead.id, lead.stage);
    logNexaEvent(lead.id, "question", { stage: lead.stage, actor: "bot" });
    touchInteraction(lead.id);
    await sendMsg(chatId, `👌 C'est noté — on revient vers toi très vite ici.`);
    if (!already) {
      await sendMsg(AGENT_CHAT_ID,
        `❓ <b>Nexa Funnel</b> — <b>${leadName(lead)}</b> a une question\n` +
        `Étape : <code>${lead.stage}</code> · tg_id <code>${lead.tg_user_id}</code>`
      ).catch(() => {});
    }
    return;
  }

  // 💡 « C'est quoi le deal ? » — loggé comme les questions, ne fait PAS avancer
  // le lead : il reste à `started` tant qu'il n'a pas cliqué « C'est parti ».
  if (data === "nf_deal") {
    logNexaEvent(lead.id, "question", { stage: lead.stage, actor: "bot", payload: "deal" });
    touchInteraction(lead.id);
    await sendDealExplainer(chatId);
    return;
  }

  if (data === "nf_go") {
    touchInteraction(lead.id);
    await sendDownloadStep(chatId);
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
    await sendDownloadAndSignup(chatId, os);
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
      await sendDownloadAndSignup(chatId, (fresh?.os as NexaOs | null) ?? null);
    }
    return;
  }

  if (data === "nf_deposit") {
    touchInteraction(lead.id);
    // Groupe déjà là → on redonne juste le lien (message léger, pas le 🎉 d'accueil
    // qui, lui, ne part qu'une fois via announceGroupOnce).
    if (lead.group_invite_link) {
      await sendMsgKeyboard(chatId, `Voici ton canal privé 👇`,
        [[{ text: "🔐 Rejoindre mon canal privé", url: lead.group_invite_link }]]);
      return;
    }

    await sendMsg(chatId,
      `⏳ Top ! Je te prépare ton canal privé avec Hugo &amp; Baki — ça prend jusqu'à 1 minute, ` +
      `ton lien arrive juste en dessous, bouge pas 🤙`
    );

    // FIX du double message : la création (CreateChat + MigrateChat + 5 topics +
    // seed + invite) dépassait le délai du webhook, que Telegram rejouait ensuite.
    // On rend la main IMMÉDIATEMENT et on crée en tâche de fond ; le verrou dans
    // ensureNexaGroup empêche de toute façon deux créations concurrentes.
    void ensureNexaGroup(lead.id, "bot")
      .then(async (res) => {
        if (res.ok && res.link) await announceGroupOnce(lead.id, chatId, res.link);
        else if (!res.pending) {
          await sendMsg(chatId, `On finalise ton accès — un membre de l'équipe te contacte dans la minute 👌`).catch(() => {});
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

  // Avant l'étape ID, les boutons pilotent : on renvoie l'étape courante.
  if (NEXA_STAGE_ORDER[lead.stage] < NEXA_STAGE_ORDER.app_installed) {
    await sendCurrentStep(chatId, lead);
    touchInteraction(lead.id);
    return true;
  }
  // ID déjà fourni : on ne parse plus rien, on route vers l'humain.
  if (lead.member_id) {
    await sendMsg(chatId, `👌 On a bien ton ID. Une question ? On te répond ici.`);
    touchInteraction(lead.id);
    return true;
  }

  const candidate = text.trim();
  if (!NEXA_MEMBER_ID_RE.test(candidate)) {
    await sendMsg(chatId,
      `Hmm, ton ID doit faire ${NEXA_MEMBER_ID_HINT} — tu le trouves dans ton profil dans l'app 👀 Renvoie-le moi.`
    );
    touchInteraction(lead.id);
    return true;
  }

  const db = getDb();
  // Unicité : un ID déjà pris par un AUTRE lead n'écrase rien → flag + alerte admin.
  const owner = db.prepare(`SELECT id FROM nexa_leads WHERE member_id = ? AND id != ?`).get(candidate, lead.id) as { id: number } | undefined;
  if (owner) {
    db.prepare(`UPDATE nexa_leads SET duplicate_id = 1, last_interaction_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(lead.id);
    logNexaEvent(lead.id, "admin", { stage: lead.stage, actor: "bot", payload: `duplicate_id:${candidate} (lead #${owner.id})` });
    await sendMsg(chatId, `⚠️ Cet ID est déjà enregistré chez nous. On vérifie ça et on revient vers toi tout de suite 👌`);
    await sendMsg(AGENT_CHAT_ID,
      `⚠️ <b>Nexa Funnel</b> — ID en double\n` +
      `<b>${leadName(lead)}</b> (tg_id <code>${lead.tg_user_id}</code>) a envoyé l'ID <code>${candidate}</code>, ` +
      `déjà rattaché au lead #${owner.id}. Rien n'a été écrasé.`
    ).catch(() => {});
    return true;
  }

  db.prepare(`UPDATE nexa_leads SET member_id = ?, updated_at = datetime('now') WHERE id = ?`).run(candidate, lead.id);
  recordMilestone(lead.id, "account_created", "bot");

  await sendMsg(chatId,
    `✅ ID enregistré : <code>${candidate}</code>\n\n` +
    `Compte créé, on passe à la suite 👇`
  );
  await sendDepositStep(chatId);

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
    if (actor === "admin") await announceGroupOnce(lead.id, lead.tg_user_id, res.inviteLink);

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
      await sendDmRaw(lead.tg_user_id,
        `✅ <b>Compte confirmé côté room</b>\n\n` +
        `On te suit maintenant automatiquement 🃏\n` +
        `Pour tout dépôt ou retrait, on est là — GL aux tables 🃏`
      ).catch(() => {});
    }
  }

  return { newlyVerified, newlyPlayed };
}

// ── Relances automatiques ─────────────────────────────────
// Leads bloqués sur started / app_installed / account_created : J+1, J+3, J+7 après
// la dernière interaction. Après la 3ᵉ relance sans réponse → flag `cold`, on lâche.

async function sendDmRaw(tgId: number, text: string, keyboard?: any[][]): Promise<{ ok: boolean; status: number }> {
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
  return { ok: res.ok, status: res.status };
}

function reminderContent(lead: NexaLead): { text: string; keyboard?: any[][] } {
  if (lead.stage === "started") {
    return {
      text: `👋 Toujours partant pour ${NEXA_ROOM_LABEL} ?\n\n` +
        `Il te reste juste à télécharger l'app — 2 minutes, et le code <b><code>${NEXA_BONUS_CODE}</code></b> t'attend.`,
      keyboard: withQuestion([[{ text: "C'est parti →", callback_data: "nf_go" }]]),
    };
  }
  // A choisi son OS mais n'a pas envoyé son ID → on rejoue le message combiné
  // (lien de SON OS + création de compte), précédé d'un nudge.
  if (lead.stage === "app_installed") {
    return {
      text: `👋 Il ne manque plus que ton compte !\n\n` +
        downloadHead((lead.os as NexaOs | null) ?? null) + signupBlock(),
      keyboard: [[QUESTION_BTN]],
    };
  }
  return {
    text: `👋 On t'attend pour ton <b>premier dépôt</b> !\n\n` +
      `Chez nous les dépôts et retraits se font en direct, dans ton canal privé. On l'ouvre quand tu veux 👇`,
    keyboard: withQuestion([[{ text: "💰 Faire mon premier dépôt", callback_data: "nf_deposit" }]]),
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
export async function markNexaDepositDone(leadId: number): Promise<{ ok: boolean; error?: string }> {
  const lead = getNexaLeadById(leadId);
  if (!lead) return { ok: false, error: "Lead introuvable" };
  if (lead.deposit_at) return { ok: true }; // idempotent
  recordMilestone(leadId, "deposit_done", "admin");
  await sendDmRaw(lead.tg_user_id,
    `💰 <b>Dépôt confirmé</b> — tu es prêt à jouer !\n\nGL aux tables 🃏`
  ).catch(() => {});
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
      COALESCE(q.n, 0) AS questions_count
    FROM nexa_leads l
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
