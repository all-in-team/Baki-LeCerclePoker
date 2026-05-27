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

  // ref_<affiliate_id> deep link: prospect referred by an affiliate
  if (payload?.startsWith("ref_")) {
    const affiliateId = parseInt(payload.slice(4));
    const profile = db.prepare(`SELECT 1 FROM affiliate_profiles WHERE affiliate_player_id = ?`).get(affiliateId);
    if (profile && from?.username) {
      const handle = from.username.toLowerCase();
      const existingLead = db.prepare(
        `SELECT 1 FROM affiliate_leads WHERE LOWER(referred_handle) = ? AND status IN ('pending', 'converted')`
      ).get(handle);
      if (!existingLead) {
        db.prepare(
          `INSERT INTO affiliate_leads (affiliate_player_id, referred_handle, status) VALUES (?, ?, 'pending')`
        ).run(affiliateId, handle);
        console.log(`[AFFILIATE] Lead created via ref_ deep link: affiliate=${affiliateId} handle=@${handle}`);
      }
    }
    // Continue with normal onboarding (handleOnboardingDirect will detect the lead)
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
