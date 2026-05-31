export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import AffiliatesClient from "./AffiliatesClient";

export default function AffiliatesPage() {
  const db = getDb();

  const agents = db.prepare(`
    SELECT ap.affiliate_player_id, ap.joined_at, ap.status AS profile_status,
      p.name, p.telegram_handle, p.telegram_id
    FROM affiliate_profiles ap
    JOIN players p ON p.id = ap.affiliate_player_id
    WHERE ap.status = 'active'
    ORDER BY p.name
  `).all() as any[];

  const players = db.prepare(`SELECT id, name, telegram_handle FROM players WHERE status IN ('active', 'signed') ORDER BY name`).all() as any[];
  const activeGames = db.prepare(`SELECT id, name FROM games WHERE status = 'active' ORDER BY id`).all() as any[];
  const existingReferredIds = db.prepare(`SELECT referred_player_id FROM affiliate_relationships WHERE status != 'terminated'`).all().map((r: any) => r.referred_player_id) as number[];

  return (
    <>
      <PageHeader title="Affiliates" subtitle="Agents actifs et leurs filleuls" />
      <AffiliatesClient
        agents={agents}
        players={players}
        activeGames={activeGames}
        existingReferredIds={existingReferredIds}
      />
    </>
  );
}
