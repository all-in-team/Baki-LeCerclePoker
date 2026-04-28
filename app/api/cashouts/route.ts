export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getCashoutRequests, createCashoutRequest, updateCashoutStatus } from "@/lib/queries";
import { getDb } from "@/lib/db";

function mentionPlayer(player: { name: string; telegram_id: number | null }) {
  if (player.telegram_id) return `<a href="tg://user?id=${player.telegram_id}">${player.name}</a>`;
  return `<b>${player.name}</b>`;
}

async function notifyPlayer(playerId: number, text: string) {
  const db = getDb();
  const player = db.prepare(`SELECT name, telegram_id, telegram_chat_id FROM players WHERE id = ?`).get(playerId) as { name: string; telegram_id: number | null; telegram_chat_id: string | null } | undefined;
  if (!player?.telegram_chat_id) return;
  const mention = mentionPlayer(player);
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: player.telegram_chat_id, text: `${mention} — ${text}`, parse_mode: "HTML" }),
  });
}

export async function GET(req: NextRequest) {
  const status = req.nextUrl.searchParams.get("status") ?? undefined;
  return NextResponse.json(getCashoutRequests(status));
}

export async function POST(req: NextRequest) {
  const { player_id, amount, currency, note } = await req.json();
  if (!player_id || !amount || amount <= 0) {
    return NextResponse.json({ error: "player_id et amount requis" }, { status: 400 });
  }
  const id = createCashoutRequest({ player_id, amount, currency, note });
  return NextResponse.json({ ok: true, id });
}

export async function PATCH(req: NextRequest) {
  const { id, status } = await req.json() as { id: number; status: "approved" | "paid" | "cancelled" };
  if (!id || !["approved", "paid", "cancelled"].includes(status)) {
    return NextResponse.json({ error: "id et status (approved/paid/cancelled) requis" }, { status: 400 });
  }
  const updated = updateCashoutStatus(id, status);
  if (!updated) return NextResponse.json({ error: "Cashout introuvable ou transition invalide" }, { status: 404 });

  if (status === "approved") {
    await notifyPlayer(updated.player_id,
      `✅ <b>Cashout approuvé</b>\n💰 <b>${updated.amount.toFixed(2)} ${updated.currency}</b>\n<i>Le paiement sera effectué sous peu.</i>`
    );
  } else if (status === "paid") {
    await notifyPlayer(updated.player_id,
      `💸 <b>Cashout payé</b>\n💰 <b>${updated.amount.toFixed(2)} ${updated.currency}</b>\n<i>Vérifie ton wallet.</i>`
    );
  }

  return NextResponse.json({ ok: true, cashout: updated });
}
