import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";
import { isUserbotConfigured, createPlayerGroup } from "@/lib/telegram-userbot";

const CB_DISCOVER = "onb_discover";
const CB_JOIN = "onb_join";

// ── Telegram API wrappers for inline keyboards & media ───

async function sendMsgWithButtons(
  chatId: number | string,
  text: string,
  buttons: { text: string; callback_data: string }[][]
) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: buttons },
    }),
  });
  if (!res.ok) console.error("[TG sendMsgWithButtons]", res.status, await res.text());
}

async function sendVideo(chatId: number | string, video: string, caption: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, video, caption, parse_mode: "HTML" }),
  });
  if (!res.ok) {
    console.error("[TG sendVideo]", res.status, await res.text());
    await sendMsg(chatId, caption);
  }
}

async function answerCallback(callbackQueryId: string) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  });
}

// ── Onboarding: welcome screen ──────────────────────────

export async function handleOnboardingWelcome(
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string }
) {
  const db = getDb();

  // Upsert lead
  db.prepare(`
    INSERT INTO onboarding_leads (telegram_id, telegram_username, first_name, stage)
    VALUES (?, ?, ?, 'welcome')
    ON CONFLICT(telegram_id) DO UPDATE SET
      telegram_username = excluded.telegram_username,
      first_name = excluded.first_name,
      last_seen = datetime('now')
  `).run(from.id, from.username ?? null, from.first_name ?? "Joueur");

  await sendMsgWithButtons(chatId,
    `🃏 <b>Bienvenue sur TELE AK POKER !</b>\n\n` +
    `Le poker en ligne, simplifié.\n` +
    `Joue depuis ton téléphone, encaisse en USDT.\n\n` +
    `👇 Découvre comment ça marche`,
    [[{ text: "🎬 Découvrir le jeu", callback_data: CB_DISCOVER }]]
  );
}

// ── Callback dispatcher ─────────────────────────────────

export async function handleOnboardingCallback(callbackQuery: any) {
  const data: string = callbackQuery.data;
  const chatId: number = callbackQuery.message?.chat?.id;
  const from = callbackQuery.from;

  if (!chatId || !from) return;
  await answerCallback(callbackQuery.id);

  if (data === CB_DISCOVER) {
    await handleDiscover(chatId, from);
  } else if (data === CB_JOIN) {
    await handleJoin(chatId, from);
  }
}

// ── Stage: discover ─────────────────────────────────────

async function handleDiscover(chatId: number, from: any) {
  const db = getDb();
  db.prepare(`UPDATE onboarding_leads SET stage = 'discovered', last_seen = datetime('now') WHERE telegram_id = ?`).run(from.id);

  // Send video if configured (set via: INSERT INTO settings VALUES ('onboarding_video_file_id', '<file_id_or_url>'))
  const videoSetting = db.prepare(`SELECT value FROM settings WHERE key = 'onboarding_video_file_id'`).get() as { value: string } | undefined;
  if (videoSetting?.value) {
    await sendVideo(chatId, videoSetting.value, `🎰 <b>TELE AK POKER</b>`);
  }

  await sendMsgWithButtons(chatId,
    `🎰 <b>TELE AK POKER — Le poker mobile</b>\n\n` +
    `✅ Tables privées 24/7\n` +
    `✅ Dépôts & retraits rapides en USDT\n` +
    `✅ Support personnel dédié\n` +
    `✅ Rakeback sur toutes tes parties\n\n` +
    `Prêt à rejoindre ?`,
    [[{ text: "🚀 Rejoindre la partie", callback_data: CB_JOIN }]]
  );
}

// ── Stage: join ─────────────────────────────────────────

async function handleJoin(chatId: number, from: any) {
  const db = getDb();
  const firstName = from.first_name ?? "Joueur";
  const lastName = from.last_name ?? "";
  const username: string | null = from.username ?? null;
  const fullName = [firstName, lastName].filter(Boolean).join(" ");

  // Check if already joined
  const lead = db.prepare(`SELECT stage FROM onboarding_leads WHERE telegram_id = ?`).get(from.id) as { stage: string } | undefined;
  if (lead?.stage === "joined") {
    await sendMsg(chatId,
      `✅ Tu es déjà inscrit ! Ton groupe arrive bientôt.\n\nQuestions ? → @baki77777`
    );
    return;
  }

  db.prepare(`UPDATE onboarding_leads SET stage = 'joined', last_seen = datetime('now') WHERE telegram_id = ?`).run(from.id);

  // Try auto-create group via userbot
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  let groupCreated = false;

  if (isUserbotConfigured() && botToken) {
    try {
      const result = await createPlayerGroup(from.id, fullName, botToken);
      if (result) {
        groupCreated = true;
        await sendMsg(chatId,
          `🎉 <b>C'est parti !</b>\n\n` +
          `Ton groupe privé <b>TELE AK POKER — ${fullName}</b> a été créé.\n` +
          `Tu y retrouveras ton support dédié pour :\n` +
          `• Gérer tes dépôts & retraits\n` +
          `• Suivre ton solde et tes gains\n` +
          `• Poser toutes tes questions\n\n` +
          `Bienvenue dans Le Cercle 🃏`
        );
        // Notify admins
        const mention = username ? `@${username}` : `<b>${fullName}</b>`;
        await sendMsg(AGENT_CHAT_ID,
          `🆕 <b>Nouveau joueur onboardé !</b>\n\n` +
          `👤 ${fullName}\n` +
          (username ? `📱 @${username}\n` : "") +
          `🆔 <code>${from.id}</code>\n` +
          `✅ Groupe créé automatiquement`
        );
      }
    } catch (e) {
      console.error("[ONBOARDING] auto-group failed:", e);
    }
  }

  // Fallback: notify admins to create group manually
  if (!groupCreated) {
    await sendMsg(chatId,
      `✅ <b>Tu es inscrit !</b>\n\n` +
      `On prépare ton groupe privé. Tu recevras une invitation très bientôt.\n\n` +
      `En attendant → @baki77777`
    );

    const mention = username ? `@${username}` : `<b>${fullName}</b>`;
    await sendMsg(AGENT_CHAT_ID,
      `🆕 <b>Nouveau joueur prêt à joindre !</b>\n\n` +
      `👤 ${fullName}\n` +
      (username ? `📱 @${username}\n` : "") +
      `🆔 <code>${from.id}</code>\n\n` +
      `⚡ Crée un groupe avec ce joueur + @hugoroine et ajoute le bot.`
    );
  }
}
