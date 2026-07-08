import { getDb } from "@/lib/db";
import { sendMsg, AGENT_CHAT_ID } from "./helpers";

// ?start=<game> deep link (OKPOKER / JVIP / TTPOKER) — LEAD CAPTURE ONLY.
//
// La mécanique LeCercle : l'onboarding se passe DANS LE GROUPE privé du joueur
// (createPlayerGroup userbot → groupe + topics, puis /start<game> dans le groupe :
// % saisi par l'OWNER en texte libre, pitch + J'accepte + wallets dans le topic
// Onboarding). JAMAIS en DM self-service.
//
// Historique : du 05/07 au 08/07/2026 ces deep links déroulaient un onboarding DM
// complet (pseudo demandé au joueur, player minimal créé, deal default écrit,
// wallets collectés en DM) — retiré car ce n'est pas le flow LeCercle et ça créait
// des players fantômes. Ce handler n'écrit RIEN en DB : il identifie le lead,
// notifie AGENT_CHAT_ID et répond un court message d'attente.
export async function handleGameDeepLinkLead(
  chatId: number,
  from: { id: number; first_name?: string; last_name?: string; username?: string },
  gameName: string,
) {
  const player = getDb().prepare(
    `SELECT id, name FROM players WHERE telegram_id = ?`
  ).get(from.id) as { id: number; name: string } | undefined;

  const tgName = [from.first_name, from.last_name].filter(Boolean).join(" ").trim();
  const display = player?.name ?? (tgName || "inconnu");
  const handle = from.username ? ` (@${from.username})` : "";

  await sendMsg(AGENT_CHAT_ID,
    `🎯 <b>Lead ${gameName}</b> via deep link : <b>${display}</b>${handle}\n` +
    `🆔 TG: <code>${from.id}</code>` +
    (player ? ` — player existant <b>#${player.id}</b>` : ` — pas encore de player`) + `\n` +
    `@baki77777 — lance son onboarding (groupe + /start${gameName.toLowerCase()})`
  );

  await sendMsg(chatId,
    `🃏 <b>Bien reçu !</b>\n\n` +
    `On s'occupe de toi 👌 Tu vas être contacté très vite pour ton accès ${gameName}.`
  );
}
