export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import AffiliatesClient from "./AffiliatesClient";

export default function AffiliatesPage() {
  const db = getDb();

  const relationships = db.prepare(`
    SELECT ar.*,
      a.name AS affiliate_name, a.telegram_handle AS affiliate_handle,
      r.name AS referred_name, r.telegram_handle AS referred_handle,
      g.name AS origin_game_name
    FROM affiliate_relationships ar
    JOIN players a ON a.id = ar.affiliate_player_id
    JOIN players r ON r.id = ar.referred_player_id
    LEFT JOIN games g ON g.id = ar.origin_game_id
    ORDER BY ar.created_at DESC
  `).all() as any[];

  const players = db.prepare(`SELECT id, name, telegram_handle FROM players WHERE status IN ('active', 'signed') ORDER BY name`).all() as any[];
  const activeGames = db.prepare(`SELECT id, name FROM games WHERE status = 'active' ORDER BY id`).all() as any[];
  const existingReferredIds = db.prepare(`SELECT referred_player_id FROM affiliate_relationships WHERE status != 'terminated'`).all().map((r: any) => r.referred_player_id) as number[];

  return (
    <>
      <PageHeader title="Affiliates" subtitle="Relations affiliate → referred players" />
      <AffiliatesClient
        relationships={relationships}
        players={players}
        activeGames={activeGames}
        existingReferredIds={existingReferredIds}
      />
    </>
  );
}
