import { getDb } from "./db";
import { sendMsg, sendMsgKeyboard, chatLink, AGENT_CHAT_ID, mentionOf } from "./telegram-commands/helpers";

interface StalledLead {
  id: number;
  telegram_id: number;
  telegram_username: string | null;
  first_name: string | null;
  step_entered_at: string;
  reminders_sent: number;
  ops_alerted: number;
  hours_since: number;
  player_id: number | null;
  player_name: string | null;
  telegram_chat_id: string | null;
  telegram_group_id: string | null;
  session_step: string | null;
}

const QUESTION_KB = [[{ text: "❓ J'ai une question", callback_data: "onboard_choice_question" }]];

const STEP_LABELS: Record<string, string> = {
  pitch_sent: "le pitch",
  contract_shown: "le contrat",
  awaiting_deposit_wallet: "l'adresse de dépôt",
  awaiting_cashout_wallet: "l'adresse de cashout",
};

const STEP_CTA: Record<string, { text: string; callback_data: string }> = {
  pitch_sent: { text: "🤝 J'accepte le deal", callback_data: "onboard_choice_with_us" },
  contract_shown: { text: "✅ Je signe", callback_data: "onboard_contract_sign" },
};

function getStalledLeads(): StalledLead[] {
  const db = getDb();
  return db.prepare(`
    SELECT
      ol.id,
      ol.telegram_id,
      ol.telegram_username,
      ol.first_name,
      ol.step_entered_at,
      ol.reminders_sent,
      ol.ops_alerted,
      ROUND((julianday('now') - julianday(ol.step_entered_at)) * 24, 2) AS hours_since,
      p.id AS player_id,
      p.name AS player_name,
      p.telegram_chat_id,
      p.telegram_group_id,
      ts.step AS session_step
    FROM onboarding_leads ol
    LEFT JOIN players p ON p.telegram_id = ol.telegram_id
    LEFT JOIN telegram_sessions ts ON ts.chat_id = p.telegram_chat_id
    WHERE ol.step_entered_at IS NOT NULL
      AND ts.step IS NOT NULL
      AND ts.step NOT IN ('onboarding_complete', 'wallets_complete', 'awaiting_human_response')
  `).all() as StalledLead[];
}

function tagFor(lead: StalledLead): string {
  return mentionOf({
    name: lead.first_name ?? "Joueur",
    telegram_handle: lead.telegram_username ?? null,
    telegram_id: lead.telegram_id,
  });
}

function chatIdFor(lead: StalledLead): string | null {
  return lead.telegram_group_id ?? lead.telegram_chat_id;
}

async function sendReminder1(lead: StalledLead): Promise<boolean> {
  const chatId = chatIdFor(lead);
  if (!chatId) return false;

  const tag = tagFor(lead);
  const step = lead.session_step ?? "pitch_sent";
  const stepLabel = STEP_LABELS[step] ?? "la suite";
  const cta = STEP_CTA[step];

  const msg =
    `${tag}, un petit rappel pour la suite 👇\n\n` +
    `On attend ta réponse pour <b>${stepLabel}</b>. N'hésite pas si tu as des questions !`;

  const kb = cta
    ? [...QUESTION_KB, [cta]]
    : [...QUESTION_KB];

  try {
    await sendMsgKeyboard(chatId, msg, kb);
  } catch {
    try { await sendMsg(chatId, msg); } catch { return false; }
  }

  getDb().prepare(`UPDATE onboarding_leads SET reminders_sent = 1, last_reminder_at = datetime('now') WHERE id = ?`).run(lead.id);
  console.log(`[ONBOARD-REMIND] sent reminder 1 to lead=${lead.id} (${lead.first_name})`);
  return true;
}

async function sendOpsAlert(lead: StalledLead): Promise<boolean> {
  const chatId = chatIdFor(lead);
  const groupUrl = chatId ? chatLink(chatId) : "(pas de groupe)";
  const name = lead.player_name ?? lead.first_name ?? "Inconnu";
  const step = lead.session_step ?? "unknown";

  await sendMsg(AGENT_CHAT_ID,
    `⚠️ <b>${name}</b> n'a pas avancé depuis 24h (step: <code>${step}</code>)\n\n` +
    `Groupe → ${groupUrl}\n\n` +
    `À check manuellement.`
  );

  getDb().prepare(`UPDATE onboarding_leads SET ops_alerted = 1, ops_alerted_at = datetime('now') WHERE id = ?`).run(lead.id);
  console.log(`[ONBOARD-REMIND] ops alert for lead=${lead.id} (${name})`);
  return true;
}

async function sendReminder2(lead: StalledLead): Promise<boolean> {
  const chatId = chatIdFor(lead);
  if (!chatId) return false;

  const tag = tagFor(lead);
  const step = lead.session_step ?? "pitch_sent";
  const cta = STEP_CTA[step];

  const msg =
    `${tag}, on est toujours là si tu veux continuer 👇\n\n` +
    `Pas de pression, on reprend quand tu veux.`;

  const kb = cta
    ? [...QUESTION_KB, [cta]]
    : [...QUESTION_KB];

  try {
    await sendMsgKeyboard(chatId, msg, kb);
  } catch {
    try { await sendMsg(chatId, msg); } catch { return false; }
  }

  getDb().prepare(`UPDATE onboarding_leads SET reminders_sent = 2, last_reminder_at = datetime('now') WHERE id = ?`).run(lead.id);
  console.log(`[ONBOARD-REMIND] sent reminder 2 to lead=${lead.id} (${lead.first_name})`);
  return true;
}

export interface ReminderResult {
  phase: string;
  lead_id: number;
  name: string;
  step: string;
  hours_since: number;
  sent: boolean;
}

export async function runOnboardingReminders(options?: {
  phase?: "8h" | "24h" | "7d";
  leadId?: number;
  dryRun?: boolean;
}): Promise<ReminderResult[]> {
  const { phase, leadId, dryRun } = options ?? {};
  const results: ReminderResult[] = [];

  let leads = getStalledLeads();
  if (leadId) leads = leads.filter(l => l.id === leadId);

  for (const lead of leads) {
    const h = lead.hours_since;
    const name = lead.player_name ?? lead.first_name ?? "Inconnu";
    const step = lead.session_step ?? "unknown";

    // Reminder 1: 8h ≤ delta < 24h AND reminders_sent = 0
    if ((!phase || phase === "8h") && h >= 8 && lead.reminders_sent === 0) {
      if (dryRun) {
        results.push({ phase: "8h", lead_id: lead.id, name, step, hours_since: h, sent: false });
      } else {
        const sent = await sendReminder1(lead);
        results.push({ phase: "8h", lead_id: lead.id, name, step, hours_since: h, sent });
      }
    }

    // Ops alert: 24h ≤ delta AND ops_alerted = 0
    if ((!phase || phase === "24h") && h >= 24 && lead.ops_alerted === 0) {
      if (dryRun) {
        results.push({ phase: "24h", lead_id: lead.id, name, step, hours_since: h, sent: false });
      } else {
        const sent = await sendOpsAlert(lead);
        results.push({ phase: "24h", lead_id: lead.id, name, step, hours_since: h, sent });
      }
    }

    // Reminder 2: 7d ≤ delta AND reminders_sent = 1
    if ((!phase || phase === "7d") && h >= 168 && lead.reminders_sent === 1) {
      if (dryRun) {
        results.push({ phase: "7d", lead_id: lead.id, name, step, hours_since: h, sent: false });
      } else {
        const sent = await sendReminder2(lead);
        results.push({ phase: "7d", lead_id: lead.id, name, step, hours_since: h, sent });
      }
    }
  }

  return results;
}
