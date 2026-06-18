import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listGroups, renamePlayerGroup, checkUserbotHealth } from "@/lib/telegram-userbot";
import { buildAffiliatedTitle, isAlreadyTagged } from "@/lib/affiliate-group-rename";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const RENAME_DELAY_MS = 4000; // anti-FLOOD: spacing between sequential renames (A2)

interface Plan {
  chat_id: string | null;
  referred_player_id: number;
  joueur: string;
  agent: string;
  titre_actuel: string | null;
  titre_propose: string;
  action: "would_rename" | "already_tagged" | "no_group" | "group_not_found" | "multiple_agents";
  flag?: string;
}

// Build the rename plan from active affiliate relationships + live group titles (one listGroups call).
async function buildPlan() {
  const db = getDb();
  const rels = db.prepare(`
    SELECT ar.referred_player_id, rp.name AS referred_name, rp.telegram_group_id,
           ar.affiliate_player_id, ap.name AS agent_name
    FROM affiliate_relationships ar
    JOIN players rp ON rp.id = ar.referred_player_id
    JOIN players ap ON ap.id = ar.affiliate_player_id
    WHERE ar.status = 'active'
    ORDER BY rp.name
  `).all() as { referred_player_id: number; referred_name: string; telegram_group_id: string | null; affiliate_player_id: number; agent_name: string }[];

  // Detect referred players with >1 active agent (should not happen with single-layer + UNIQUE).
  const agentCount = new Map<number, number>();
  for (const r of rels) agentCount.set(r.referred_player_id, (agentCount.get(r.referred_player_id) ?? 0) + 1);

  const lg = await listGroups();
  const titleByChat = new Map<string, string>();
  if (lg.ok) for (const g of lg.groups) titleByChat.set(g.chat_id, g.title);

  const plan: Plan[] = [];
  for (const r of rels) {
    const titre_propose = buildAffiliatedTitle(r.referred_name, r.agent_name);
    const base: Omit<Plan, "action"> = {
      chat_id: r.telegram_group_id, referred_player_id: r.referred_player_id,
      joueur: r.referred_name, agent: r.agent_name,
      titre_actuel: r.telegram_group_id ? (titleByChat.get(r.telegram_group_id) ?? null) : null,
      titre_propose,
    };
    if ((agentCount.get(r.referred_player_id) ?? 0) > 1) { plan.push({ ...base, action: "multiple_agents", flag: "plusieurs agents actifs pour ce joueur" }); continue; }
    if (!r.telegram_group_id) { plan.push({ ...base, action: "no_group", flag: "joueur sans groupe (sera créé avec le bon titre)" }); continue; }
    if (base.titre_actuel === null) { plan.push({ ...base, action: "group_not_found", flag: "groupe absent des dialogs userbot (chat_id introuvable)" }); continue; }
    if (isAlreadyTagged(base.titre_actuel, r.agent_name) || base.titre_actuel === titre_propose) { plan.push({ ...base, action: "already_tagged" }); continue; }
    plan.push({ ...base, action: "would_rename" });
  }

  return { plan, listGroupsOk: lg.ok, listGroupsError: lg.error };
}

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN env var is not set on the server" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const apply = req.nextUrl.searchParams.get("apply") === "1";
  const body = await req.json().catch(() => ({} as any));

  const { plan, listGroupsOk, listGroupsError } = await buildPlan();
  const renamable = plan.filter((p) => p.action === "would_rename");
  const summary = {
    affiliated_total: plan.length,
    would_rename: renamable.length,
    already_tagged: plan.filter((p) => p.action === "already_tagged").length,
    no_group: plan.filter((p) => p.action === "no_group").length,
    group_not_found: plan.filter((p) => p.action === "group_not_found").length,
    multiple_agents: plan.filter((p) => p.action === "multiple_agents").length,
  };

  // ── DRY-RUN (default) — no renames ──
  if (!apply) {
    return NextResponse.json({ dry_run: true, listGroupsOk, listGroupsError, summary, plan });
  }

  // ── APPLY (A2) — sequential, spaced, stop on first error. Requires explicit confirmation. ──
  if (body?.confirm !== "RENAME_AFFILIATED_GROUPS") {
    return NextResponse.json({ error: 'apply=1 requires body { "confirm": "RENAME_AFFILIATED_GROUPS" }' }, { status: 400 });
  }
  // Verify the userbot session is alive BEFORE touching anything.
  const health = await checkUserbotHealth();
  if (!health.session_valid) {
    return NextResponse.json({ error: "userbot session not valid — aborting before any rename", health }, { status: 503 });
  }
  if (!listGroupsOk) {
    return NextResponse.json({ error: "listGroups failed — cannot verify current titles, aborting", listGroupsError }, { status: 503 });
  }

  const results: Array<{ joueur: string; chat_id: string | null; titre_propose: string; status: string; error?: string | null; flood_wait?: number | null }> = [];
  for (let i = 0; i < renamable.length; i++) {
    const p = renamable[i];
    if (!p.chat_id) { results.push({ joueur: p.joueur, chat_id: null, titre_propose: p.titre_propose, status: "skipped_no_group" }); continue; }
    if (isAlreadyTagged(p.titre_actuel, p.agent)) { results.push({ joueur: p.joueur, chat_id: p.chat_id, titre_propose: p.titre_propose, status: "skipped_already_tagged" }); continue; }

    const res = await renamePlayerGroup(p.chat_id, p.titre_propose);
    if (!res.ok) {
      // STOP immediately — do not continue blind (anti-burst / session safety).
      results.push({ joueur: p.joueur, chat_id: p.chat_id, titre_propose: p.titre_propose, status: "FAILED", error: res.error, flood_wait: res.flood_wait });
      return NextResponse.json({
        applied: true, stopped_early: true, stopped_at_index: i, reason: res.flood_wait ? `FLOOD_WAIT ${res.flood_wait}s` : (res.error ?? "unknown"),
        done: results.length, remaining: renamable.length - i - 1, results,
      }, { status: 200 });
    }
    results.push({ joueur: p.joueur, chat_id: p.chat_id, titre_propose: p.titre_propose, status: res.not_modified ? "ok_not_modified" : "renamed" });
    if (i < renamable.length - 1) await sleep(RENAME_DELAY_MS);
  }

  return NextResponse.json({ applied: true, stopped_early: false, done: results.length, results });
}
