// QQPK Funnel — funnel de masse Instagram → bot Telegram, 100% DM, zéro groupe.
// Deep link : https://t.me/LeCercle_Lebot?start=qqpkfunnel
// Étapes : 0 Started → 1 App installée → 2 Dépôt fait → 3 ID reçu → 4 Débloqué.
// AUCUN lien avec le système QQPK staking (cycles/settlements) ni la table players :
// les leads vivent dans qqpk_funnel_leads, donc pas de rappel cashout par construction.
// Les groupes se créent à la main plus tard, quand Hugo voit du volume (funnel normal).
import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, answerCbQuery, AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";

export const QQPK_FUNNEL_LOOM_APP = "https://www.loom.com/share/f84ddf126b0e4f0e8921f8f2a915467e";
export const QQPK_FUNNEL_LOOM_DEPOSIT = "https://www.loom.com/share/e779faa631b54ef391d02fa53af03365";

// Member ID QQPK = numérique (ex: 5666849, 7 chiffres) — on tolère 5 à 10.
export const QQPK_MEMBER_ID_RE = /^\d{5,10}$/;

export type FunnelLead = {
  id: number;
  telegram_id: number;
  username: string | null;
  first_name: string | null;
  stage: number;
  qqpk_member_id: string | null;
  blocked: number;
  reminders_sent: number;
  last_reminder_at: string | null;
  stage1_at: string | null;
  stage2_at: string | null;
  stage3_at: string | null;
  stage4_at: string | null;
  created_at: string;
  updated_at: string;
};

function getLeadByTelegramId(tgId: number): FunnelLead | undefined {
  return getDb().prepare(`SELECT * FROM qqpk_funnel_leads WHERE telegram_id = ?`).get(tgId) as FunnelLead | undefined;
}

function touch(tgId: number) {
  getDb().prepare(`UPDATE qqpk_funnel_leads SET updated_at = datetime('now') WHERE telegram_id = ?`).run(tgId);
}

// ── Messages des étapes ────────────────────────────────────

async function sendStep1(chatId: number) {
  // Value stacking (Hugo 2026-07-22) : répondre à "what's in it for me" dès le
  // premier message — offre irrésistible avant de demander le moindre effort.
  await sendMsgKeyboard(chatId,
    `🃏 <b>Bienvenue au Cercle — QQPK</b>\n\n` +
    `En t'inscrivant via nous, tu obtiens <b>DIRECTEMENT</b> :\n\n` +
    `🎁 <b>20% de rakeback</b> chaque semaine, crédité sur ton compte\n` +
    `💰 <b>Bonus 888$</b> sur ton premier dépôt\n` +
    `📊 <b>Ranges Ante 0.2bb</b> pour exploit le field\n` +
    `🎥 <b>Mindmap avec les Explo du field</b> pour te faire gagner du temps = Argent\n` +
    `🧠 <b>Réponses à tes HH</b> par Baki\n\n` +
    `<b>Étape 1/4 — Installe l'app et inscris-toi</b>\n\n` +
    `🎥 Regarde cette vidéo, tout est dedans :\n${QQPK_FUNNEL_LOOM_APP}\n\n` +
    `Quand ton compte est créé, clique sur le bouton 👇`,
    [[{ text: "✅ App installée", callback_data: "qf_app_ok" }]]
  );
}

async function sendStep2(chatId: number) {
  await sendMsgKeyboard(chatId,
    `<b>Étape 2/4 — Fais ton premier dépôt</b>\n\n` +
    `🎥 Comment déposer (virement bancaire ou crypto) :\n${QQPK_FUNNEL_LOOM_DEPOSIT}\n\n` +
    `Quand ton dépôt est fait, clique sur le bouton 👇`,
    [[{ text: "✅ Dépôt fait", callback_data: "qf_deposit_ok" }]]
  );
}

async function sendStep3(chatId: number) {
  await sendMsg(chatId,
    `<b>Étape 3/4 — Envoie-moi ton ID joueur</b>\n\n` +
    `Tu le trouves dans l'app, onglet <b>ME</b>.\n` +
    `Envoie juste le numéro ici (ex: <code>5666849</code>) 👇`
  );
}

async function sendStep4(chatId: number, memberId: string) {
  await sendMsg(chatId,
    `✅ ID enregistré : <code>${memberId}</code>\n\n` +
    `<b>Étape 4/4 — Tu es prêt 🔓</b>\n\n` +
    `📊 <b>Ranges Ante 0.2bb</b> : 🎥 vidéo à venir\n` +
    `🎰 <b>Live play</b> : 🎥 vidéo à venir\n\n` +
    `GL aux tables 🃏\n` +
    `Des questions ? DM @hugoroine`
  );
}

// Renvoie le prompt de l'étape courante (resume après re-/start ou relance).
async function sendCurrentStep(chatId: number, lead: FunnelLead) {
  if (lead.stage <= 0) await sendStep1(chatId);
  else if (lead.stage === 1) await sendStep2(chatId);
  else if (lead.stage === 2) await sendStep3(chatId);
  else await sendStep4(chatId, lead.qqpk_member_id ?? "?");
}

// ── /start qqpkfunnel ──────────────────────────────────────

export async function handleQqpkFunnelStart(chatId: number, from: any) {
  const db = getDb();
  const tgId: number = from?.id ?? chatId;
  const username = from?.username ?? null;
  const firstName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || null;

  const existing = getLeadByTelegramId(tgId);
  if (existing) {
    // Re-clic sur le deep link → refresh identité + reprise à l'étape courante.
    db.prepare(`UPDATE qqpk_funnel_leads SET username = ?, first_name = ?, blocked = 0, updated_at = datetime('now') WHERE telegram_id = ?`)
      .run(username, firstName, tgId);
    await sendCurrentStep(chatId, existing);
    return;
  }

  db.prepare(`INSERT INTO qqpk_funnel_leads (telegram_id, username, first_name, stage) VALUES (?, ?, ?, 0)`)
    .run(tgId, username, firstName);
  await sendStep1(chatId);

  const who = username ? `@${username}` : (firstName ?? `tg:${tgId}`);
  await sendMsg(AGENT_CHAT_ID, `🚀 <b>QQPK Funnel</b> — nouveau lead : <b>${who}</b> (tg_id <code>${tgId}</code>)`).catch(() => {});
}

// ── Callbacks qf_* ─────────────────────────────────────────

export async function handleQqpkFunnelCallback(callbackId: string, data: string, chatId: number, from: any) {
  await answerCbQuery(callbackId);
  const tgId: number = from?.id ?? chatId;
  const lead = getLeadByTelegramId(tgId);
  if (!lead) {
    await sendMsg(chatId, `Envoie /start pour commencer !`);
    return;
  }

  const db = getDb();

  if (data === "qf_app_ok") {
    if (lead.stage === 0) {
      db.prepare(`UPDATE qqpk_funnel_leads SET stage = 1, stage1_at = datetime('now'), reminders_sent = 0, last_reminder_at = NULL, updated_at = datetime('now') WHERE telegram_id = ?`).run(tgId);
      await sendStep2(chatId);
    } else {
      // Re-clic sur un vieux bouton → on renvoie simplement l'étape courante.
      await sendCurrentStep(chatId, lead);
    }
    return;
  }

  if (data === "qf_deposit_ok") {
    if (lead.stage === 1) {
      db.prepare(`UPDATE qqpk_funnel_leads SET stage = 2, stage2_at = datetime('now'), reminders_sent = 0, last_reminder_at = NULL, updated_at = datetime('now') WHERE telegram_id = ?`).run(tgId);
      await sendStep3(chatId);
    } else if (lead.stage === 0) {
      // A sauté l'étape 1 (vieux message) — on avance quand même, dépôt implique app.
      db.prepare(`UPDATE qqpk_funnel_leads SET stage = 2, stage1_at = COALESCE(stage1_at, datetime('now')), stage2_at = datetime('now'), reminders_sent = 0, last_reminder_at = NULL, updated_at = datetime('now') WHERE telegram_id = ?`).run(tgId);
      await sendStep3(chatId);
    } else {
      await sendCurrentStep(chatId, lead);
    }
    return;
  }
}

// ── Capture de l'ID joueur en DM ───────────────────────────
// Appelé depuis le webhook pour tout texte non-commande en chat privé, AVANT la
// logique de sessions. Retourne true si le message a été consommé par le funnel.

export async function handleQqpkFunnelDm(chatId: number, fromId: number, text: string): Promise<boolean> {
  const lead = getLeadByTelegramId(fromId);
  if (!lead) return false;

  // Avant l'étape ID : les boutons pilotent — on renvoie l'étape courante plutôt
  // que de laisser tomber dans le nudge générique "Envoie /start".
  if (lead.stage < 2) {
    await sendCurrentStep(chatId, lead);
    touch(fromId);
    return true;
  }

  // Funnel terminé : on ne relance rien, on route vers Hugo.
  if (lead.stage >= 3) {
    await sendMsg(chatId, `Des questions ? DM @hugoroine 👍`);
    touch(fromId);
    return true;
  }

  const candidate = text.trim();
  if (!QQPK_MEMBER_ID_RE.test(candidate)) {
    await sendMsg(chatId,
      `❌ Ça ne ressemble pas à un ID joueur.\n` +
      `Envoie juste le numéro (5 à 10 chiffres) — tu le trouves dans l'onglet <b>ME</b> de l'app.`
    );
    touch(fromId);
    return true;
  }

  const db = getDb();
  db.prepare(`
    UPDATE qqpk_funnel_leads
    SET stage = 4, qqpk_member_id = ?, stage3_at = datetime('now'), stage4_at = datetime('now'),
        reminders_sent = 0, last_reminder_at = NULL, updated_at = datetime('now')
    WHERE telegram_id = ?
  `).run(candidate, fromId);

  await sendStep4(chatId, candidate);

  const who = lead.username ? `@${lead.username}` : (lead.first_name ?? `tg:${fromId}`);
  await sendMsg(AGENT_CHAT_ID,
    `🎯 <b>QQPK Funnel</b> — <b>${who}</b> a terminé le funnel (4/4)\n` +
    `ID joueur : <code>${candidate}</code>`
  ).catch(() => {});

  return true;
}

// ── Relances automatiques (cron) ───────────────────────────
// Lead bloqué à une étape < 4 : relance J+1, J+3, J+7 (max 3), puis on lâche.
// Un lead qui avance remet reminders_sent à 0 (fait dans les handlers ci-dessus).
// Bot bloqué par l'utilisateur (403) → blocked=1, exclu des relances et du broadcast.

const REMINDER_THRESHOLDS_H = [24, 72, 168];

async function sendDmRaw(tgId: number, text: string, keyboard?: any[][]): Promise<{ ok: boolean; status: number }> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return { ok: false, status: 0 };
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: tgId,
      text,
      parse_mode: "HTML",
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    }),
  });
  return { ok: res.ok, status: res.status };
}

function reminderContent(lead: FunnelLead): { text: string; keyboard?: any[][] } {
  if (lead.stage <= 0) {
    return {
      text: `👋 Toujours partant ?\n\n<b>Étape 1/4 — Installe l'app et inscris-toi</b>\n🎥 ${QQPK_FUNNEL_LOOM_APP}\n\nQuand c'est fait, clique 👇`,
      keyboard: [[{ text: "✅ App installée", callback_data: "qf_app_ok" }]],
    };
  }
  if (lead.stage === 1) {
    return {
      text: `👋 Il te reste 3 étapes !\n\n<b>Étape 2/4 — Fais ton premier dépôt</b>\n🎥 ${QQPK_FUNNEL_LOOM_DEPOSIT}\n\nQuand c'est fait, clique 👇`,
      keyboard: [[{ text: "✅ Dépôt fait", callback_data: "qf_deposit_ok" }]],
    };
  }
  return {
    text: `👋 Presque fini !\n\n<b>Étape 3/4 — Envoie-moi ton ID joueur</b>\nTu le trouves dans l'app, onglet <b>ME</b>. Envoie juste le numéro ici 👇`,
  };
}

export async function runQqpkFunnelReminders(): Promise<{ sent: number; blocked: number; skipped: number }> {
  const db = getDb();
  const stuck = db.prepare(`
    SELECT *,
      COALESCE(stage2_at, stage1_at, created_at) AS stage_ts,
      (julianday('now') - julianday(COALESCE(stage2_at, stage1_at, created_at))) * 24 AS hours_stuck,
      CASE WHEN last_reminder_at IS NULL THEN 999999
           ELSE (julianday('now') - julianday(last_reminder_at)) * 24 END AS hours_since_reminder
    FROM qqpk_funnel_leads
    WHERE stage < 4 AND blocked = 0 AND reminders_sent < 3
  `).all() as Array<FunnelLead & { hours_stuck: number; hours_since_reminder: number }>;

  let sent = 0, blockedCount = 0, skipped = 0;
  for (const lead of stuck) {
    const threshold = REMINDER_THRESHOLDS_H[lead.reminders_sent] ?? Infinity;
    // Garde anti-spam : jamais 2 relances à moins de 20h d'écart, quel que soit le seuil.
    if (lead.hours_stuck < threshold || lead.hours_since_reminder < 20) { skipped++; continue; }

    const { text, keyboard } = reminderContent(lead);
    try {
      const res = await sendDmRaw(lead.telegram_id, text, keyboard);
      if (res.ok) {
        db.prepare(`UPDATE qqpk_funnel_leads SET reminders_sent = reminders_sent + 1, last_reminder_at = datetime('now') WHERE telegram_id = ?`).run(lead.telegram_id);
        sent++;
      } else if (res.status === 403) {
        // L'utilisateur a bloqué le bot — on le sort des relances/broadcasts.
        db.prepare(`UPDATE qqpk_funnel_leads SET blocked = 1, updated_at = datetime('now') WHERE telegram_id = ?`).run(lead.telegram_id);
        blockedCount++;
      } else {
        skipped++;
      }
    } catch (e: any) {
      console.error(`[QQPK_FUNNEL] reminder failed for tg_id=${lead.telegram_id}:`, e?.message ?? e);
      skipped++;
    }
    await new Promise(r => setTimeout(r, 150));
  }

  return { sent, blocked: blockedCount, skipped };
}

// ── Lectures CRM (page /qqpk-funnel) ───────────────────────

export type FunnelLeadWithStats = FunnelLead & {
  total_rake: number;
  total_deposits: number;
  total_withdrawals: number;
  total_winloss: number;
  total_rewards: number;
  weeks_count: number;
  nickname: string | null;
};

export function getQqpkFunnelLeads(): FunnelLeadWithStats[] {
  return getDb().prepare(`
    SELECT l.*,
      COALESCE(r.total_rake, 0) AS total_rake,
      COALESCE(r.total_deposits, 0) AS total_deposits,
      COALESCE(r.total_withdrawals, 0) AS total_withdrawals,
      COALESCE(r.total_winloss, 0) AS total_winloss,
      COALESCE(r.total_rewards, 0) AS total_rewards,
      COALESCE(r.weeks_count, 0) AS weeks_count,
      r.nickname AS nickname
    FROM qqpk_funnel_leads l
    LEFT JOIN (
      SELECT member_id,
        SUM(rake) AS total_rake,
        SUM(deposits) AS total_deposits,
        SUM(withdrawals) AS total_withdrawals,
        SUM(winloss) AS total_winloss,
        SUM(rewards) AS total_rewards,
        COUNT(*) AS weeks_count,
        MAX(nickname) AS nickname
      FROM qqpk_funnel_reports
      GROUP BY member_id
    ) r ON r.member_id = l.qqpk_member_id
    ORDER BY l.created_at DESC
  `).all() as FunnelLeadWithStats[];
}

export type FunnelWeeklyReport = {
  member_id: string;
  week_start: string;
  nickname: string | null;
  rake: number;
  deposits: number;
  withdrawals: number;
  winloss: number;
  insurance: number;
  rewards: number;
};

export function getQqpkFunnelWeeklyReports(): FunnelWeeklyReport[] {
  return getDb().prepare(`
    SELECT member_id, week_start, nickname, rake, deposits, withdrawals, winloss, insurance, rewards
    FROM qqpk_funnel_reports
    ORDER BY member_id, week_start
  `).all() as FunnelWeeklyReport[];
}
