import { NextRequest, NextResponse } from "next/server";
import { runChat } from "@/lib/agent-chat";
import {
  handleDeal, handleTx, handleTransfer, handleWallet, handleReset,
  handleCheck, handlePnl, handleSolde, handleTodo, handleHistorique,
  handleKickstart, handleAide, handleRapports, handleStart,
  handlePlayerSelfService, handleNewMembers,
  handleOnboard, handleOnboardCallback, handlePitchCallback,
  handleBroadcast, handleBroadcastCallback,
  handleCashoutDoneCallback,
  handleCashoutSkippedCallback,
  handleKkpokerCallback,
  handleStartKkpoker,
  handleA5pokerCallback,
  handleStartA5poker,
  handleAksCallback,
  handleStartAks,
  handleQqpkCallback,
  handleStartQqpk,
  handleAapkmyCallback,
  handleAffiliation,
  handleMyAffi,
  handleStartAffi,
  handleStartAapkmy,
  handleLinkGroup,
  sendMsg, answerCbQuery, getSession, handleRawMessage, registerCommandHandlers,
  OWNER_IDS, AGENT_CHAT_ID,
} from "@/lib/telegram-commands";
// Register command handlers for the raw-message flow (breaks circular dep)
registerCommandHandlers({
  handleDeal,
  handleTx,
  handleReset,
});

// ── Main POST handler ─────────────────────────────────────
export async function POST(req: NextRequest) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret) {
    const incoming = req.headers.get("x-telegram-bot-api-secret-token");
    if (incoming !== secret) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch (e: any) {
    console.error("[WEBHOOK] Failed to parse JSON:", e.message);
    return NextResponse.json({ ok: true });
  }

  try {
  const updateType = update.callback_query ? "callback" : update.message?.new_chat_members ? "new_members" : update.message ? "message" : update.chat_member ? "chat_member" : "other";
  const logChat = update.message?.chat?.id ?? update.chat_member?.chat?.id ?? update.callback_query?.message?.chat?.id ?? "?";
  const logFrom = update.message?.from?.id ?? update.chat_member?.from?.id ?? update.callback_query?.from?.id ?? "?";
  const logText = update.message?.text?.slice(0, 60) ?? "";
  console.log(`[WEBHOOK_RAW] type=${updateType} chat=${logChat} from=${logFrom} text="${logText}"`);

  // DB-based webhook trace (queryable via db-diagnostic)
  try {
    const { getDb } = await import("@/lib/db");
    getDb().prepare(`INSERT INTO settings (key, value) VALUES ('_webhook_last', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(JSON.stringify({ ts: new Date().toISOString(), type: updateType, chat: logChat, from: logFrom, text: logText, thread: update.message?.message_thread_id }));
  } catch {}

  // Handle inline keyboard button clicks
  if (update.callback_query) {
    const cb = update.callback_query;
    const cbData: string = cb.data ?? "";
    const cbChatId = cb.message?.chat?.id;
    const cbThreadId = cb.message?.message_thread_id;

    if (cbData.startsWith("kk_")) {
      await handleKkpokerCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("a5_")) {
      await handleA5pokerCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("aks_")) {
      await handleAksCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("qqpk_")) {
      await handleQqpkCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("aapk_")) {
      await handleAapkmyCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("onboard:")) {
      await handleOnboardCallback(cb.id, cbData, cbChatId, cbThreadId);
    } else if (cbData.startsWith("onboard_")) {
      await handlePitchCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("cashout_done:")) {
      await handleCashoutDoneCallback(cb.id, cbData, cbChatId, cb.message?.message_id, cbThreadId);
    } else if (cbData.startsWith("cashout_skipped:")) {
      await handleCashoutSkippedCallback(cb.id, cbData, cbChatId, cb.message?.message_id, cbThreadId);
    } else if (cbData.startsWith("bc_")) {
      await handleBroadcastCallback(cb.id, cbData, cb.message);
    } else {
      await answerCbQuery(cb.id);
    }
    return NextResponse.json({ ok: true });
  }

  const msg = update.message;
  const chatId = msg?.chat?.id;
  const threadId = msg?.message_thread_id;

  // Debug log every incoming message sender (helps verify owner ID)
  if (msg?.from?.id) {
    console.log(`[TG] msg from user_id=${msg.from.id} username=@${msg.from.username ?? "none"} text="${msg.text?.slice(0, 30) ?? ""}"`);
  }

  // Agent chat: in the dedicated agent group, route ALL non-command text
  // messages to Claude.
  if (
    msg?.text &&
    String(chatId) === AGENT_CHAT_ID &&
    !msg.from?.is_bot &&
    !msg.text.startsWith("/")
  ) {
    try {
      const reply = await runChat({ chatId, userText: msg.text });
      await sendMsg(chatId, reply);
    } catch (e: any) {
      console.error("[TG AGENT CHAT]", e);
      await sendMsg(chatId, `❌ Erreur agent : ${e.message ?? String(e)}`);
      const { notifyOpsError } = await import("@/lib/ops-notifications");
      await notifyOpsError("agent-chat", e.message ?? String(e)).catch(() => {});
    }
    return NextResponse.json({ ok: true });
  }

  // /start is available to ALL users
  if (msg?.text?.match(/^\/start(\s|$|@)/)) {
    const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Utilisateur";
    // Extract deep-link payload: "/start kkpoker" → payload = "kkpoker"
    const startParts = msg.text.split(/\s+/);
    const payload = startParts.length > 1 ? startParts[1].toLowerCase() : undefined;
    await handleStart(chatId, msg.from?.id, fromName, msg.from, payload);
    return NextResponse.json({ ok: true });
  }

  // /affiliation — available to all users in their player group
  if (msg?.text?.match(/^\/affiliation(\s|$|@)/)) {
    await handleAffiliation(chatId, msg.from?.id, threadId);
    return NextResponse.json({ ok: true });
  }

  // /myaffi — affiliate Mini App (DM=web_app button, group=deep link to DM)
  if (msg?.text?.match(/^\/myaffi(\s|$|@)/)) {
    await handleMyAffi(chatId, msg.from?.id, msg.chat?.type ?? "private");
    return NextResponse.json({ ok: true });
  }

  // /startaffi — activate player as affiliate (group only)
  if (msg?.text?.match(/^\/startaffi(\s|$|@)/)) {
    await handleStartAffi(chatId, msg.from?.id, msg.chat?.type ?? "private", threadId);
    return NextResponse.json({ ok: true });
  }

  // /linkgroup — associate orphan group with a player (owner only)
  if (msg?.text?.match(/^\/linkgroup(\s|$|@)/)) {
    const linkArgs = msg.text.replace(/^\/linkgroup(@\S+)?\s*/, "");
    await handleLinkGroup(chatId, msg.from?.id, msg.chat?.type ?? "private", linkArgs, msg.chat?.title ?? "");
    return NextResponse.json({ ok: true });
  }

  // Player self-service commands (any user linked via telegram_id)
  if (msg?.text?.startsWith("/") && msg.from?.id && !OWNER_IDS.has(msg.from?.id)) {
    const handled = await handlePlayerSelfService(chatId, msg.from.id, msg.text, threadId);
    if (handled) return NextResponse.json({ ok: true });
  }

  // Commands (owner only)
  if (msg?.text?.startsWith("/") && OWNER_IDS.has(msg.from?.id)) {
    const spaceIdx = msg.text.indexOf(" ");
    const rawCmd = spaceIdx === -1 ? msg.text : msg.text.slice(0, spaceIdx);
    const rawArgs = spaceIdx === -1 ? "" : msg.text.slice(spaceIdx + 1);
    const cmd = rawCmd.split("@")[0].toLowerCase();
    try {
      if (cmd === "/onboard")           await handleOnboard(rawArgs, chatId, msg.chat?.title, threadId);
      else if (cmd === "/deal")         await handleDeal(rawArgs, chatId);
      else if (cmd === "/depot")        await handleTx("deposit", rawArgs, chatId);
      else if (cmd === "/retrait")      await handleTx("withdrawal", rawArgs, chatId);
      else if (cmd === "/transfer")     await handleTransfer(rawArgs, chatId);
      else if (cmd === "/wallet")       await handleWallet(rawArgs, chatId);
      else if (cmd === "/reset")        await handleReset(rawArgs, chatId);
      else if (cmd === "/check")        await handleCheck(rawArgs, chatId);
      else if (cmd === "/pnl")          await handlePnl(rawArgs, chatId);
      else if (cmd === "/solde")        await handleSolde(rawArgs, chatId);
      else if (cmd === "/todo")         await handleTodo(chatId);
      else if (cmd === "/kickstart")    await handleKickstart(chatId);
      else if (cmd === "/historique")   await handleHistorique(rawArgs, chatId);
      else if (cmd === "/rapports")     await handleRapports(chatId);
      else if (cmd === "/aide" || cmd === "/help") await handleAide(chatId);
      else if (cmd === "/broadcast")   await handleBroadcast(msg, chatId);
      else if (cmd === "/startkkpoker" || cmd === "/start_kkpoker") await handleStartKkpoker(chatId);
      else if (cmd === "/starta5poker" || cmd === "/start_a5poker") await handleStartA5poker(chatId);
      else if (cmd === "/startaks" || cmd === "/start_aks") await handleStartAks(chatId);
      else if (cmd === "/startqqpk" || cmd === "/start_qqpk") await handleStartQqpk(chatId);
      else if (cmd === "/startaapkmy" || cmd === "/start_aapkmy") await handleStartAapkmy(chatId, threadId);
    } catch (e: any) {
      console.error("[TG CMD]", e);
      await sendMsg(chatId, `❌ Erreur : ${e.message}`);
    }
    return NextResponse.json({ ok: true });
  }

  // Raw message → guided onboarding flow (action %, addresses)
  if (msg?.text && !msg.text.startsWith("/")) {
    const text = msg.text.trim();
    const senderId: number = msg.from?.id;
    const session = getSession(chatId);
    if (session) {
      const isOwner = OWNER_IDS.has(senderId);
      let isExpectedPlayer = session.expected_tg_id != null && senderId === session.expected_tg_id;

      // AUTO-HEAL: a session is bound to a player but expected_tg_id is NULL because the
      // player has no telegram_id (e.g. linked via /linkgroup, which only sets the group).
      // Such a player can click buttons (callbacks bypass this gate) but every text message
      // — wallet addresses, custom %, etc. — was silently dropped here, freezing the flow.
      // If the message comes from that player's OWN linked group, adopt the sender:
      // backfill players.telegram_id and pin the session to them, then process normally.
      // Guard: only when the player's telegram_id is still NULL or already equals the sender,
      // and the chat is exactly that player's telegram_group_id — so no one can be mis-assigned.
      if (!isOwner && !isExpectedPlayer && session.expected_tg_id == null && session.player_id && senderId) {
        try {
          const { getDb } = await import("@/lib/db");
          const db = getDb();
          const p = db.prepare(`SELECT telegram_group_id, telegram_id FROM players WHERE id = ?`)
            .get(session.player_id) as { telegram_group_id: string | null; telegram_id: number | null } | undefined;
          if (p && p.telegram_group_id && String(p.telegram_group_id) === String(chatId)
              && (p.telegram_id == null || p.telegram_id === senderId)) {
            if (p.telegram_id == null) {
              db.prepare(`UPDATE players SET telegram_id = ? WHERE id = ?`).run(senderId, session.player_id);
            }
            db.prepare(`UPDATE telegram_sessions SET expected_tg_id = ? WHERE chat_id = ?`).run(senderId, String(chatId));
            isExpectedPlayer = true;
            console.log(`[AUTO-HEAL] player ${session.player_id} adopted telegram_id=${senderId} from its group ${chatId} (was NULL) — session unblocked`);
          }
        } catch (e: any) {
          console.error("[AUTO-HEAL] failed:", e?.message ?? e);
        }
      }

      if (isOwner || isExpectedPlayer) {
        try { await handleRawMessage(text, chatId, threadId); } catch (e: any) {
          console.error("[TG FLOW]", e);
        }
        return NextResponse.json({ ok: true });
      }
    }
  }

  // Photo/document handling — AAPKMY deposit proof forwarding
  if (msg?.photo || msg?.document) {
    const senderId: number = msg.from?.id;
    const session = getSession(chatId);
    if (session && session.step === "aapkmy_waiting_proof") {
      const isOwner = OWNER_IDS.has(senderId);
      const isExpectedPlayer = session.expected_tg_id != null && senderId === session.expected_tg_id;
      if (isOwner || isExpectedPlayer) {
        try {
          const { handleAapkmyPhoto } = await import("@/lib/games/aapkmy/onboarding");
          await handleAapkmyPhoto(chatId, session as any, msg, threadId);
        } catch (e: any) {
          console.error("[TG AAPK PHOTO]", e);
        }
        return NextResponse.json({ ok: true });
      }
    }
  }

  // Catch-all: unknown user sends non-command text in private DM → nudge to /start
  if (msg?.text && !msg.text.startsWith("/") && msg.chat?.type === "private") {
    await sendMsg(chatId, "👋 Envoie <b>/start</b> pour commencer !");
    return NextResponse.json({ ok: true });
  }

  // New members
  if (msg?.new_chat_members) {
    await handleNewMembers(msg.new_chat_members, msg.chat?.title ?? "", chatId);
    return NextResponse.json({ ok: true });
  }
  const cm = update.chat_member;
  if (cm?.new_chat_member?.status === "member" && !cm.new_chat_member.user?.is_bot) {
    await handleNewMembers([cm.new_chat_member.user], cm.chat?.title ?? "", cm.chat?.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error(`[WEBHOOK_CRASH] Unhandled error processing update ${update?.update_id}:`, e?.message ?? e, e?.stack);
    return NextResponse.json({ ok: true });
  }
}
