import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function GET() {
  const db = getDb();

  const pendingLeadsNoRel = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM affiliate_leads al
    WHERE al.status = 'converted' AND al.converted_player_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM affiliate_relationships WHERE referred_player_id = al.converted_player_id)
  `).get() as { cnt: number }).cnt;

  const relsNoOrigin = (db.prepare(
    `SELECT COUNT(*) AS cnt FROM affiliate_relationships WHERE origin_game_id IS NULL AND status = 'active'`
  ).get() as { cnt: number }).cnt;

  const relsNoReferred = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM affiliate_relationships ar
    WHERE NOT EXISTS (SELECT 1 FROM players WHERE id = ar.referred_player_id)
  `).get() as { cnt: number }).cnt;

  const orphanPayments = (db.prepare(`
    SELECT COUNT(*) AS cnt FROM affiliate_payments ap
    WHERE NOT EXISTS (SELECT 1 FROM affiliate_relationships WHERE id = ap.relationship_id)
  `).get() as { cnt: number }).cnt;

  return NextResponse.json({
    pending_leads_no_relationship: pendingLeadsNoRel,
    relationships_no_origin: relsNoOrigin,
    relationships_no_referred_player: relsNoReferred,
    orphan_payments: orphanPayments,
  });
}
