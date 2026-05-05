import { NextRequest, NextResponse } from "next/server";
import { runChat } from "@/lib/agent-chat";
import {
  handleDeal, handleTx, handleTransfer, handleWallet, handleReset,
  handleCheck, handlePnl, handleSolde, handleTodo, handleHistorique,
  handleKickstart, handleAide, handleRapports, handleStart,
  handlePlayerSelfService, handleNewMembers,
  handleOnboard, handleOnboardCallback,
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

  const update = await req.json();

  // Handle inline keyboard button clicks
  if (update.callback_query) {
    const cb = update.callback_query;
    const cbData: string = cb.data ?? "";
    const cbChatId = cb.message?.chat?.id;
    const cbThreadId = cb.message?.message_thread_id;

    if (cbData.startsWith("onboard:")) {
      await handleOnboardCallback(cb.id, cbData, cbChatId, cbThreadId);
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
    }
    return NextResponse.json({ ok: true });
  }

  // /start is available to ALL users
  if (msg?.text?.startsWith("/start")) {
    const fromName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Utilisateur";
    await handleStart(chatId, msg.from?.id, fromName, msg.from);
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
      const isExpectedPlayer = session.expected_tg_id != null && senderId === session.expected_tg_id;
      if (isOwner || isExpectedPlayer) {
        try { await handleRawMessage(text, chatId, threadId); } catch (e: any) {
          console.error("[TG FLOW]", e);
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
}
