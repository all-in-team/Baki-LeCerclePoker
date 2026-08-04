import { getDb } from "@/lib/db";
import {
  sendMsg, setSession, clearSession, AGENT_CHAT_ID,
  type Step,
} from "./helpers";
import { isUserbotConfigured, inviteUserToGroup, resolveUsername } from "@/lib/telegram-userbot";
import { provisionGroup } from "@/lib/group-provisioning";
import { TOPIC_MESSAGES } from "./onboarding";

const HANDLE_RE = /^[a-z0-9_]{5,32}$/;

export async function handleAffiliation(chatId: number, fromId: number, threadId?: number) {
  const db = getDb();

  const player = db.prepare(
    `SELECT id, name, telegram_handle, telegram_id FROM players WHERE telegram_group_id = ?`
  ).get(String(chatId)) as { id: number; name: string; telegram_handle: string | null; telegram_id: number | null } | undefined;

  if (!player) {
    await sendMsg(chatId,
      `❌ Cette commande doit être tapée dans le groupe perso d'un player.\nPas en DM, pas dans un groupe random.`,
      threadId
    );
    return;
  }

  setSession(chatId, "affiliation_awaiting_handle" as Step, player.id, player.telegram_id);

  await sendMsg(chatId,
    `🎯 <b>PROGRAMME AGENT — LECERCLEPOKER</b>\n\n` +
    `Tu peux désormais gagner sur les joueurs que tu nous ramènes.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `💰 <b>LE DEAL</b>\n\n` +
    `Tu ramènes un joueur. Sur tout ce que l'agence gagne grâce à lui, <b>tu touches 50%</b>.\n\n` +
    `📌 <i>Exemple concret</i>\n` +
    `Tu ramènes ton pote sur KKPOKER. Sur la semaine, l'agence fait +1 000 USDT grâce à lui.\n` +
    `→ Tu reçois <b>500 USDT</b> direct sur ton wallet.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🎮 <b>LES TAUX EN DÉTAIL</b>\n\n` +
    `▪️ <b>50% des profits agency lifetime</b> sur tous les games onboardés dans les <b>30 premiers jours</b> après l'arrivée de ton filleul\n` +
    `▪️ Après 30 jours, les nouveaux games ne comptent plus\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `📅 <b>PAIEMENT</b>\n\n` +
    `Versé chaque <b>lundi</b> directement sur ton wallet USDT.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `⚖️ <b>LA SEULE PETITE RÈGLE</b>\n\n` +
    `On partage les profits, pas les pertes. Si ton filleul fait une grosse semaine (agence dans le rouge), tu touches 0 cette semaine-là. On récupère sur les semaines suivantes puis ta commission repart.\n\n` +
    `━━━━━━━━━━━━━━━━━━━━\n\n` +
    `🚀 <b>POUR COMMENCER</b>\n\n` +
    `Envoie-moi ici le <b>@handle Telegram</b> du joueur que tu veux ramener 👇\n\n` +
    `⚠️ <b>Important</b> : ton filleul DOIT avoir un @handle Telegram.\n` +
    `S'il n'en a pas, ça prend 10 secondes :\n` +
    `Settings → Username → choisis un @\n\n` +
    `Préviens-le avant de me donner son handle.`,
    threadId
  );
}

export async function handleAffiliationRawMessage(
  text: string,
  chatId: number,
  session: { step: Step; player_id: number; expected_tg_id: number | null; pending_cmd: string | null },
  messageThreadId?: number,
): Promise<boolean> {
  if (session.step !== ("affiliation_awaiting_handle" as Step)) return false;

  const db = getDb();
  const handle = text.trim().replace(/^@/, "").toLowerCase();

  if (!HANDLE_RE.test(handle)) {
    await sendMsg(chatId,
      `❌ Format invalide. Le @handle doit faire 5-32 caractères (lettres/chiffres/underscores). Réessaie.`,
      messageThreadId
    );
    return true;
  }

  const existingPlayer = db.prepare(
    `SELECT 1 FROM players WHERE LOWER(telegram_handle) = ?`
  ).get(handle);
  if (existingPlayer) {
    await sendMsg(chatId,
      `❌ <i>@${handle}</i> est déjà player chez nous. Vérifie le handle.`,
      messageThreadId
    );
    return true;
  }

  const existingLead = db.prepare(
    `SELECT 1 FROM affiliate_leads WHERE LOWER(referred_handle) = ? AND status = 'pending'`
  ).get(handle);
  if (existingLead) {
    await sendMsg(chatId,
      `❌ Quelqu'un est déjà en train d'onboarder <i>@${handle}</i>.`,
      messageThreadId
    );
    return true;
  }

  if (!isUserbotConfigured()) {
    await sendMsg(chatId,
      `❌ Userbot non configuré. Contacte @baki77777.`,
      messageThreadId
    );
    clearSession(chatId);
    return true;
  }

  db.prepare(`INSERT OR IGNORE INTO affiliate_profiles (affiliate_player_id) VALUES (?)`).run(session.player_id);

  const affiliate = db.prepare(`SELECT name FROM players WHERE id = ?`).get(session.player_id) as { name: string } | undefined;
  const affiliateName = affiliate?.name ?? "Affiliate";

  // IDENTITÉ D'ABORD (incident Alexis 2026-08-04). Ce chemin créait le groupe avec
  // `createPlayerGroup(0, …)` : un groupe sans propriétaire Telegram, invisible à toute
  // vérification d'unicité — et un filleul déjà client ailleurs se retrouvait avec deux
  // groupes. On résout d'abord le @handle en vrai tg_user_id ; sans identité résolue,
  // on ne crée plus rien (un groupe créé 10 min en retard coûte moins cher qu'un doublon).
  const referredTgId = await resolveUsername(handle).catch(() => null);

  const out = await provisionGroup({
    tgUserId: referredTgId,
    handle,
    displayName: `@${handle}`,
    ownerKind: "player",
    ownerLabel: `@${handle}`,
    titleSuffix: affiliateName,
    context: `affiliate:${handle}`,
  });

  if (out.status === "ambiguous") {
    await sendMsg(chatId,
      `⏳ <b>C'est noté pour</b> <i>@${handle}</i>.\n\n` +
      (referredTgId
        ? `Il a peut-être déjà un groupe chez nous — on vérifie avant d'en ouvrir un second, pour ne pas éclater ses conversations.\n\n`
        : `Son compte Telegram n'a pas pu être identifié automatiquement (handle privé ou introuvable).\n\n`) +
      `@baki77777 finalise à la main et tu reçois le lien juste après 👌`,
      messageThreadId
    );
    clearSession(chatId);
    return true;
  }

  if (out.status === "pending") {
    await sendMsg(chatId, `⏳ Un groupe est déjà en cours de création pour <i>@${handle}</i> — laisse-lui quelques secondes.`, messageThreadId);
    clearSession(chatId);
    return true;
  }

  if (out.status === "failed") {
    await sendMsg(chatId,
      `❌ Erreur création groupe. Réessaie dans quelques minutes.\n<i>${out.error}</i>`,
      messageThreadId
    );
    clearSession(chatId);
    return true;
  }

  // Groupe existant réutilisé : le filleul est déjà client. On rattache le parrainage au
  // groupe qu'il connaît, on n'en ouvre pas un second.
  const result = out.status === "created"
    ? out.raw!
    : { chatId: Number(out.chatId), inviteLink: out.inviteLink ?? "", topicIds: out.topicIds ?? {},
        status: "full_success" as const, failedSteps: [], errors: [], botPromoted: true };
  const reused = out.status === "reused";

  const inviteResult = reused ? { ok: false, error: "groupe existant" } : await inviteUserToGroup(result.chatId, handle);
  const autoInvited = inviteResult.ok;

  try {
    db.prepare(`
      INSERT INTO affiliate_leads (affiliate_player_id, referred_handle, kickoff_group_id, kickoff_invite_link)
      VALUES (?, ?, ?, ?)
    `).run(session.player_id, handle, String(result.chatId), result.inviteLink);
  } catch (e: any) {
    if (e.message?.includes("UNIQUE constraint failed")) {
      await sendMsg(chatId, `❌ Ce handle vient d'être pris par un autre affiliate.`, messageThreadId);
    } else {
      await sendMsg(chatId, `❌ Erreur DB : ${e.message}`, messageThreadId);
    }
    clearSession(chatId);
    return true;
  }

  // Pas de re-seed sur un groupe réutilisé : ses topics vivent déjà, les re-semer
  // reposterait les coordonnées de dépôt par-dessus une conversation en cours.
  if (!reused) {
    for (const [key, msg] of Object.entries(TOPIC_MESSAGES)) {
      const topicId = result.topicIds[key];
      if (topicId) {
        await sendMsg(result.chatId, msg, topicId);
      }
    }
  }

  if (reused) {
    await sendMsg(chatId,
      `✅ <b>C'est noté pour</b> <i>@${handle}</i> !\n\n` +
      `Il a déjà son groupe LeCercle — je l'ai rattaché à ton parrainage plutôt que d'en ouvrir un second.\n\n` +
      (result.inviteLink ? `👉 <b>Le groupe est ici</b> :\n${result.inviteLink}\n\n` : ``) +
      `💰 <i>Rappel : tu touches 50% des profits agency sur ce joueur.</i>`,
      messageThreadId
    );
  } else if (autoInvited) {
    await sendMsg(chatId,
      `✅ <b>C'est fait !</b>\n\n` +
      `J'ai créé le groupe <i>@${handle} x LeCercle (Agent : ${affiliateName})</i> et ajouté ton filleul dedans 🎉\n\n` +
      `👉 <b>Rejoins le groupe ici</b> (ton filleul est déjà dedans) :\n${result.inviteLink}\n\n` +
      `On prend le relais pour l'onboarder dès que tu es dans le groupe.\n\n` +
      `💰 <i>Rappel : tu touches 50% des profits agency sur ce joueur.</i>`,
      messageThreadId
    );
  } else {
    await sendMsg(chatId,
      `✅ <b>Groupe créé pour</b> <i>@${handle}</i> 🎉\n\n` +
      `Je n'ai pas pu l'ajouter automatiquement (paramètres de confidentialité Telegram probablement).\n\n` +
      `👉 <b>Partage ce lien avec ton filleul</b> :\n${result.inviteLink}\n\n` +
      `Dès qu'il rejoint, on prend le relais pour l'onboarder.\n\n` +
      `💰 <i>Rappel : tu touches 50% des profits agency sur ce joueur.</i>`,
      messageThreadId
    );
  }

  await sendMsg(AGENT_CHAT_ID,
    `🤝 <b>Nouveau lead affiliate</b>\n` +
    `Affiliate : <b>${affiliateName}</b> (ID ${session.player_id})\n` +
    `Filleul : <i>@${handle}</i> (tg <code>${referredTgId ?? "?"}</code>)\n` +
    `Groupe : <code>${result.chatId}</code>${reused ? " — <b>existant, réutilisé</b>" : ""}\n` +
    `Auto-invite : ${autoInvited ? "✅" : `❌ ${inviteResult.error ?? ""}`}\n` +
    `Status : ${result.status} — ${Object.keys(result.topicIds).length} topics`
  );

  clearSession(chatId);
  return true;
}
