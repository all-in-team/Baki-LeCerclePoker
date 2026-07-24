// Config du funnel QQPK — tout ce qui est spécifique à la room vit ici.
// Données pures : importable côté client (stages, cards) comme côté serveur
// (columnMap de l'import). Les handlers bot restent dans lib/qqpk-funnel.ts.
import type { FunnelStageDef, FunnelCardSpec } from "@/lib/funnels/shared";
import { isRoomVerified, hasPlayed } from "@/lib/funnels/shared";
import type { WeeklyColumnMap } from "@/lib/funnels/xlsx-import";

/** QQPK indexe ses étapes par un entier (0-4) — historique, ne pas renuméroter. */
export const QQPK_STAGES: FunnelStageDef<number>[] = [
  { key: 0, label: "🚀 Started", color: "#8888A0" },
  { key: 1, label: "📲 App installée", color: "#60A5FA" },
  { key: 2, label: "💰 Dépôt fait · attend ID", color: "#F0B90B" },
  { key: 3, label: "🆔 ID reçu", color: "#34D399" },
  { key: 4, label: "🔓 Débloqué", color: "#10B981" },
];

type LeadForCards = { stage: number; weeks_count: number; total_rake: number };

export const QQPK_CARDS: FunnelCardSpec<LeadForCards>[] = [
  { label: "Started", match: () => true, sub: "ont lancé le bot" },
  { label: "App installée", match: l => l.stage >= 1 },
  { label: "Dépôt fait", match: l => l.stage >= 2 },
  { label: "Débloqués (ID reçu)", match: l => l.stage >= 4 },
  { label: "Vérifiés room", match: isRoomVerified, sub: "ID vu dans un import" },
  { label: "Ont joué", match: hasPlayed, sub: "rake > 0" },
];

/** En-têtes du report hebdo QQPK (vérifiés sur un export réel de 274 lignes). */
export const QQPK_COLUMN_MAP: WeeklyColumnMap = {
  memberId: "Member ID",
  nickname: "Member nickname",
  deposits: "Deposit Amount",
  withdrawals: "Withdrawal Amount",
  rake: "Rake (Cash Game)",
  insurance: "Insurance",
  winloss: "Win/Loss (Cash Game)",
  rewards: "Total Rewards",
};
