import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { provisionGroup } from "@/lib/group-provisioning";
import { sendMsg } from "@/lib/telegram-commands/helpers";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  const provided = req.headers.get("x-admin-token");
  if (provided !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json();
  const { player_id, telegram_id, telegram_handle } = body;
  if (!player_id) return NextResponse.json({ error: "player_id required" }, { status: 400 });

  const db = getDb();
  const player = db.prepare(`SELECT id, name, telegram_id, telegram_group_id FROM players WHERE id = ?`).get(player_id) as any;
  if (!player) return NextResponse.json({ error: "Player not found" }, { status: 404 });

  if (player.telegram_group_id) {
    return NextResponse.json({ error: "Player already has a group", group_id: player.telegram_group_id }, { status: 409 });
  }

  const tgId = telegram_id ?? player.telegram_id;
  if (!tgId) return NextResponse.json({ error: "No telegram_id found — pass telegram_id in body" }, { status: 400 });

  // Update telegram_id and handle if provided
  if (telegram_id || telegram_handle) {
    const updates: string[] = [];
    const params: any[] = [];
    if (telegram_id) { updates.push("telegram_id = ?"); params.push(telegram_id); }
    if (telegram_handle) { updates.push("telegram_handle = ?"); params.push(telegram_handle); }
    params.push(player_id);
    db.prepare(`UPDATE players SET ${updates.join(", ")} WHERE id = ?`).run(...params);
  }

  // Porte unique : ce chemin ne regardait QUE `players.telegram_group_id` du joueur ciblé
  // et n'écrivait jamais au registre — il pouvait donc ouvrir un second groupe à un joueur
  // qui en avait déjà un côté lead Nexa ou parrainage (incident Alexis 2026-08-04).
  const out = await provisionGroup({
    tgUserId: tgId,
    handle: telegram_handle ?? null,
    displayName: player.name,
    ownerKind: "player",
    ownerLabel: player.name,
    context: `admin_api:player#${player_id}`,
  });

  if (out.status === "ambiguous") {
    return NextResponse.json({
      error: "Ambiguous match — no group created, manual arbitration required",
      reason: out.reason, case_id: out.caseId, candidates: out.candidates,
    }, { status: 409 });
  }
  if (out.status === "pending") {
    return NextResponse.json({ error: "Group creation already in flight for this telegram user" }, { status: 409 });
  }
  if (out.status === "failed") {
    return NextResponse.json({ error: out.error }, { status: 500 });
  }

  const result = out.status === "created"
    ? out.raw!
    : {
        chatId: Number(out.chatId), inviteLink: out.inviteLink ?? "", topicIds: out.topicIds ?? {},
        status: "full_success" as const, failedSteps: [] as string[], errors: [] as string[], botPromoted: true,
      };
  const reused = out.status === "reused";

  // Patch player row with group data. COALESCE : sur un groupe RÉUTILISÉ on ne connaît
  // pas forcément tous ses topics — écrire NULL par-dessus des ids valides casserait
  // l'accounting et les alertes de ce joueur.
  const groupId = String(result.chatId);
  db.prepare(`
    UPDATE players SET
      telegram_id = ?,
      telegram_chat_id = ?,
      telegram_group_id = ?,
      alertes_topic_id    = COALESCE(?, alertes_topic_id),
      liveplay_topic_id   = COALESCE(?, liveplay_topic_id),
      accounting_topic_id = COALESCE(?, accounting_topic_id),
      deals_topic_id      = COALESCE(?, deals_topic_id),
      clubs_topic_id      = COALESCE(?, clubs_topic_id),
      depot_topic_id      = COALESCE(?, depot_topic_id),
      onboarding_topic_id = COALESCE(?, onboarding_topic_id)
    WHERE id = ?
  `).run(
    tgId,
    groupId,
    groupId,
    result.topicIds.alertes ?? null,
    result.topicIds.liveplay ?? null,
    result.topicIds.accounting ?? null,
    result.topicIds.deals ?? null,
    result.topicIds.clubs ?? null,
    result.topicIds.depot ?? null,
    result.topicIds.onboarding ?? null,
    player_id,
  );

  // Send topic welcome messages
  const TOPIC_MESSAGES: Record<string, string> = {
    alertes: `📢 <b>Alertes</b>\n\nCe canal sert aux annonces importantes de Le Cercle.`,
    liveplay: `🔴 <b>Liveplay</b>\n\nIci seront postés les liveplay des différentes games.`,
    accounting: `📊 <b>Accounting</b>\n\nCe canal sert au suivi de ta bankroll.\n\nCommandes :\n<code>/solde</code> — ton solde\n<code>/historique</code> — tes transactions`,
    deals: `📋 <b>Deals</b>\n\nIci tu trouveras tous les deals actifs.`,
    clubs: `🏠 <b>Clubs</b>\n\nTous les clubs disponibles sont listés ici.`,
    depot: `💳 <b>Dépôt</b>\n\n⚠️ Toujours demander confirmation AVANT d'envoyer.`,
  };

  // Jamais de re-seed sur un groupe réutilisé : ses topics vivent déjà.
  if (!reused) {
    for (const [key, msg] of Object.entries(TOPIC_MESSAGES)) {
      const topicId = result.topicIds[key];
      if (topicId) {
        try { await sendMsg(result.chatId, msg, topicId); } catch {}
      }
    }
  }

  // Upsert onboarding_leads
  db.prepare(`
    INSERT INTO onboarding_leads (telegram_id, telegram_username, first_name, stage)
    VALUES (?, ?, ?, 'joined')
    ON CONFLICT(telegram_id) DO UPDATE SET stage = 'joined', last_seen = datetime('now')
  `).run(tgId, telegram_handle ?? null, player.name);

  const updated = db.prepare(`SELECT * FROM players WHERE id = ?`).get(player_id);

  return NextResponse.json({
    ok: true,
    reused,
    player: updated,
    group: {
      chat_id: result.chatId,
      invite_link: result.inviteLink,
      topic_ids: result.topicIds,
      status: result.status,
      bot_promoted: result.botPromoted,
      failed_steps: result.failedSteps,
      errors: result.errors,
    },
  });
}
