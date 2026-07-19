export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listUserbotChannels, leaveUserbotChannels } from "@/lib/telegram-userbot";
import { AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";

// Libère de la capacité canaux sur le compte userbot (cap Telegram ~500 →
// CHANNELS_TOO_MUCH casse toute création de groupe d'onboarding).
//
//   POST { key, mode?: "dry-run" }            → inventaire complet, marqué KEEP / CANDIDAT
//   POST { key, mode: "leave", chat_ids: [] } → quitte les ids validés par l'owner
//
// GARDE-FOU SERVEUR : un groupe lié à un joueur (players.telegram_group_id) ou le
// chat agent n'est JAMAIS quitté, même si son id est passé dans chat_ids.
// Max 30 leaves par appel (throttle 1,1 s/leave côté userbot).

const KEY = "userbot-leave-20260719";
const MAX_LEAVES_PER_CALL = 30;

function keepSet(): Map<string, string> {
  const keep = new Map<string, string>(); // chat_id → reason
  keep.set(String(AGENT_CHAT_ID), "chat agent");
  const rows = getDb().prepare(
    `SELECT telegram_group_id, name FROM players WHERE telegram_group_id IS NOT NULL AND telegram_group_id != ''`
  ).all() as { telegram_group_id: string; name: string }[];
  for (const r of rows) keep.set(r.telegram_group_id, `groupe joueur — ${r.name}`);
  return keep;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== KEY) return NextResponse.json({ error: "bad key" }, { status: 403 });

  const mode: string = body.mode ?? "dry-run";
  const keep = keepSet();

  if (mode === "dry-run") {
    const inv = await listUserbotChannels();
    if (!inv.ok) return NextResponse.json({ ok: false, error: inv.error }, { status: 502 });
    const channels = inv.channels.map((c) => {
      const keepReason = keep.get(c.chat_id);
      return { ...c, decision: keepReason ? "KEEP" : "CANDIDAT", reason: keepReason ?? "non lié à un joueur" };
    });
    return NextResponse.json({
      ok: true,
      total_channels: inv.total_channels,
      keep_count: channels.filter((c) => c.decision === "KEEP").length,
      candidate_count: channels.filter((c) => c.decision === "CANDIDAT").length,
      channels,
    });
  }

  if (mode === "leave") {
    const requested: string[] = Array.isArray(body.chat_ids) ? body.chat_ids.map(String) : [];
    if (requested.length === 0) return NextResponse.json({ error: "chat_ids required" }, { status: 400 });
    if (requested.length > MAX_LEAVES_PER_CALL) {
      return NextResponse.json({ error: `max ${MAX_LEAVES_PER_CALL} chat_ids par appel` }, { status: 400 });
    }
    const blocked = requested.filter((id) => keep.has(id));
    const toLeave = requested.filter((id) => !keep.has(id));
    const res = await leaveUserbotChannels(toLeave);
    console.log(`[USERBOT-LEAVE] left=${res.left.length} failed=${res.failed.length} blocked=${blocked.length} ids=[${res.left.join(",")}]`);
    return NextResponse.json({
      ok: res.ok,
      left: res.left,
      failed: res.failed,
      blocked: blocked.map((id) => ({ chat_id: id, reason: keep.get(id) })),
      error: res.error,
    });
  }

  return NextResponse.json({ error: "unknown mode" }, { status: 400 });
}
