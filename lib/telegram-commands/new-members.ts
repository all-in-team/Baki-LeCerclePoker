import { getDb } from "@/lib/db";
import { sendMsg, sendMsgKeyboard, setSession, mentionOf, trackOnboardingStep, AGENT_CHAT_ID, type Step } from "./helpers";
// PITCH_MSG imports removed — neutral default, game-specific pitches are inline in sendKkpokerPitch/sendA5pokerPitch
import { consumePendingGroupData } from "./onboarding";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export async function handleNewMembers(members: any[], chatTitle: string, chatId: number) {
  const db = getDb();
  for (const member of members) {
    if (member.is_bot) continue;
    const name = [member.first_name, member.last_name].filter(Boolean).join(" ") || `TG#${member.id}`;
    const existing = db.prepare(`SELECT id FROM players WHERE telegram_id = ?`).get(member.id) as { id: number } | undefined;
    // Consume group data early so gameName is available for joined_via
    const groupData = consumePendingGroupData(member.id);
    const gameName = groupData?.gameName;

    // ── Affiliation group: neutral flow, skip game-specific pitch ──
    const affiliateLead = db.prepare(
      `SELECT id, affiliate_player_id, referred_handle FROM affiliate_leads WHERE kickoff_group_id = ? AND status = 'pending'`
    ).get(String(chatId)) as { id: number; affiliate_player_id: number; referred_handle: string } | undefined;

    if (affiliateLead && !existing) {
      const r = db.prepare(`INSERT INTO players (name, telegram_handle, telegram_id, telegram_chat_id, status, tier, joined_via) VALUES (@name, @handle, @telegram_id, @chat_id, 'active', 'B', 'affiliation')`)
        .run({ name, handle: member.username ?? null, telegram_id: member.id, chat_id: String(chatId) });
      const newPlayerId = Number(r.lastInsertRowid);

      if (groupData) {
        db.prepare(`UPDATE players SET telegram_group_id = ?, alertes_topic_id = ?, liveplay_topic_id = ? WHERE id = ?`)
          .run(String(groupData.groupId), groupData.alertesTopicId, groupData.liveplayTopicId, newPlayerId);
      }

      db.prepare(
        `UPDATE affiliate_leads SET status = 'converted', converted_at = datetime('now'), converted_player_id = ? WHERE id = ?`
      ).run(newPlayerId, affiliateLead.id);
      console.log(`[AFFILIATE] Lead ${affiliateLead.id} converted (group match): @${affiliateLead.referred_handle} → player ${newPlayerId}`);

      const existingRel = db.prepare(`SELECT 1 FROM affiliate_relationships WHERE referred_player_id = ?`).get(newPlayerId);
      if (!existingRel) {
        db.prepare(
          `INSERT INTO affiliate_relationships (affiliate_player_id, referred_player_id, origin_game_id, start_date) VALUES (?, ?, NULL, date('now'))`
        ).run(affiliateLead.affiliate_player_id, newPlayerId);
        console.log(`[AFFILIATE] Relationship created: affiliate=${affiliateLead.affiliate_player_id} referred=${newPlayerId} origin=NULL`);
      }

      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(newPlayerId, `Créé via affiliation — a rejoint "${chatTitle}"`);

      const affiliate = db.prepare(
        `SELECT name, telegram_group_id FROM players WHERE id = ?`
      ).get(affiliateLead.affiliate_player_id) as { name: string; telegram_group_id: string | null } | undefined;
      if (affiliate?.telegram_group_id) {
        await sendMsg(parseInt(affiliate.telegram_group_id),
          `🎉 Ton filleul <i>@${affiliateLead.referred_handle}</i> vient de rejoindre !\n\nOn prend le relais pour l'onboarder. Tu seras notifié quand il sera connecté.`
        );
      }
      await sendMsg(AGENT_CHAT_ID,
        `🤝 <b>Lead affiliate converti</b>\n` +
        `Filleul : <i>@${affiliateLead.referred_handle}</i> → player #${newPlayerId}\n` +
        `Affiliate : <b>${affiliate?.name ?? "?"}</b>`
      );

      await sendMsg(chatId, `👋 Bienvenue <b>${name}</b> !\n\nBaki va te contacter bientôt pour te setup sur un game. En attendant, fais comme chez toi.`);
      continue;
    }

    // ── Standard game-specific flow ──
    let playerId: number;
    let isNew: boolean;
    if (existing) { playerId = existing.id; isNew = false; }
    else {
      const joinedVia = gameName ? `new_member_${gameName}` : "new_member_neutral";
      const r = db.prepare(`INSERT INTO players (name, telegram_handle, telegram_id, telegram_chat_id, status, tier, joined_via) VALUES (@name, @handle, @telegram_id, @chat_id, 'active', 'B', @joined_via)`)
        .run({ name, handle: member.username ?? null, telegram_id: member.id, chat_id: String(chatId), joined_via: joinedVia });
      playerId = Number(r.lastInsertRowid);
      isNew = true;
    }

    if (groupData) {
      db.prepare(`UPDATE players SET telegram_group_id = ?, alertes_topic_id = ?, liveplay_topic_id = ? WHERE id = ?`)
        .run(String(groupData.groupId), groupData.alertesTopicId, groupData.liveplayTopicId, playerId);
    }

    if (isNew && member.username) {
      const handle = member.username.toLowerCase();
      const lead = db.prepare(
        `SELECT id, affiliate_player_id FROM affiliate_leads WHERE LOWER(referred_handle) = ? AND status = 'pending'`
      ).get(handle) as { id: number; affiliate_player_id: number } | undefined;
      if (lead) {
        db.prepare(
          `UPDATE affiliate_leads SET status = 'converted', converted_at = datetime('now'), converted_player_id = ? WHERE id = ?`
        ).run(playerId, lead.id);
        console.log(`[AFFILIATE] Lead ${lead.id} converted: @${handle} → player ${playerId}`);
        const affiliate = db.prepare(
          `SELECT name, telegram_group_id FROM players WHERE id = ?`
        ).get(lead.affiliate_player_id) as { name: string; telegram_group_id: string | null } | undefined;
        if (affiliate?.telegram_group_id) {
          await sendMsg(parseInt(affiliate.telegram_group_id),
            `🎉 Ton filleul <i>@${handle}</i> vient de rejoindre !\n\nOn prend le relais pour l'onboarder. Tu seras notifié quand il sera connecté.`
          );
        }
        await sendMsg(AGENT_CHAT_ID,
          `🤝 <b>Lead affiliate converti</b>\n` +
          `Filleul : <i>@${handle}</i> → player #${playerId}\n` +
          `Affiliate : <b>${affiliate?.name ?? "?"}</b>`
        );
      }
    }

    if (!existing) {
      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(playerId, `Créé automatiquement — a rejoint "${chatTitle}"`);
    } else {
      db.prepare(`UPDATE players SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), playerId);
      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(playerId, `A rejoint "${chatTitle}"`);
    }

    // KKPOKER: insert deal + send KKPOKER-specific pitch
    if (gameName === "KKPOKER") {
      const topicRow = db.prepare(`SELECT onboarding_topic_id FROM players WHERE id = ?`).get(playerId) as { onboarding_topic_id: number | null } | undefined;
      await sendKkpokerPitch(chatId, playerId, { name, telegram_id: member.id, telegram_handle: member.username ?? null }, topicRow?.onboarding_topic_id ?? undefined);
      continue;
    }

    // A5POKER: insert deal + send A5POKER-specific pitch
    if (gameName === "A5POKER") {
      const topicRow = db.prepare(`SELECT onboarding_topic_id FROM players WHERE id = ?`).get(playerId) as { onboarding_topic_id: number | null } | undefined;
      await sendA5pokerPitch(chatId, playerId, { name, telegram_id: member.id, telegram_handle: member.username ?? null }, topicRow?.onboarding_topic_id ?? undefined);
      continue;
    }

    // Neutral (no gameName): welcome message, Baki handles onboarding manually
    if (isNew && !gameName) {
      await sendMsg(chatId,
        `👋 Bienvenue <b>${member.first_name ?? name}</b> !\n\n` +
        `L'équipe va te contacter pour te setup sur le bon game. En attendant, fais comme chez toi 🃏`
      );
      await sendMsg(AGENT_CHAT_ID,
        `🆕 <b>Nouveau joueur (neutral)</b>\n` +
        `👤 ${name}` + (member.username ? ` @${member.username}` : "") + `\n` +
        `🆔 <code>${member.id}</code>\n` +
        `📦 Chat: <code>${chatId}</code>\n` +
        `→ Assigner un game via /crm`
      );
    }
  }
}

export async function sendKkpokerPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  onboardingTopicId?: number,
) {
  const db = getDb();
  const kkGameId = (db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined)?.id;
  if (kkGameId) {
    db.prepare(`INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, 40, 0)`).run(playerId, kkGameId);
  }

  setSession(chatId, "kkpoker_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — on te propose KKPOKER !\n\n` +
    `On t'explique comment ça marche et on te setup en quelques minutes.`,
    tid
  );
  await sleep(2000);
  await sendMsg(chatId,
    `Voilà le deal qu'on propose :\n\n` +
    `🤝 Tu joues <b>60%</b> de ton action.\n` +
    `On prend les 40% restants.\n\n` +
    `C'est de l'action symétrique : <b>win/win, lose/lose</b>.\n` +
    `L'avantage : tu peux simplement jouer plus cher. Ça ne te pénalise pas, ça te protège.`,
    tid
  );
  await sleep(3000);
  await sendMsgKeyboard(chatId, `Qu'est-ce que tu en penses ?`, [
    [{ text: "🤝 Avec vous", callback_data: "kk_choice_with_us" }],
    [{ text: "❓ J'ai une question", callback_data: "kk_choice_question" }],
  ], tid);
}

export async function sendA5pokerPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  onboardingTopicId?: number,
) {
  const db = getDb();
  const a5GameId = (db.prepare(`SELECT id FROM games WHERE name = 'A5POKER'`).get() as { id: number } | undefined)?.id;
  if (a5GameId) {
    db.prepare(`INSERT OR IGNORE INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, 20, 0)`).run(playerId, a5GameId);
  }

  setSession(chatId, "a5poker_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — on te propose A5POKER !\n\n` +
    `Nouveau cercle, fresh action. On t'explique comment ça marche et on te setup en quelques minutes.`,
    tid
  );
  await sleep(2000);
  await sendMsg(chatId,
    `Voilà le deal qu'on propose A5POKER :\n\n` +
    `🎯 <b>Action 80/20</b> — Tu joues 80% de ton action, on prend 20%. C'est symétrique : win/win, lose/lose.\n\n` +
    `🛡️ <b>1000 USDT de liquidité garantie</b> — On couvre ton float jusqu'à 1K. Tu joues, on gère le risque.\n\n` +
    `⚡ <b>Règle d'or</b> : max 1K sur le compte. Tout l'extra → cash out direct chez toi. ` +
    `Pourquoi ? On couvre 1K en cas de bug site / ban / dispute. Au-dessus, c'est ton risque, donc sécurise.`,
    tid
  );
  await sleep(3000);
  await sendMsgKeyboard(chatId, `Qu'est-ce que tu en penses ?`, [
    [{ text: "🤝 Avec vous", callback_data: "a5_choice_with_us" }],
    [{ text: "❓ J'ai une question", callback_data: "a5_choice_question" }],
  ], tid);
}
