import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const db = getDb();
  const gameRates = db.prepare(
    `SELECT arg.game_id, g.name AS game_name, arg.disclosed_action_pct, arg.disclosed_rakeback_pct, arg.disclosed_insurance_pct, arg.exclude_agency_extras, arg.excluded
     FROM affiliate_relationship_games arg
     JOIN games g ON g.id = arg.game_id
     WHERE arg.relationship_id = ?
     ORDER BY g.name`
  ).all(Number(id)) as any[];
  return NextResponse.json({ game_rates: gameRates });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const body = await req.json();
  const db = getDb();
  const relId = Number(id);

  // Champs sans effet sur la base de commission : écrits tels quels.
  // (status — pause/réactivation — reste hors garde : chantier séparé, décision Baki 2026-09-26.)
  const plain = ["origin_game_id", "start_date", "status", "notes"];
  // Champs qui changent la BASE d'un filleul (override perçu) : sous garde du gel.
  const guarded = ["disclosed_action_pct", "disclosed_rakeback_pct", "disclosed_insurance_pct", "exclude_agency_extras"];
  const build = (keys: string[]) => {
    const sets: string[] = [];
    const vals: Record<string, unknown> = { id: relId };
    for (const key of keys) if (body[key] !== undefined) { sets.push(`${key} = @${key}`); vals[key] = body[key]; }
    return { sets, vals };
  };

  const p = build(plain);
  const writePlain = () => { if (p.sets.length > 0) db.prepare(`UPDATE affiliate_relationships SET ${p.sets.join(", ")} WHERE id = @id`).run(p.vals); };

  const g = build(guarded);
  if (g.sets.length === 0 && !Array.isArray(body.game_rates)) writePlain();
  else {
    const rel = db.prepare(`SELECT affiliate_player_id FROM affiliate_relationships WHERE id = ?`).get(relId) as { affiliate_player_id: number } | undefined;
    if (!rel) return NextResponse.json({ error: "relation introuvable" }, { status: 404 });
    const { withFrozenGuardOn } = await import("@/lib/affiliate/agent-rates");
    // UNE transaction pour tout le PATCH : un refus n'écrit rien, pas même le statut ou la note.
    const r = withFrozenGuardOn(db, rel.affiliate_player_id, () => {
      writePlain();
      if (g.sets.length > 0) db.prepare(`UPDATE affiliate_relationships SET ${g.sets.join(", ")} WHERE id = @id`).run(g.vals);
      if (Array.isArray(body.game_rates)) {
        db.prepare(`DELETE FROM affiliate_relationship_games WHERE relationship_id = ?`).run(relId);
        const insert = db.prepare(
          `INSERT INTO affiliate_relationship_games (relationship_id, game_id, disclosed_action_pct, disclosed_rakeback_pct, disclosed_insurance_pct, exclude_agency_extras, excluded)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        for (const gr of body.game_rates) {
          if (!gr.game_id) continue;
          insert.run(relId, gr.game_id, gr.disclosed_action_pct ?? null, gr.disclosed_rakeback_pct ?? null,
            gr.disclosed_insurance_pct ?? null, gr.exclude_agency_extras ?? 1, gr.excluded ?? 0);
        }
      }
    });
    if (!r.ok) return NextResponse.json({ error: r.error, frozen_weeks: r.weeks }, { status: 409 });
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: Ctx) {
  const { id } = await params;
  const db = getDb();
  const rel = db.prepare(`SELECT referred_player_id FROM affiliate_relationships WHERE id = ?`).get(Number(id)) as
    | { referred_player_id: number }
    | undefined;
  db.prepare(`UPDATE affiliate_relationships SET status = 'terminated' WHERE id = ?`).run(Number(id));

  // After terminate: strip the [agent] tag from the filleul's Telegram group (or re-tag with the
  // remaining active agent, if any). Single rename, never blocks the termination above.
  let group_rename: unknown = undefined;
  if (rel) {
    try {
      const { retagAffiliatedGroupForReferred } = await import("@/lib/affiliate-group-rename");
      group_rename = await retagAffiliatedGroupForReferred(rel.referred_player_id);
    } catch (re: any) {
      console.warn("[AFFILIATE] group retag after terminate failed:", re?.message ?? String(re));
      group_rename = { status: "failed", error: re?.message ?? String(re) };
    }
  }
  return NextResponse.json({ ok: true, group_rename });
}
