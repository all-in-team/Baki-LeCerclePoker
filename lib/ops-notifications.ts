import { sendMsg, AGENT_CHAT_ID } from "./telegram-commands/helpers";

export async function notifyOps(message: string): Promise<void> {
  try {
    await sendMsg(AGENT_CHAT_ID, message);
  } catch (e: any) {
    console.error("[OPS-NOTIFY]", e?.message ?? e);
  }
}

export async function notifyCashoutConfirmed(playerName: string): Promise<void> {
  await notifyOps(`✅ <b>${playerName}</b> a confirmé son cashout`);
}

export async function notifyCashoutSkipped(playerName: string): Promise<void> {
  await notifyOps(`⏸️ <b>${playerName}</b> n'a pas joué cette semaine`);
}

export async function notifyOpsError(context: string, error: string): Promise<void> {
  await notifyOps(`🚨 <b>Erreur ${context}</b>\n<code>${error.slice(0, 200)}</code>`);
}
