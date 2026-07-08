import { getDb } from "@/lib/db";
import { sendMsg, OWNER_IDS } from "./helpers";
import { handleOnboardingDirect } from "./onboarding";
import { handleMyAffi } from "./myaffi";

export async function handleStart(chatId: number, fromId: number, fromName: string, from?: any, payload?: string) {
  const db = getDb();

  if (payload === "myaffi") {
    await handleMyAffi(chatId, fromId, "private");
    return;
  }

  // ref_<affiliate_id> deep link: prospect referred by an affiliate.
  // Attribution is keyed on the referred user's telegram_id so it survives a missing
  // @username (referred_handle is NOT NULL → store a synthetic "tg:<id>" when no handle).
  // Conversion (handleNewMembers) then matches by telegram_id, never losing the lead.
  if (payload?.startsWith("ref_")) {
    const affiliateId = parseInt(payload.slice(4));
    const profile = db.prepare(`SELECT 1 FROM affiliate_profiles WHERE affiliate_player_id = ?`).get(affiliateId);
    if (profile && fromId) {
      const handle = from?.username ? from.username.toLowerCase() : `tg:${fromId}`;
      const existingLead = db.prepare(
        `SELECT 1 FROM affiliate_leads
         WHERE status IN ('pending', 'converted')
           AND (referred_telegram_id = ? OR LOWER(referred_handle) = ?)`
      ).get(fromId, handle);
      if (!existingLead) {
        // Defensive: a near-simultaneous re-click could collide on UNIQUE(referred_handle,
        // status). Never let that abort the normal onboarding that follows.
        try {
          db.prepare(
            `INSERT INTO affiliate_leads (affiliate_player_id, referred_handle, referred_telegram_id, status) VALUES (?, ?, ?, 'pending')`
          ).run(affiliateId, handle, fromId);
          console.log(`[AFFILIATE] Lead created via ref_ deep link: affiliate=${affiliateId} tg_id=${fromId} handle=${handle}`);
        } catch (e: any) {
          console.warn(`[AFFILIATE] ref_ lead insert skipped (likely dup race): ${e?.message ?? e}`);
        }
      }
    }
    // Continue with normal onboarding (handleNewMembers will convert by telegram_id/handle)
  }

  if (payload === "kkpoker") {
    await handleOnboardingDirect(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    }, "KKPOKER");
    return;
  }

  if (payload === "a5poker") {
    await handleOnboardingDirect(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    }, "A5POKER");
    return;
  }

  // OKPOKER deep link — DM-only flow (chatId === fromId in a private chat), no group
  // creation: pitch + wallets happen directly in the DM. The player never chooses his
  // % (existing deal kept, otherwise the game default). Typed in a group, it falls
  // through to the normal /start behavior below.
  if (payload === "okpoker" && chatId === fromId) {
    const { handleOkpokerDeepLink } = await import("@/lib/games/okpoker/onboarding");
    await handleOkpokerDeepLink(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    });
    return;
  }

  // JVIP deep link — same DM-only flow as OKPOKER (config-only clone).
  if (payload === "jvip" && chatId === fromId) {
    const { handleJvipDeepLink } = await import("@/lib/games/jvip/onboarding");
    await handleJvipDeepLink(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    });
    return;
  }

  // TTPOKER deep link — same DM-only flow as OKPOKER/JVIP (config-only clone).
  if (payload === "ttpoker" && chatId === fromId) {
    const { handleTtpokerDeepLink } = await import("@/lib/games/ttpoker/onboarding");
    await handleTtpokerDeepLink(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    });
    return;
  }

  const linked = db.prepare(
    `SELECT id, name FROM players WHERE telegram_id = ?`
  ).get(fromId) as { id: number; name: string } | undefined;

  if (linked) {
    db.prepare(`UPDATE players SET telegram_chat_id = ? WHERE id = ?`).run(String(chatId), linked.id);
    await sendMsg(chatId,
      `👋 <b>${linked.name}</b>, tu es connecté !\n\n` +
      `Commandes disponibles :\n` +
      `<code>/solde</code> — ton solde\n` +
      `<code>/historique</code> — tes transactions\n` +
      `<code>/deal</code> — tes deals\n` +
      `<code>/cashout 500</code> — demander un retrait`
    );
  } else if (OWNER_IDS.has(fromId)) {
    await sendMsg(chatId,
      `👋 <b>${fromName}</b> — mode admin actif.`
    );
  } else {
    await handleOnboardingDirect(chatId, {
      id: fromId,
      first_name: from?.first_name ?? fromName,
      last_name: from?.last_name,
      username: from?.username,
    });
  }
}
