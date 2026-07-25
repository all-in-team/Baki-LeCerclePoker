// Types + badges partagés par la page Joueurs unifiée (table + kanban + modales).
// Anciennement dupliqués dans app/crm/CRMListClient.tsx, CRMKanbanView.tsx et PlayerDetailDrawer.tsx.

export const GAME_BADGES: Record<string, { short: string; bg: string; color: string }> = {
  TELE:    { short: "AK", bg: "rgba(212,175,55,0.15)", color: "#D4AF37" },
  KKPOKER: { short: "KK", bg: "rgba(59,130,246,0.15)", color: "#3B82F6" },
  A5POKER: { short: "A5", bg: "rgba(245,158,11,0.15)", color: "#F59E0B" },
  Wepoker: { short: "WE", bg: "rgba(139,92,246,0.15)", color: "#8B5CF6" },
  Xpoker:  { short: "XP", bg: "rgba(236,72,153,0.15)", color: "#EC4899" },
  ClubGG:  { short: "CG", bg: "rgba(234,179,8,0.15)",  color: "#EAB308" },
};

export const BADGE_FALLBACK = { short: "??", bg: "rgba(156,163,175,0.15)", color: "#9CA3AF" };

export function badgeFor(gameName: string) {
  return GAME_BADGES[gameName] ?? BADGE_FALLBACK;
}

export interface Player {
  id: number;
  name: string;
  telegram_handle: string | null;
  telegram_phone: string | null;
  status: string;
  tier: string | null;
  notes: string | null;
  tron_address: string | null;
  tron_app_id: number | null;
  last_note_at: string | null;
  telegram_id: number | null;
  created_at: string | null;
  joined_via: string | null;
  is_affiliate: number;
  is_referred: number;
}

export interface Deal {
  deal_id: number;
  player_id: number;
  game_id: number;
  action_pct: number;
  rakeback_pct: number;
  start_date: string | null;
  end_date: string | null;
}

export interface Game { id: number; name: string; default_action_pct: number | null; status: string; }
export interface App { id: number; name: string; }

export interface PlayersViewProps {
  players: Player[];
  gamesByPlayer: Record<number, string[]>;
  dealsByPlayer: Record<number, Deal[]>;
  agencyByPlayer: Record<number, number>;
  pnlByPlayerGame: Record<string, { player_net: number; agency_pnl: number }>;
  activeGames: Game[];
  apps: App[];
  affiliatedByPlayer: Record<number, { name: string; handle: string | null }>;
}

// Un joueur "actif" au sens du roster : les deux status que le bot écrit.
export function isActiveStatus(status: string): boolean {
  return status === "active" || status === "signed";
}

export function fmtAmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}`;
}
