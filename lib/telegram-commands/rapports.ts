import { getStaleReports } from "@/lib/queries";
import { sendMsg } from "./helpers";

export async function handleRapports(chatId: number) {
  const stale = getStaleReports(7);
  if (stale.length === 0) {
    await sendMsg(chatId, `✅ <b>Tous les rapports sont à jour</b> (moins de 7 jours)`);
    return;
  }
  const lines = stale.map(g => {
    const ago = g.days_since_report != null ? `<b>${g.days_since_report}j</b>` : "<b>jamais</b>";
    return `• <b>${g.game_name}</b> — dernier rapport : ${ago} (${g.active_player_count} joueurs actifs)`;
  });
  await sendMsg(chatId,
    `📋 <b>${stale.length} rapport(s) en retard</b>\n\n${lines.join("\n")}\n\n<i>Upload un rapport sur le dashboard /reports.</i>`
  );
}
