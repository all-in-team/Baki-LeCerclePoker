export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getNeverPlayerBucket, archivePlayers } from "@/lib/queries";
import { sendMsg, AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";

// Nettoyage de la liste Joueurs — audit Hugo 2026-07-25, validé.
//
// 142 des 237 lignes `players` n'ont jamais été des joueurs : le bot est membre du groupe
// communautaire `𓂃🌿 نَفَحَاتٌ إِيمَانِيَّةٌ 🌿𓂃` (chat -1004358906632, aucun rapport avec le
// poker) et `handleNewMembers` créait une ligne à chaque personne qui rejoignait.
//
//   POST { key, mode: "dry-run" }        → le bucket recalculé, aucune écriture
//   POST { key, mode: "archive" }        → soft-delete du bucket (archived_at), réversible
//   POST { key, mode: "leave-chat", chat_id } → fait sortir le bot du groupe fourni
//
// Le bucket est TOUJOURS recalculé par getNeverPlayerBucket() (mêmes garde-fous que
// l'audit : game, member_id, argent, wallet, groupe, note LeCercle, tag Aff/Ref, funnel,
// statut travaillé à la main, création manuelle). Aucun id n'est figé dans le code, et
// l'archivage passe par une liste d'ids explicite — jamais un UPDATE avec WHERE ouvert.

const KEY = "archive-never-players-20260725";
const REASON = "jamais joueur — audit 2026-07-25 (groupe communautaire, aucune activité)";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== KEY) return NextResponse.json({ error: "bad key" }, { status: 403 });
  const mode: string = body.mode ?? "dry-run";
  const db = getDb();

  if (mode === "leave-chat") {
    const chatId = String(body.chat_id ?? "");
    if (!chatId) return NextResponse.json({ error: "chat_id required" }, { status: 400 });
    // Garde-fou : jamais le chat agent, jamais un groupe de joueur ou de lead.
    if (chatId === String(AGENT_CHAT_ID)) return NextResponse.json({ error: "chat agent — refusé" }, { status: 400 });
    const bound = db.prepare(
      `SELECT COUNT(*) AS n FROM players WHERE telegram_group_id = ?`
    ).get(chatId) as { n: number };
    if (bound.n > 0) return NextResponse.json({ error: `groupe lié à ${bound.n} joueur(s) — refusé` }, { status: 400 });

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 503 });
    const res = await fetch(`https://api.telegram.org/bot${token}/leaveChat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId }),
    });
    const json = await res.json().catch(() => ({}));
    return NextResponse.json({ ok: !!json.ok, chat_id: chatId, telegram: json }, { status: json.ok ? 200 : 502 });
  }

  const bucket = getNeverPlayerBucket();
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM players`).get() as { n: number }).n;
  const alreadyArchived = (db.prepare(`SELECT COUNT(*) AS n FROM players WHERE archived_at IS NOT NULL`).get() as { n: number }).n;

  if (mode === "dry-run") {
    return NextResponse.json({
      ok: true, mode,
      total_players: total,
      already_archived: alreadyArchived,
      bucket_count: bucket.length,
      would_remain: total - alreadyArchived - bucket.length,
      bucket: bucket.slice(0, 25),
    });
  }

  if (mode === "archive") {
    const archived = archivePlayers(bucket.map((b) => b.id), REASON);
    const remaining = (db.prepare(`SELECT COUNT(*) AS n FROM players WHERE archived_at IS NULL`).get() as { n: number }).n;
    await sendMsg(AGENT_CHAT_ID,
      `🧹 <b>Liste Joueurs nettoyée</b>\n` +
      `${archived} ligne(s) archivée(s) — jamais joueurs (aucune game, aucun cut, aucune tx, ` +
      `aucun import, aucun groupe, aucun member_id).\n` +
      `📋 Il reste <b>${remaining}</b> joueurs dans la liste. Rien n'est supprimé : ` +
      `toggle « Archivés » sur la page Joueurs pour les revoir ou les restaurer.`
    ).catch(() => {});
    return NextResponse.json({ ok: true, mode, archived, remaining, total_players: total });
  }

  return NextResponse.json({ error: `unknown mode: ${mode}` }, { status: 400 });
}
