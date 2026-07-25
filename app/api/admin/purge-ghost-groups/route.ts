export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChatMembers, getUserbotMe } from "@/lib/telegram-userbot";
import { purgeGroupById, runGhostGroupCleanup, reportGhostCleanup } from "@/lib/group-lifecycle";
import { sendMsg, AGENT_CHAT_ID } from "@/lib/telegram-commands/helpers";

// Rattrapage du STOCK de groupes fantômes trouvés à l'audit du 2026-07-25, validé
// nominativement par Hugo. Le job horaire (`runGhostGroupCleanup`) ne voit que les
// groupes tracés dans `group_creations`, donc créés après son déploiement : ces 16-là
// sont antérieurs et 15 d'entre eux sont protégés du purge hebdo par le keep-guard
// (`players.telegram_group_id` renseigné). D'où cette liste FIGÉE, seule autorisée à
// passer outre le keep-guard.
//
//   POST { key, mode: "dry-run" }      → état des membres des 16, aucune écriture
//   POST { key, mode: "purge" }        → purge (kick équipe + sortie userbot) + délie
//   POST { key, mode: "cleanup-run", dry_run?: bool } → run manuel du job 24 h
//
// GARDE-FOU conservé même en mode purge : on relit les membres juste avant, et si un
// humain hors équipe est présent (le joueur a rejoint depuis l'audit) on ne touche à
// rien — on répare `joined_at` à la place.

const KEY = "purge-ghosts-20260725";

const AUDITED_GHOSTS: { chat_id: string; label: string }[] = [
  { chat_id: "-1003726995589", label: "Sal7 Aldin x LeCercle" },
  { chat_id: "-1004359250833", label: "M K x LeCercle" },
  { chat_id: "-1004352241465", label: "Kamil x LeCercle" },
  { chat_id: "-1004334664424", label: "BÖYCA CALI x LeCercle" },
  { chat_id: "-1003906499537", label: "Xabi x LeCercle" },
  { chat_id: "-1004497694357", label: "BBN Consulting x LeCercle" },
  { chat_id: "-1003932586677", label: "JB x LeCercle" },
  { chat_id: "-1003824326836", label: "U x LeCercle" },
  { chat_id: "-1003956967716", label: "Manu Ixess x LeCercle" },
  { chat_id: "-1004491937142", label: "Gab' x LeCercle" },
  { chat_id: "-1004442814153", label: "Bip bip x LeCercle" },
  { chat_id: "-1003720426954", label: "Lorenzo x LeCercle" },
  { chat_id: "-1004352536664", label: "Jeremie Verdonck x LeCercle" },
  { chat_id: "-1003999138989", label: "Vya x LeCercle [Alex D Mexique]" },
  { chat_id: "-1003693221418", label: "Yohan x LeCercle" },
  { chat_id: "-1003983340862", label: "Li✨ x LeCercle" },
];

function ownerOf(chatId: string) {
  const db = getDb();
  const player = db.prepare(
    `SELECT id, name, telegram_id,
       (SELECT COUNT(*) FROM wallet_transactions w WHERE w.player_id = players.id) AS txs
     FROM players WHERE telegram_group_id = ?`
  ).get(chatId) as { id: number; name: string; telegram_id: number | null; txs: number } | undefined;
  return player ?? null;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  if (body.key !== KEY) return NextResponse.json({ error: "bad key" }, { status: 403 });
  const mode: string = body.mode ?? "dry-run";

  // Run manuel du job 24 h (sert au test sans attendre le cron de :40).
  if (mode === "cleanup-run") {
    const result = await runGhostGroupCleanup({ dryRun: !!body.dry_run, cap: body.cap });
    if (!body.dry_run) await reportGhostCleanup(result);
    return NextResponse.json(result);
  }

  if (mode === "dry-run") {
    const me = await getUserbotMe();
    if (!me) return NextResponse.json({ ok: false, error: "userbot not connected" }, { status: 502 });
    const TEAM = new Set(["hugoroine", "baki77777"]);
    const groups: any[] = [];
    for (const g of AUDITED_GHOSTS) {
      const members = await getChatMembers(g.chat_id);
      const humans = members.filter((m) => !m.bot && m.id !== me.id && !TEAM.has((m.username ?? "").toLowerCase()));
      const owner = ownerOf(g.chat_id);
      groups.push({
        ...g,
        fetched_members: members.length,
        members: members.map((m) => (m.bot ? `🤖 ${m.username ?? m.id}` : `@${m.username ?? "?"}`)),
        only_team: members.length > 0 && humans.length === 0,
        other_humans: humans.map((m) => m.username ?? m.first_name ?? String(m.id)),
        decision: members.length === 0 ? "SKIP (membres illisibles)"
          : humans.length > 0 ? "SKIP (humain présent → join réparé)" : "PURGE",
        linked_player: owner ? `#${owner.id} ${owner.name} (${owner.txs} tx)` : null,
      });
      await new Promise((r) => setTimeout(r, 1100));
    }
    return NextResponse.json({
      ok: true, mode, total: groups.length,
      to_purge: groups.filter((g) => g.decision === "PURGE").length,
      groups,
    });
  }

  if (mode === "purge") {
    const results: any[] = [];
    for (const g of AUDITED_GHOSTS) {
      const owner = ownerOf(g.chat_id);
      const out = await purgeGroupById(g.chat_id, {
        reason: "ghost_backfill_audit_20260725",
        label: g.label,
        backfillOwner: owner?.telegram_id
          ? { ownerKind: "player", ownerKey: owner.telegram_id }
          : undefined,
      });
      results.push({ ...out, linked_player: owner ? `#${owner.id} ${owner.name}` : null });
    }
    const purged = results.filter((r) => r.outcome === "purged");
    const tagged = results.filter((r) => r.outcome === "tagged");
    const kept = results.filter((r) => r.outcome === "has_human" || r.outcome === "skipped");
    await sendMsg(AGENT_CHAT_ID,
      `🧹 <b>Purge des 16 groupes fantômes</b> (audit 2026-07-25, validé Hugo)\n` +
      `🗑 ${purged.length} supprimé(s) · ⚰️ ${tagged.length} tagué(s) · ⏭ ${kept.length} conservé(s)\n` +
      (kept.length ? kept.map((k) => `  • ${k.label} — ${k.detail}`).join("\n") : "")
    ).catch(() => {});
    return NextResponse.json({
      ok: true, mode,
      counts: { purged: purged.length, tagged: tagged.length, kept: kept.length },
      results,
    });
  }

  return NextResponse.json({ error: `unknown mode: ${mode}` }, { status: 400 });
}
