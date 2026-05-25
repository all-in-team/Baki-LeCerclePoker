export const dynamic = "force-dynamic";
import { getTopContributors, getCrmNotes } from "@/lib/queries";
import { getDb } from "@/lib/db";
import PageHeader from "@/components/PageHeader";
import Link from "next/link";

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}

function fmtAmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}`;
}

export default function CRMPage() {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const d30 = daysAgo(30);

  const allPlayers = db.prepare(`
    SELECT p.id, p.name, p.telegram_handle, p.status, p.tier,
      (SELECT MAX(created_at) FROM crm_notes WHERE player_id = p.id) AS last_note_at,
      (SELECT COUNT(*) FROM crm_notes WHERE player_id = p.id) AS note_count
    FROM players p WHERE p.status IN ('active', 'signed', 'inactive')
    ORDER BY p.name
  `).all() as any[];

  const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
    TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
    KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
    A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
    Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
    Xpoker:  { short: "XP", bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
    ClubGG:  { short: "CG", bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
  };
  const BADGE_FALLBACK = { short: "??", bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };

  const games = db.prepare(`
    SELECT pgd.player_id, GROUP_CONCAT(g.name, ',') AS game_names
    FROM player_game_deals pgd JOIN games g ON g.id = pgd.game_id GROUP BY pgd.player_id
  `).all() as any[];
  const gamesByPlayer = new Map<number, string[]>();
  games.forEach((g: any) => gamesByPlayer.set(g.player_id, (g.game_names as string).split(",")));

  const contributors = getTopContributors({ from: d30, to: today }, 100);
  const agencyByPlayer = new Map<number, number>();
  contributors.forEach(c => agencyByPlayer.set(c.player_id, c.agency_usdt));

  const sorted = [...allPlayers].sort((a, b) => (agencyByPlayer.get(b.id) ?? 0) - (agencyByPlayer.get(a.id) ?? 0));

  return (
    <>
      <PageHeader title="CRM Joueurs" subtitle="Vue d'ensemble des joueurs et leur contribution" />
      <div style={{ padding: "0 28px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)", color: "var(--text-muted)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em" }}>
              <th style={{ textAlign: "left", padding: "8px" }}>Joueur</th>
              <th style={{ textAlign: "center", padding: "8px" }}>Games</th>
              <th style={{ textAlign: "left", padding: "8px" }}>Dernière note</th>
              <th style={{ textAlign: "right", padding: "8px" }}>Agency cut 30j</th>
              <th style={{ textAlign: "center", padding: "8px" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map(p => {
              const agency30 = agencyByPlayer.get(p.id) ?? 0;
              const playerGames = gamesByPlayer.get(p.id) ?? [];
              return (
                <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 8px" }}>
                    <Link href={`/crm/${p.id}`} style={{ fontWeight: 600, color: "var(--text)", textDecoration: "none" }}>
                      {p.name}
                    </Link>
                    {p.telegram_handle && <span style={{ fontSize: 11, color: "var(--text-dim)", marginLeft: 6 }}>@{p.telegram_handle}</span>}
                  </td>
                  <td style={{ textAlign: "center", padding: "10px 8px" }}>
                    {playerGames.map(gn => {
                      const b = GAME_BADGES[gn] ?? BADGE_FALLBACK;
                      return <span key={gn} style={{ background: b.bg, color: b.color, padding: "2px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600, marginRight: 4, display: "inline-block" }}>{b.short}</span>;
                    })}
                  </td>
                  <td style={{ padding: "10px 8px", fontSize: 11, color: "var(--text-muted)" }}>
                    {p.last_note_at ? p.last_note_at.slice(0, 10) : "—"}
                  </td>
                  <td style={{ textAlign: "right", padding: "10px 8px", fontWeight: 600, color: agency30 > 0 ? "#D4AF37" : agency30 < 0 ? "#EF4444" : "var(--text-muted)" }}>
                    {agency30 !== 0 ? `${fmtAmt(agency30)} USDT` : "—"}
                  </td>
                  <td style={{ textAlign: "center", padding: "10px 8px" }}>
                    <span style={{
                      padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600,
                      background: p.status === "active" ? "rgba(16,185,129,0.15)" : "rgba(156,163,175,0.15)",
                      color: p.status === "active" ? "#10B981" : "var(--text-muted)",
                    }}>{p.status}</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
