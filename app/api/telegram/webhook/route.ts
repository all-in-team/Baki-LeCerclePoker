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
  handleNutspkCallback,
  handleStartNutspk,
  handleQqpkCallback,
  handleStartQqpk,
  handleAapkmyCallback,
  handleOkpokerCallback,
  handleStartOkpoker,
  handleJvipCallback,
  handleStartJvip,
  handleTtpokerCallback,
  handleStartTtpoker,
  handleWnCallback,
  handleStartWn,
  handleAffiliation,
  handleMyAffi,
  handleStartAffi,
  handleStartAapkmy,
  handleLinkGroup,
  handleFixGroup,
  sendMsg, answerCbQuery, getSession, handleRawMessage, registerCommandHandlers,
  OWNER_IDS, AGENT_CHAT_ID,
} from "@/lib/telegram-commands";
import { sendMsgKeyboard, editMessageReplyMarkup } from "@/lib/telegram-commands/helpers";
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

  // ── Idempotence des updates ─────────────────────────────────────────────────────────────────
  // Telegram rejoue un update quand le webhook dépasse son délai de réponse : c'est la cause
  // documentée des doubles créations de groupe et du double message de bienvenue de ce repo
  // (cf. migration add_nexa_group_claim_v1). Aucun traitement n'a jamais besoin d'être rejoué
  // à l'identique — on coupe donc en amont, une fois pour toutes, plutôt que de multiplier les
  // verrous par feature. Fail-open : si la table est absente, l'update passe (cf. isDuplicateUpdate).
  try {
    const { isDuplicateUpdate } = await import("@/lib/funnels/live-takeover");
    if (isDuplicateUpdate(update?.update_id)) {
      console.log(`[WEBHOOK] update ${update.update_id} déjà traité — ignoré`);
      return NextResponse.json({ ok: true });
    }
  } catch (e: any) {
    console.error("[WEBHOOK] dedup indisponible:", e?.message ?? e);
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

  // ── Dernière activité joueur ────────────────────────────────────────────────────────────────
  // Point d'écriture unique de `onboarding_leads.last_player_activity_at`, lue par les relances
  // d'onboarding pour ne jamais relancer un joueur vivant (incident YuS du 30/07).
  //
  // Ici, `logFrom` vient de `update.*.from.id` : c'est le telegram_id donné par Telegram, pas une
  // résolution depuis un chat_id. Combiné à l'UNIQUE sur `onboarding_leads.telegram_id`, l'UPDATE
  // touche 0 ou 1 ligne — une attribution à un mauvais lead est structurellement impossible.
  //
  // Deux gardes : `OWNER_IDS` (tes propres messages ne sont pas de l'activité joueur) et le chat
  // agent (flux opérateur). On ne retient que `message` et `callback` : des actions délibérées du
  // joueur. Les événements d'appartenance (`chat_member`, `new_members`) sont écartés — leur
  // `from.id` est l'auteur de l'action, pas nécessairement le joueur concerné.
  if ((updateType === "message" || updateType === "callback")
      && typeof logFrom === "number"
      && !OWNER_IDS.has(logFrom)
      && String(logChat) !== String(AGENT_CHAT_ID)) {
    try {
      const { getDb } = await import("@/lib/db");
      const r = getDb().prepare(
        `UPDATE onboarding_leads SET last_player_activity_at = datetime('now') WHERE telegram_id = ?`
      ).run(logFrom);
      // `changes === 0` = interaction non rattachable à un lead. C'est LE signal qui rendrait
      // visible une régression de ce câblage : sans ce log, une écriture qui n'atteint jamais sa
      // cible est parfaitement silencieuse, et les relances repartiraient sur des joueurs actifs.
      if (r.changes === 0) {
        console.log(`[ACTIVITY] aucun lead pour from=${logFrom} chat=${logChat} type=${updateType}`);
      }
    } catch (e: any) {
      console.error(`[ACTIVITY] echec ecriture from=${logFrom}:`, e?.message ?? e);
    }
  }

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
    } else if (cbData.startsWith("nutspk_")) {
      await handleNutspkCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("qqpk_")) {
      await handleQqpkCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("aapk_")) {
      await handleAapkmyCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("okpoker_")) {
      await handleOkpokerCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("jvip_")) {
      await handleJvipCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("ttpoker_")) {
      await handleTtpokerCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("wn_")) {
      await handleWnCallback(cb.id, cbData, cbChatId, cbThreadId, cb.from, cb.message?.message_id);
    } else if (cbData.startsWith("qf_")) {
      const { handleQqpkFunnelCallback } = await import("@/lib/qqpk-funnel");
      await handleQqpkFunnelCallback(cb.id, cbData, cbChatId, cb.from);
    } else if (cbData.startsWith("nf_")) {
      const { handleNexaFunnelCallback } = await import("@/lib/nexa-funnel");
      await handleNexaFunnelCallback(cb.id, cbData, cbChatId, cb.from);
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
    } else if (cbData.startsWith("agentact:")) {
      // Seul chemin d'exécution d'une action de l'agent.
      // Double verrou : OWNER_IDS ici (le bouton vit dans un groupe, n'importe
      // quel membre peut cliquer), puis "le confirmeur est le demandeur" dans
      // executeAction(). Le clavier est retiré dans tous les cas pour qu'un
      // bouton mort ne traîne pas.
      const [, verb, rawId] = cbData.split(":");
      const actionId = Number(rawId);
      if (!OWNER_IDS.has(cb.from?.id)) {
        console.warn(`[TG AGENTACT] non-owner refusé: user_id=${cb.from?.id} action=${actionId}`);
        await answerCbQuery(cb.id, "⛔ Réservé à l'opérateur.");
      } else if (!Number.isInteger(actionId)) {
        await answerCbQuery(cb.id, "Action illisible.");
      } else {
        const { executeAction, cancelAction, escapeHtml } = await import("@/lib/agent-actions");
        const res = verb === "ok"
          ? await executeAction(actionId, cb.from.id)
          : cancelAction(actionId, cb.from.id);
        await answerCbQuery(cb.id, res.ok ? "OK" : "Refusé");
        if (cbChatId && cb.message?.message_id) {
          await editMessageReplyMarkup(cbChatId, cb.message.message_id);
        }
        // res.text ne contient aucun balisage voulu, mais il interpole des noms
        // venus de la base (players.name vient de Telegram) et des messages
        // d'erreur. sendMsg force parse_mode HTML et avale l'échec d'envoi en le
        // loggant : un seul "<" dans un nom ferait donc disparaître la
        // confirmation d'un paiement déjà exécuté. On échappe tout le message.
        if (cbChatId) await sendMsg(cbChatId, escapeHtml(res.text), cbThreadId);
      }
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

  // ── Chat admin : réponse d'opérateur à un lead ──────────────────────────────────────────────
  // AVANT le bloc agent Claude, volontairement : si ADMIN_CHAT_ID et AGENT_TELEGRAM_CHAT_ID
  // pointaient par erreur sur le même chat, une réponse à un lead serait sinon avalée par
  // l'agent.
  //
  // Depuis la bascule Sujets, le déclencheur n'est plus « Répondre » mais le SUJET : tout
  // message posté dans le topic d'un lead lui part. On ne peut donc plus filtrer sur
  // `reply_to_message` en amont — c'est handleAdminChatMessage qui décide, et il ne consomme
  // que ce qui se résout vers un lead (par thread, ou par relay_map en repli). General et le
  // reste du chat continuent leur chemin normal.
  if (msg && !msg.from?.is_bot) {
    try {
      const { handleAdminChatMessage } = await import("@/lib/funnels/live-takeover");
      if (await handleAdminChatMessage(msg)) return NextResponse.json({ ok: true });
    } catch (e: any) {
      console.error("[TG ADMIN RELAY]", e?.message ?? e);
    }
  }

  // Agent chat: in the dedicated agent group, route ALL non-command text
  // messages to Claude.
  //
  // ⚠️ OWNER_IDS est OBLIGATOIRE ici, en plus du filtre sur le groupe (Baki 2026-07-27).
  // L'agent lit toute la base via ses outils (P&L, wallets, joueurs, query_db en
  // lecture seule) : l'appartenance au groupe ne peut pas être la seule barrière —
  // ajouter quelqu'un au groupe lui donnerait l'accès complet. Fail-closed :
  // `from.id` absent → `OWNER_IDS.has(undefined)` est faux → pas de routage.
  // Un non-owner est ignoré en silence (pas de réponse : ne pas confirmer la
  // présence de l'agent, ne pas brûler de tokens).
  if (
    msg?.text &&
    String(chatId) === AGENT_CHAT_ID &&
    !msg.from?.is_bot &&
    !msg.text.startsWith("/")
  ) {
    if (!OWNER_IDS.has(msg.from?.id)) {
      console.warn(`[TG AGENT CHAT] non-owner ignoré: user_id=${msg.from?.id} username=@${msg.from?.username ?? "none"}`);
      return NextResponse.json({ ok: true });
    }
    try {
      const reply = await runChat({ chatId, userText: msg.text, userId: msg.from?.id });
      await sendMsg(chatId, reply);

      // Une action mise en attente pendant ce tour n'existe qu'en base : c'est
      // ICI qu'elle devient cliquable. Tant que l'opérateur n'a pas cliqué,
      // rien n'a été exécuté (cf. lib/agent-actions.ts).
      const { listUnnotifiedActions, markNotified } = await import("@/lib/agent-actions");
      for (const p of listUnnotifiedActions(String(chatId))) {
        await sendMsgKeyboard(
          chatId,
          `⏸ <b>Confirmation requise</b> · action #${p.id}${p.level === "sensitive" ? " · ⚠️ SENSIBLE" : ""}\n\n${p.preview}\n\n<i>Expire dans 10 min. Rien n'est exécuté sans ton clic.</i>`,
          [[
            { text: "✅ Confirmer", callback_data: `agentact:ok:${p.id}` },
            { text: "❌ Annuler", callback_data: `agentact:no:${p.id}` },
          ]],
        );
        markNotified(p.id);
      }
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

  // /fixgroup — robust repair of the current group (session check + find-or-create all topics)
  if (msg?.text?.match(/^\/fixgroup(\s|$|@)/)) {
    await handleFixGroup(chatId, msg.from?.id, msg.chat?.type ?? "private", msg.chat?.title ?? "");
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
      else if (cmd === "/startnutspk" || cmd === "/start_nutspk") await handleStartNutspk(chatId);
      else if (cmd === "/startqqpk" || cmd === "/start_qqpk") await handleStartQqpk(chatId);
      else if (cmd === "/startaapkmy" || cmd === "/start_aapkmy") await handleStartAapkmy(chatId, threadId);
      else if (cmd === "/startokpoker" || cmd === "/start_okpoker") await handleStartOkpoker(chatId);
      else if (cmd === "/startjvip" || cmd === "/start_jvip") await handleStartJvip(chatId);
      else if (cmd === "/startttpoker" || cmd === "/start_ttpoker") await handleStartTtpoker(chatId);
      else if (cmd === "/startwn" || cmd === "/start_wn") await handleStartWn(chatId);
    } catch (e: any) {
      console.error("[TG CMD]", e);
      await sendMsg(chatId, `❌ Erreur : ${e.message}`);
    }
    return NextResponse.json({ ok: true });
  }

  // ── Live takeover : capture de TOUT message entrant d'un lead ───────────────────────────────
  // Placé APRÈS les blocs de commandes (qui retournent) et AVANT tout handler qui répondrait :
  // un message de lead doit être persisté et relayé même quand le scénario sait quoi en faire
  // (l'historique de conversation doit être complet, takeover ou pas — §1 du brief).
  //
  // Trois exclusions, dans cet ordre : les commandes (`/…`), les bots, et les clics de bouton
  // (qui sont des callback_query et ne passent pas par ici du tout).
  //
  // `takeoverActive` coupe la suite : pendant qu'un humain a la main, le bot ne doit produire
  // AUCUNE réponse scriptée au texte libre — sinon le lead entend deux voix. Les clics de
  // bouton, eux, restent fonctionnels (ils passent par le bloc callback_query, plus haut).
  if (msg && msg.chat?.type === "private" && msg.from?.id && !msg.from.is_bot
      && !(typeof msg.text === "string" && msg.text.startsWith("/"))) {
    try {
      const { captureLeadInbound } = await import("@/lib/funnels/live-takeover");
      const captured = await captureLeadInbound(msg);
      if (captured?.duplicate) return NextResponse.json({ ok: true });
      if (captured?.takeoverActive) return NextResponse.json({ ok: true });
    } catch (e: any) {
      // Le relais ne doit jamais faire tomber le funnel : on logge et on continue.
      console.error("[TG TAKEOVER CAPTURE]", e?.message ?? e);
    }
  }

  // Funnels de room (QQPK, Nexa) — DM d'un lead : capture de l'ID joueur / reprise
  // d'étape. Les leads ne sont pas des players ; si une vraie session d'onboarding
  // existe sur ce chat (lead devenu player via le funnel normal), elle est
  // prioritaire → on ne touche pas au message. Le dispatcher choisit le funnel où
  // le lead a été actif le plus récemment.
  if (msg?.text && !msg.text.startsWith("/") && msg.chat?.type === "private" && msg.from?.id && !getSession(chatId)) {
    try {
      const { dispatchFunnelDm } = await import("@/lib/funnels/dm-dispatcher");
      const handled = await dispatchFunnelDm(chatId, msg.from.id, msg.text);
      if (handled) return NextResponse.json({ ok: true });
    } catch (e: any) {
      console.error("[TG FUNNEL DM]", e?.message ?? e);
    }
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

  // New members. `markGroupJoined` horodate le join dans `group_creations` (Hugo
  // 2026-07-25) : sans ça, aucune trace de « a rejoint » et le job 24 h ne peut pas
  // distinguer un groupe vivant d'un groupe fantôme. Appelé APRÈS handleNewMembers,
  // qui crée la ligne `players` et branche telegram_group_id.
  if (msg?.new_chat_members) {
    await handleNewMembers(msg.new_chat_members, msg.chat?.title ?? "", chatId);
    const { markGroupJoined } = await import("@/lib/group-lifecycle");
    for (const m of msg.new_chat_members) {
      if (!m?.is_bot) markGroupJoined(chatId, m?.id);
    }
    return NextResponse.json({ ok: true });
  }
  const cm = update.chat_member;
  if (cm?.new_chat_member?.status === "member" && !cm.new_chat_member.user?.is_bot) {
    await handleNewMembers([cm.new_chat_member.user], cm.chat?.title ?? "", cm.chat?.id);
    const { markGroupJoined } = await import("@/lib/group-lifecycle");
    markGroupJoined(cm.chat?.id, cm.new_chat_member.user?.id);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error(`[WEBHOOK_CRASH] Unhandled error processing update ${update?.update_id}:`, e?.message ?? e, e?.stack);
    return NextResponse.json({ ok: true });
  }
}
