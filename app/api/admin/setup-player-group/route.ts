import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createPlayerGroup } from "@/lib/telegram-userbot";
import { sendMsg } from "@/lib/telegram-commands/helpers";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { player_id, telegram_id, telegram_handle } = body;
  if (!player_id) return NextResponse.json({ error: "player_id required" }, { status: 400 });

  const db = getDb();
  const player = db.prepare(`SELECT id, name, telegram_id, telegram_group_id FROM players WHERE id = ?`).get(player_id) as any;
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });

  if (player.telegram_group_id) {
    return NextResponse.json({ error: "Player already has a group", group_id: player.telegram_group_id }, { status: 409 });
  }

  const tgId = telegram_id ?? player.telegram_id;
  if (!tgId) return NextResponse.json({ error: "No telegram_id found — pass telegram_id in body" }, { status: 400 });

  // Update telegram_id and handle if provided
  if (telegram_id || telegram_handle) {
    const updates: string[] = [];
    const params: any[] = [];
    if (telegram_id) { updates.push("telegram_id = ?"); params.push(telegram_id); }
    if (telegram_handle) { updates.push("telegram_handle = ?"); params.push(telegram_handle); }
    params.push(player_id);
    db.prepare(`UPDATE players SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? "";
  const result = await createPlayerGroup(tgId, player.name, botToken, telegram_handle);

  if (!result) {
    return NextResponse.json({ error: "Userbot not configured or group creation failed" }, { status: 500 });
  }

  // Patch player row with group data
  const groupId = String(result.chatId);
  db.prepare(`
    UPDATE players SET
      telegram_id = ?,
      telegram_chat_id = ?,
      telegram_group_id = ?,
      alertes_topic_id = ?,
      liveplay_topic_id = ?,
      accounting_topic_id = ?,
      deals_topic_id = ?,
      clubs_topic_id = ?,
      depot_topic_id = ?,
      onboarding_topic_id = ?
    WHERE id = ?
  `).run(
    tgId,
    groupId,
    groupId,
    result.topicIds.alertes ?? null,
    result.topicIds.liveplay ?? null,
    result.topicIds.accounting ?? null,
    result.topicIds.deals ?? null,
    result.topicIds.clubs ?? null,
    result.topicIds.depot ?? null,
    result.topicIds.onboarding ?? null,
    player_id,
  );

  // Send topic welcome messages
  const TOPIC_MESSAGES: Record<string, string> = {
    alertes: `📢 <b>Alertes</b>\n\nCe canal sert aux annonces importantes de Le Cercle.`,
    liveplay: `🔴 <b>Liveplay</b>\n\nIci seront postés les liveplay des différentes games.`,
    accounting: `📊 <b>Accounting</b>\n\nCe canal sert au suivi de ta bankroll.\n\nCommandes :\n<code>/solde</code> — ton solde\n<code>/historique</code> — tes transactions`,
    deals: `📋 <b>Deals</b>\n\nIci tu trouveras tous les deals actifs.`,
    clubs: `🏠 <b>Clubs</b>\n\nTous les clubs disponibles sont listés ici.`,
    depot: `💳 <b>Dépôt</b>\n\n⚠️ Toujours demander confirmation AVANT d'envoyer.`,
  };

  for (const [key, msg] of Object.entries(TOPIC_MESSAGES)) {
    const topicId = result.topicIds[key];
    if (topicId) {
      try { await sendMsg(result.chatId, msg, topicId); } catch {}
    }
  }

  // Upsert onboarding_leads
  db.prepare(`
    INSERT INTO onboarding_leads (telegram_id, telegram_username, first_name, stage)
    VALUES (?, ?, ?, 'joined')
    ON CONFLICT(telegram_id) DO UPDATE SET stage = 'joined', last_seen = datetime('now')
  `).run(tgId, telegram_handle ?? null, player.name);

  const updated = db.prepare(`SELECT * FROM players WHERE id = ?`).get(player_id);

  return NextResponse.json({
    ok: true,
    player: updated,
    group: {
      chat_id: result.chatId,
      invite_link: result.inviteLink,
      topic_ids: result.topicIds,
      status: result.status,
      bot_promoted: result.botPromoted,
      failed_steps: result.failedSteps,
      errors: result.errors,
    },
  });
}
