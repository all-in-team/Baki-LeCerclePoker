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
  // Preuves d'activité figées par la même requête (donc au même instant, sur les mêmes données)
  // que la décision d'éligibilité. Sérialisées dans onboarding_reminder_log.conditions_json.
  last_rake_at: string | null;
  last_tx_at: string | null;
  tx_count: number;
  last_game_session_at: string | null;
  last_bot_at: string | null;
  last_player_activity_at: string | null;
  wallet_count: number;
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

// Fenêtre d'activité : un joueur qui a bougé dans les N derniers jours n'est pas "stalled",
// quel que soit l'âge de son `step_entered_at`. 30 j > seuil de relance 2 (7 j) — marge volontaire.
const ACTIVITY_WINDOW_DAYS = 30;

// Steps terminaux du funnel legacy. NB : ce n'est PAS un marqueur d'avancement fiable pour les
// funnels par jeu (kkpoker_*, a5poker_*, aks_*, wn_*, qqpk_*, …), qui n'y passent jamais.
// L'avancement réel est mesuré plus bas sur les wallets enregistrés.
const TERMINAL_STEPS = ["onboarding_complete", "wallets_complete", "awaiting_human_response"];

// Bug historique (faux positifs) : `onboarding_leads.step_entered_at` n'est rafraîchi que par les
// 6 steps de TRACKABLE_STEPS (helpers.ts). Tous les funnels par jeu n'appellent
// trackOnboardingStep() qu'au pitch : le compteur d'inactivité démarre au pitch et ne repart
// JAMAIS, même quand le joueur progresse, dépose et joue. `hours_since` franchit donc les seuils
// 8 h / 24 h / 7 j pour des joueurs pleinement actifs. Tant que le compteur n'est pas recâblé,
// on neutralise le symptôme en excluant toute preuve d'activité ou d'avancement réel.
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
      ts.step AS session_step,

      -- Preuves d'activité, pour le journal d'audit (pas pour le filtrage).
      (SELECT MAX(COALESCE(rr.report_date, rr.created_at))
         FROM rakeback_entries re JOIN rakeback_reports rr ON rr.id = re.report_id
        WHERE re.player_id = p.id) AS last_rake_at,
      (SELECT MAX(COALESCE(wt.tx_datetime, wt.tx_date)) FROM wallet_transactions wt
        WHERE wt.player_id = p.id AND (wt.source IS NULL OR wt.source != 'unknown')) AS last_tx_at,
      (SELECT COUNT(*) FROM wallet_transactions wt
        WHERE wt.player_id = p.id AND (wt.source IS NULL OR wt.source != 'unknown')) AS tx_count,
      (SELECT MAX(gs.created_at) FROM grindhouse_sessions gs WHERE gs.player_id = p.id) AS last_game_session_at,
      ts.created_at AS last_bot_at,
      ol.last_player_activity_at,
      (
        (SELECT COUNT(*) FROM player_wallet_games g WHERE g.player_id = p.id)
        + (SELECT COUNT(*) FROM player_wallet_cashouts c WHERE c.player_id = p.id)
        + (CASE WHEN p.tron_address IS NOT NULL THEN 1 ELSE 0 END)
        + (CASE WHEN p.tele_wallet_cashout IS NOT NULL THEN 1 ELSE 0 END)
      ) AS wallet_count
    FROM onboarding_leads ol
    LEFT JOIN players p ON p.telegram_id = ol.telegram_id
    LEFT JOIN telegram_sessions ts ON ts.chat_id = p.telegram_chat_id
    WHERE ol.step_entered_at IS NOT NULL
      AND ts.step IS NOT NULL
      AND ts.step NOT IN (${TERMINAL_STEPS.map(() => "?").join(", ")})

      -- ── Activité récente : rake déclaré sur un report des N derniers jours ──
      AND NOT EXISTS (
        SELECT 1 FROM rakeback_entries re
        JOIN rakeback_reports rr ON rr.id = re.report_id
        WHERE re.player_id = p.id
          AND COALESCE(rr.report_date, rr.created_at) >= datetime('now', ?)
      )

      -- ── Activité récente : dépôt ou cashout on-chain (source 'unknown' exclue, invariant #10) ──
      AND NOT EXISTS (
        SELECT 1 FROM wallet_transactions wt
        WHERE wt.player_id = p.id
          AND (wt.source IS NULL OR wt.source != 'unknown')
          AND COALESCE(wt.tx_datetime, wt.tx_date) >= datetime('now', ?)
      )

      -- ── Activité récente : session de jeu enregistrée ──
      AND NOT EXISTS (
        SELECT 1 FROM grindhouse_sessions gs
        WHERE gs.player_id = p.id
          AND gs.created_at >= datetime('now', ?)
      )

      -- ── Activité récente : interaction joueur, mesurée par DEUX signaux complémentaires.
      --
      --    1. ol.last_player_activity_at : écrit au webhook à chaque message ou clic du joueur.
      --       C'est le bon signal — il capte le joueur qui écrit tous les jours sans que son
      --       étape de funnel ne bouge. Mais il démarre NULL (non backfillable) et ne se peuple
      --       qu'au fil des interactions.
      --
      --    2. ts.created_at : réécrit à chaque setSession() (INSERT OR REPLACE), donc = dernier
      --       pas de funnel franchi. Signal plus faible — il ne bouge PAS quand le joueur dépose
      --       ou discute sans changer d'étape — mais déjà peuplé aujourd'hui.
      --
      --    Les deux sont testés tant que (1) n'est pas peuplé : sinon un NULL en (1) rendrait
      --    tout le monde éligible du jour au lendemain. Retirer (2) seulement vers 2026-09-04. ──
      AND (ol.last_player_activity_at IS NULL OR ol.last_player_activity_at < datetime('now', ?))
      AND (ts.created_at IS NULL OR ts.created_at < datetime('now', ?))

      -- ── Avancement funnel : wallet enregistré ET au moins une transaction (toutes dates).
      --    Le wallet seul ne suffit PAS à exclure : un lead qui a posé son adresse et n'a jamais
      --    déposé est précisément la cible légitime de la relance. C'est la paire
      --    « adresse livrée + argent qui a bougé » qui prouve que le joueur est opérationnel. ──
      AND NOT (
        (
          EXISTS (SELECT 1 FROM player_wallet_games g WHERE g.player_id = p.id)
          OR EXISTS (SELECT 1 FROM player_wallet_cashouts c WHERE c.player_id = p.id)
          OR p.tron_address IS NOT NULL
          OR p.tele_wallet_cashout IS NOT NULL
        )
        AND EXISTS (
          SELECT 1 FROM wallet_transactions wt
          WHERE wt.player_id = p.id
            AND (wt.source IS NULL OR wt.source != 'unknown')
        )
      )
  `).all(
    ...TERMINAL_STEPS,
    `-${ACTIVITY_WINDOW_DAYS} days`, // rake
    `-${ACTIVITY_WINDOW_DAYS} days`, // transactions wallet
    `-${ACTIVITY_WINDOW_DAYS} days`, // sessions de jeu
    `-${ACTIVITY_WINDOW_DAYS} days`, // last_player_activity_at (webhook)
    `-${ACTIVITY_WINDOW_DAYS} days`, // telegram_sessions.created_at (transitoire)
  ) as StalledLead[];
}

/**
 * Journalise une relance dans `onboarding_reminder_log` (append-only).
 *
 * Appelée pour CHAQUE tentative, y compris les échecs (`sent = 0`) : une relance qui n'est pas
 * partie faute de chat_id est une information d'audit au même titre qu'un envoi réussi.
 *
 * Ne jette jamais : un journal cassé ne doit pas faire tomber le cron. L'erreur part en console.
 */
function logReminder(lead: StalledLead, phase: "8h" | "24h" | "7d", sent: boolean) {
  try {
    getDb().prepare(`
      INSERT INTO onboarding_reminder_log
        (lead_id, telegram_id, player_id, phase, sent, chat_id, session_step, step_entered_at,
         hours_since, reminders_sent_before, ops_alerted_before, conditions_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lead.id,
      lead.telegram_id,
      lead.player_id,
      phase,
      sent ? 1 : 0,
      chatIdFor(lead),
      lead.session_step,
      lead.step_entered_at,
      lead.hours_since,
      lead.reminders_sent,
      lead.ops_alerted,
      JSON.stringify({
        activity_window_days: ACTIVITY_WINDOW_DAYS,
        last_rake_at: lead.last_rake_at,
        last_tx_at: lead.last_tx_at,
        tx_count: lead.tx_count,
        last_game_session_at: lead.last_game_session_at,
        last_bot_at: lead.last_bot_at,
        last_player_activity_at: lead.last_player_activity_at,
        wallet_count: lead.wallet_count,
      }),
    );
  } catch (e: any) {
    console.error(`[ONBOARD-REMIND] log failed lead=${lead.id}:`, e.message);
  }
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
        logReminder(lead, "8h", sent);
        results.push({ phase: "8h", lead_id: lead.id, name, step, hours_since: h, sent });
      }
    }

    // Ops alert: 24h ≤ delta AND ops_alerted = 0
    if ((!phase || phase === "24h") && h >= 24 && lead.ops_alerted === 0) {
      if (dryRun) {
        results.push({ phase: "24h", lead_id: lead.id, name, step, hours_since: h, sent: false });
      } else {
        const sent = await sendOpsAlert(lead);
        logReminder(lead, "24h", sent);
        results.push({ phase: "24h", lead_id: lead.id, name, step, hours_since: h, sent });
      }
    }

    // Reminder 2: 7d ≤ delta AND reminders_sent = 1
    if ((!phase || phase === "7d") && h >= 168 && lead.reminders_sent === 1) {
      if (dryRun) {
        results.push({ phase: "7d", lead_id: lead.id, name, step, hours_since: h, sent: false });
      } else {
        const sent = await sendReminder2(lead);
        logReminder(lead, "7d", sent);
        results.push({ phase: "7d", lead_id: lead.id, name, step, hours_since: h, sent });
      }
    }
  }

  return results;
}
