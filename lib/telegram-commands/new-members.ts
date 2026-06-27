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
        // Tag the player's group "{nom} x LeCercle [{agent}]" (single rename, non-blocking).
        try {
          const { renameAffiliatedGroupForRelationship } = await import("@/lib/affiliate-group-rename");
          const rr = await renameAffiliatedGroupForRelationship(newPlayerId, affiliateLead.affiliate_player_id);
          console.log(`[AFFILIATE] group rename: ${JSON.stringify(rr)}`);
        } catch (re: any) { console.warn(`[AFFILIATE] group rename failed: ${re?.message ?? String(re)}`); }
      }

      db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
        .run(newPlayerId, `Créé via affiliation — a rejoint "${chatTitle}"`);

      const affiliate = db.prepare(
        `SELECT name, telegram_group_id, telegram_id, telegram_handle FROM players WHERE id = ?`
      ).get(affiliateLead.affiliate_player_id) as { name: string; telegram_group_id: string | null; telegram_id: number | null; telegram_handle: string | null } | undefined;

      const lead = db.prepare(
        `SELECT kickoff_invite_link FROM affiliate_leads WHERE id = ?`
      ).get(affiliateLead.id) as { kickoff_invite_link: string | null } | undefined;
      const inviteLink = lead?.kickoff_invite_link;

      // Notify agent's own group
      if (affiliate?.telegram_group_id) {
        await sendMsg(parseInt(affiliate.telegram_group_id),
          `🎉 Ton filleul <i>@${affiliateLead.referred_handle}</i> vient de rejoindre !`
        );
      }

      // DM agent with invite link to filleul's group
      if (affiliate?.telegram_id && inviteLink) {
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
          await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: affiliate.telegram_id,
              text: `🎉 Ton filleul <b>@${affiliateLead.referred_handle}</b> vient de rejoindre LeCerclePoker !\n\nViens suivre son onboarding et l'accompagner 👇`,
              parse_mode: "HTML",
              reply_markup: {
                inline_keyboard: [[{ text: "👀 Rejoindre le groupe", url: inviteLink }]],
              },
            }),
          }).catch(() => {});
        }
      }

      // Best-effort auto-add agent to filleul's group via MTProto
      if (affiliate?.telegram_handle) {
        try {
          const { inviteUserToGroup } = await import("@/lib/telegram-userbot");
          const addResult = await inviteUserToGroup(chatId, affiliate.telegram_handle);
          console.log(`[AFFILIATE] Auto-add agent @${affiliate.telegram_handle} to group ${chatId}: ${addResult.ok ? "OK" : addResult.error}`);
        } catch (e: any) {
          console.warn(`[AFFILIATE] Auto-add agent failed (non-blocking): ${e.message}`);
        }
      }

      await sendMsg(AGENT_CHAT_ID,
        `🤝 <b>Lead affiliate converti</b>\n` +
        `Filleul : <i>@${affiliateLead.referred_handle}</i> → player #${newPlayerId}\n` +
        `Affiliate : <b>${affiliate?.name ?? "?"}</b>\n` +
        `Auto-add agent : ${affiliate?.telegram_handle ? "tenté" : "skip (pas de handle)"}`
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

    // Convert a pending ref_ lead. Match by telegram_id FIRST (robust — survives a missing
    // @username, the exact gap that lost Maxime→Theo), then by @handle as fallback. Unlike
    // the old handle-only block, this also CREATES the affiliate_relationships row so the
    // attribution actually shows up under the agent (idempotent via the existing-rel guard).
    if (isNew) {
      const handle = member.username ? member.username.toLowerCase() : null;
      const lead = db.prepare(
        `SELECT id, affiliate_player_id FROM affiliate_leads
         WHERE status = 'pending'
           AND (referred_telegram_id = ? OR (? IS NOT NULL AND LOWER(referred_handle) = ?))
         LIMIT 1`
      ).get(member.id, handle, handle) as { id: number; affiliate_player_id: number } | undefined;
      if (lead) {
        db.prepare(
          `UPDATE affiliate_leads SET status = 'converted', converted_at = datetime('now'), converted_player_id = ? WHERE id = ?`
        ).run(playerId, lead.id);
        const existingRel = db.prepare(`SELECT 1 FROM affiliate_relationships WHERE referred_player_id = ?`).get(playerId);
        if (!existingRel) {
          db.prepare(
            `INSERT INTO affiliate_relationships (affiliate_player_id, referred_player_id, origin_game_id, start_date) VALUES (?, ?, NULL, date('now'))`
          ).run(lead.affiliate_player_id, playerId);
          console.log(`[AFFILIATE] Lead ${lead.id} converted + relationship created: affiliate=${lead.affiliate_player_id} → player ${playerId}`);
          // Tag the player's group "{nom} x LeCercle [{agent}]" (single rename, non-blocking).
          try {
            const { renameAffiliatedGroupForRelationship } = await import("@/lib/affiliate-group-rename");
            const rr = await renameAffiliatedGroupForRelationship(playerId, lead.affiliate_player_id);
            console.log(`[AFFILIATE] group rename: ${JSON.stringify(rr)}`);
          } catch (re: any) { console.warn(`[AFFILIATE] group rename failed: ${re?.message ?? String(re)}`); }
        } else {
          console.log(`[AFFILIATE] Lead ${lead.id} converted (relationship already existed) → player ${playerId}`);
        }
        const mention = handle ? `<i>@${handle}</i>` : `<b>${name}</b>`;
        const affiliate = db.prepare(
          `SELECT name, telegram_group_id FROM players WHERE id = ?`
        ).get(lead.affiliate_player_id) as { name: string; telegram_group_id: string | null } | undefined;
        if (affiliate?.telegram_group_id) {
          await sendMsg(parseInt(affiliate.telegram_group_id),
            `🎉 Ton filleul ${mention} vient de rejoindre !\n\nOn prend le relais pour l'onboarder. Tu seras notifié quand il sera connecté.`
          );
        }
        await sendMsg(AGENT_CHAT_ID,
          `🤝 <b>Lead affiliate converti</b>\n` +
          `Filleul : ${mention} → player #${playerId}\n` +
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

    // KKPOKER / A5POKER: owner picks the action % (free text) before the pitch fires.
    if (gameName === "KKPOKER" || gameName === "A5POKER") {
      const topicRow = db.prepare(`SELECT onboarding_topic_id FROM players WHERE id = ?`).get(playerId) as { onboarding_topic_id: number | null } | undefined;
      const { askActionPct } = await import("./action-pct-prompt");
      await askActionPct(chatId, playerId, { name, telegram_id: member.id }, gameName, topicRow?.onboarding_topic_id ?? undefined);
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

// KKPOKER pitch — action % is MODULABLE, chosen by the owner via the shared free-text
// prompt (askActionPct) and passed in here. The deal is upserted (re-running with a new
// % updates it), and the pitch copy is built dynamically from the chosen %.
export async function sendKkpokerPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  actionPct: number,
  onboardingTopicId?: number,
) {
  const db = getDb();
  const kkGameId = (db.prepare(`SELECT id FROM games WHERE name = 'KKPOKER'`).get() as { id: number } | undefined)?.id;
  if (kkGameId) {
    db.prepare(
      `INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, ?, 0)
       ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct`
    ).run(playerId, kkGameId, actionPct);
  }

  const playerPct = 100 - actionPct;

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
    `🤝 Tu joues <b>${playerPct}%</b> de ton action.\n` +
    `On prend les ${actionPct}% restants.\n\n` +
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

// A5POKER pitch — action % is MODULABLE, chosen by the owner via the shared free-text
// prompt (askActionPct) and passed in here. Deal upserted, pitch copy built from the %.
export async function sendA5pokerPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  actionPct: number,
  onboardingTopicId?: number,
) {
  const db = getDb();
  const a5GameId = (db.prepare(`SELECT id FROM games WHERE name = 'A5POKER'`).get() as { id: number } | undefined)?.id;
  if (a5GameId) {
    db.prepare(
      `INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, ?, 0)
       ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct`
    ).run(playerId, a5GameId, actionPct);
  }

  const playerPct = 100 - actionPct;

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
    `🎯 <b>Action ${playerPct}/${actionPct}</b> — Tu joues ${playerPct}% de ton action, on prend ${actionPct}%. C'est symétrique : win/win, lose/lose.\n\n` +
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

// AKS pitch — action % is MODULABLE, chosen by the owner at /startaks launch and
// passed in here. The deal is upserted (re-running /startaks with a new % updates it).
export async function sendAksPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  actionPct: number,
  onboardingTopicId?: number,
) {
  const db = getDb();
  const aksGameId = (db.prepare(`SELECT id FROM games WHERE name = 'AKS'`).get() as { id: number } | undefined)?.id;
  if (aksGameId) {
    db.prepare(
      `INSERT INTO player_game_deals (player_id, game_id, action_pct, rakeback_pct) VALUES (?, ?, ?, 0)
       ON CONFLICT(player_id, game_id) DO UPDATE SET action_pct = excluded.action_pct`
    ).run(playerId, aksGameId, actionPct);
  }

  const playerPct = 100 - actionPct;

  setSession(chatId, "aks_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — on te propose AKS !\n\n` +
    `On t'explique comment ça marche et on te setup en quelques minutes.`,
    tid
  );
  await sleep(2000);
  await sendMsg(chatId,
    `Voilà le deal qu'on propose AKS :\n\n` +
    `🎯 <b>Action ${playerPct}/${actionPct}</b> — Tu joues ${playerPct}% de ton action, on prend ${actionPct}%. ` +
    `C'est symétrique : win/win, lose/lose. L'avantage : tu peux jouer plus cher sans te pénaliser.\n\n` +
    `🛡️ <b>1000 USDT de liquidité garantie</b> — On couvre ton float jusqu'à 1K (bug site / ban / dispute), tant que tu joues fair.\n\n` +
    `⚡ <b>Règle d'or</b> : max 1K sur le compte. Tout l'extra → cash out direct chez toi. Au-dessus de 1K, c'est ton risque, donc sécurise.`,
    tid
  );
  await sleep(3000);
  // Anti-bypass: le lien Mini App n'est PAS dans le pitch. Il n'arrive qu'après
  // un clic explicite sur "J'accepte" (handleAksCallback → aks_accept).
  await sendMsgKeyboard(chatId, `Tu valides le deal ?`, [
    [{ text: "✅ J'accepte le deal", callback_data: "aks_accept" }],
    [{ text: "❓ J'ai une question", callback_data: "aks_choice_question" }],
  ], tid);
}

// QQPK staking pitch — FIXED 70/30 deal, no action % to pick. Anti-bypass: NO Mini App
// link here; it's revealed only after an explicit "J'accepte" (handleQqpkCallback →
// qqpk_accept). The deal row + acceptance are created on accept (acceptance = cycle anchor),
// NOT here, so a player only appears in /qqpk/pnl once onboarded.
export async function sendQqpkPitch(
  chatId: number,
  playerId: number,
  player: { name: string; telegram_id: number | null; telegram_handle: string | null },
  onboardingTopicId?: number,
) {
  setSession(chatId, "qqpk_pitch_sent" as Step, playerId, player.telegram_id);
  if (player.telegram_id) trackOnboardingStep(player.telegram_id, "pitch_sent");

  const tid = onboardingTopicId;
  const tag = mentionOf(player);
  await sendMsg(chatId,
    `${tag}\n\n🃏 <b>${player.name}</b> — deal STAKING QQPK !`,
    tid
  );
  await sleep(2000);
  await sendMsg(chatId,
    `💰 Tu joues avec ton bankroll. Le Cercle porte <b>70% de tes pertes</b>, tu portes 30%.\n\n` +
    `📈 Sur les gains : tu gardes <b>70%</b>, le Cercle prend 30%.\n\n` +
    `🔄 <b>Règlement mensuel</b> (ton cycle démarre aujourd'hui), avec makeup : tes pertes avancées sont remboursées par tes gains avant tout partage.\n\n` +
    `🎯 <b>Condition : minimum 30 000 mains</b> sur le mois. En dessous, tes pertes ne sont PAS couvertes (mais le partage des gains s'applique quand même).\n\n` +
    `⚖️ Le partage 70/30 se calcule sur ton <b>net cumulé du mois</b>, pas semaine par semaine.\n\n` +
    `🔚 <b>Fin de mois</b> : on settle, tu fais un full cash out, et on repart à zéro pour le mois suivant.`,
    tid
  );
  await sleep(3000);
  // Anti-bypass: le lien Mini App n'est PAS dans le pitch. Il n'arrive qu'après
  // un clic explicite sur "J'accepte" (handleQqpkCallback → qqpk_accept).
  await sendMsgKeyboard(chatId, `Tu valides le deal ?`, [
    [{ text: "✅ J'accepte le deal", callback_data: "qqpk_accept" }],
    [{ text: "❓ J'ai une question", callback_data: "qqpk_choice_question" }],
  ], tid);
}
