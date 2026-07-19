export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listUserbotChannels, leaveUserbotChannels, getChatMembers, getUserbotMe } from "@/lib/telegram-userbot";
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

  // mode "inspect" : liste les membres de chaque groupe demandé et marque only_owners
  // (= aucun humain à part @Baki77777 / @HugoRoine / le compte userbot lui-même →
  // le joueur n'a jamais rejoint, shell mort). Critère Hugo 2026-07-19.
  if (mode === "inspect") {
    const requested: string[] = Array.isArray(body.chat_ids) ? body.chat_ids.map(String) : [];
    if (requested.length === 0) return NextResponse.json({ error: "chat_ids required" }, { status: 400 });
    if (requested.length > 40) return NextResponse.json({ error: "max 40 chat_ids par appel" }, { status: 400 });

    const OWNER_USERNAMES = new Set(["baki77777", "hugoroine"]);
    const me = await getUserbotMe();
    const groups: any[] = [];
    for (const chatId of requested) {
      const members = await getChatMembers(chatId);
      const humansOther = members.filter((m) =>
        !m.bot &&
        m.id !== me?.id &&
        !OWNER_USERNAMES.has((m.username ?? "").toLowerCase())
      );
      groups.push({
        chat_id: chatId,
        fetched_members: members.length,
        only_owners: members.length > 0 && humansOther.length === 0,
        other_humans: humansOther.map((m) => ({ username: m.username ?? null, name: [m.first_name, m.last_name].filter(Boolean).join(" ") })),
        members: members.map((m) => (m.bot ? `🤖 ${m.username ?? m.first_name ?? m.id}` : `@${m.username ?? "?"} ${[m.first_name, m.last_name].filter(Boolean).join(" ")}`)),
      });
      await new Promise((r) => setTimeout(r, 1100));
    }
    return NextResponse.json({ ok: true, userbot: me, groups });
  }

  // mode "bot-leave" : fait sortir LE BOT (@LeCercle_Lebot) des groupes fournis via
  // l'API Bot leaveChat — pour finir le nettoyage des shells une fois le compte
  // userbot parti (Hugo 2026-07-19 : "take off the bot in all groups with me only").
  // Même garde-fou : jamais un groupe lié à un joueur.
  if (mode === "bot-leave") {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return NextResponse.json({ error: "TELEGRAM_BOT_TOKEN not set" }, { status: 503 });
    const requested: string[] = Array.isArray(body.chat_ids) ? body.chat_ids.map(String) : [];
    if (requested.length === 0) return NextResponse.json({ error: "chat_ids required" }, { status: 400 });
    if (requested.length > 40) return NextResponse.json({ error: "max 40 chat_ids par appel" }, { status: 400 });

    const blocked = requested.filter((id) => keep.has(id));
    const left: string[] = [];
    const failed: { chat_id: string; error: string }[] = [];
    for (const chatId of requested.filter((id) => !keep.has(id))) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${botToken}/leaveChat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: Number(chatId) }),
        });
        const data = await res.json();
        if (data.ok) left.push(chatId);
        else failed.push({ chat_id: chatId, error: data.description ?? `HTTP ${res.status}` });
      } catch (e: any) {
        failed.push({ chat_id: chatId, error: e?.message ?? "fetch failed" });
      }
      await new Promise((r) => setTimeout(r, 350)); // Bot API ~30 req/s, large marge
    }
    console.log(`[BOT-LEAVE] left=${left.length} failed=${failed.length} blocked=${blocked.length}`);
    return NextResponse.json({ ok: failed.length === 0, left, failed, blocked: blocked.map((id) => ({ chat_id: id, reason: keep.get(id) })) });
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
