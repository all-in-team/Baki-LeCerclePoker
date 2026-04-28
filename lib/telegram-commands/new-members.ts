import { getDb } from "@/lib/db";
import { sendMsg, setSession } from "./helpers";

export async function handleNewMembers(members: any[], chatTitle: string, chatId: number) {
  const db = getDb();
  for (const member of members) {
    if (member.is_bot) continue;
    const name = [member.first_name, member.last_name].filter(Boolean).join(" ") || `TG#${member.id}`;
    const existing = db.prepare(`SELECT id FROM players WHERE telegram_id = ?`).get(member.id) as { id: number } | undefined;
    let playerId: number;
    let isNew: boolean;
    if (existing) { playerId = existing.id; isNew = false; }
    else {
      const r = db.prepare(`INSERT INTO players (name, telegram_handle, telegram_id, status, tier) VALUES (@name, @handle, @telegram_id, 'active', 'B')`)
        .run({ name, handle: member.username ?? null, telegram_id: member.id });
      playerId = Number(r.lastInsertRowid);
      isNew = true;
    }
    db.prepare(`INSERT INTO crm_notes (player_id, content, type) VALUES (?, ?, 'note')`)
      .run(playerId, `${isNew ? "Créé automatiquement — a" : "A"} rejoint "${chatTitle}"`);

    if (isNew) {
      setSession(chatId, "waiting_action_pct", playerId);
      await sendMsg(chatId,
        `✅ <b>${name}</b> ajouté au CRM automatiquement.\n\n` +
        `📋 <b>Étape 1/3</b> — Quel est son <b>% action sur TELE</b> ?\n` +
        `<i>(envoie juste le chiffre, ex : <b>40</b> — ou <b>40 5</b> pour 40% action + 5% RB)</i>`
      );
    }
  }
}
