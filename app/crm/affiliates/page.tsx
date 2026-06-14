export const dynamic = "force-dynamic";
import { getDb } from "@/lib/db";
import { computeAgentCommission } from "@/lib/queries/affiliate";
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

  const players = db.prepare(`SELECT id, name, telegram_handle, telegram_id FROM players WHERE status IN ('active', 'signed') ORDER BY name`).all() as any[];
  const activeGames = db.prepare(`SELECT id, name, perceived_action_pct, perceived_rakeback_pct, perceived_insurance_pct FROM games WHERE status = 'active' ORDER BY id`).all() as any[];
  const existingReferredIds = db.prepare(`SELECT referred_player_id FROM affiliate_relationships WHERE status != 'terminated'`).all().map((r: any) => r.referred_player_id) as number[];

  // Agent-level commission (cross-makeup) computed server-side — single source of truth,
  // identical to the Mini App /portal (both call computeAgentCommission).
  const agentCommissions: Record<number, { cumul_agence_eligible: number; earned: number; paid: number; due_now: number }> = {};
  for (const a of agents) {
    const ac = computeAgentCommission(a.affiliate_player_id);
    agentCommissions[a.affiliate_player_id] = {
      cumul_agence_eligible: ac.cumul_agence_eligible, earned: ac.earned, paid: ac.paid, due_now: ac.due_now,
    };
  }

  return (
    <>
      <PageHeader title="Affiliates" subtitle="Agents actifs et leurs filleuls" />
      <AffiliatesClient
        agents={agents}
        players={players}
        activeGames={activeGames}
        existingReferredIds={existingReferredIds}
        agentCommissions={agentCommissions}
      />
    </>
  );
}
