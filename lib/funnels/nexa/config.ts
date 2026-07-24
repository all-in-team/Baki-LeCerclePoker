// Config du funnel NEXAPOKER — TOUT ce qui est paramétrable vit ici.
// Aucune valeur en dur dans les handlers (règle §6 du brief).
// Données pures : importable côté client (stages, cards) comme serveur (columnMap).
import type { FunnelStageDef, FunnelCardSpec } from "@/lib/funnels/shared";
import type { WeeklyColumnMap } from "@/lib/funnels/xlsx-import";

export const NEXA_ROOM_LABEL = "NEXAPOKER";

/** Deep link : ?start=nexa (source « direct ») ou ?start=nexa_<source>. */
export const NEXA_DEEPLINK_PREFIX = "nexa";

/** Code à saisir à l'inscription — sans lui : pas de bonus et lead intraçable. */
export const NEXA_BONUS_CODE = "BONUSBLAST";

export const NEXA_DOWNLOADS = {
  windows: { label: "🪟 Windows", url: "https://downloads.nexapoker.com/latest/NEXAPOKER.exe" },
  android: { label: "🤖 Android", url: "https://downloads.nexapoker.com/latest/NEXAPOKER.apk" },
  mac: { label: "🍎 Mac", url: "https://downloads.nexapoker.com/latest/NEXAPOKER.dmg" },
} as const;

export type NexaOs = keyof typeof NEXA_DOWNLOADS;

/** Member ID NEXAPOKER : numérique, 5 à 10 chiffres. */
export const NEXA_MEMBER_ID_RE = /^\d{5,10}$/;

/** Relances J+1 / J+3 / J+7 après la dernière interaction, puis flag `cold`. */
export const NEXA_REMINDER_THRESHOLDS_H = [24, 72, 168];
export const NEXA_MAX_REMINDERS = 3;
/** Garde anti-spam : jamais deux relances à moins de N heures d'écart. */
export const NEXA_REMINDER_MIN_GAP_H = 20;

// ── Étapes ────────────────────────────────────────────────
export type NexaStage =
  | "started" | "app_installed" | "account_created"
  | "deposit_done" | "room_verified" | "played";

export const NEXA_STAGES: FunnelStageDef<NexaStage>[] = [
  { key: "started", label: "🚀 Started", color: "#8888A0" },
  { key: "app_installed", label: "📲 App installée", color: "#60A5FA" },
  { key: "account_created", label: "📝 Compte créé", color: "#F0B90B" },
  { key: "deposit_done", label: "💰 Dépôt fait", color: "#34D399" },
  { key: "room_verified", label: "✅ Vérifié room", color: "#10B981" },
  { key: "played", label: "♠️ Ont joué", color: "#10B981" },
];

/** Ordre des paliers — le stage n'avance JAMAIS à reculons. */
export const NEXA_STAGE_ORDER: Record<NexaStage, number> = {
  started: 1, app_installed: 2, account_created: 3,
  deposit_done: 4, room_verified: 5, played: 6,
};

export function nexaStageAtLeast(stage: string, min: NexaStage): boolean {
  const cur = NEXA_STAGE_ORDER[stage as NexaStage] ?? 0;
  return cur >= NEXA_STAGE_ORDER[min];
}

type LeadForCards = { stage: string; weeks_count: number; total_rake: number };

export const NEXA_CARDS: FunnelCardSpec<LeadForCards>[] = [
  { label: "Started", match: () => true, sub: "ont lancé le bot" },
  { label: "App installée", match: l => nexaStageAtLeast(l.stage, "app_installed") },
  { label: "Compte créé", match: l => nexaStageAtLeast(l.stage, "account_created") },
  { label: "Dépôt fait", match: l => nexaStageAtLeast(l.stage, "deposit_done") },
  { label: "Vérifiés room", match: l => l.weeks_count > 0, sub: "ID vu dans un import" },
  { label: "Ont joué", match: l => l.total_rake > 0, sub: "rake > 0" },
];

// ── Import hebdo ──────────────────────────────────────────
// ⚠️ PLACEHOLDER — en attente du XLSX d'exemple NEXAPOKER (Hugo, 2026-07-24).
// Les libellés ci-dessous sont des SUPPOSITIONS et ne sont pas actifs : tant que
// NEXA_COLUMN_MAP_READY est false, la route d'import refuse le fichier avec un
// message explicite au lieu d'importer n'importe quoi. Pour câbler : remplacer les
// libellés par ceux du vrai fichier et passer le flag à true. Rien d'autre à toucher.
export const NEXA_COLUMN_MAP_READY = false;

export const NEXA_COLUMN_MAP: WeeklyColumnMap = {
  memberId: "Member ID",
  nickname: "Member nickname",
  rake: "Rake",
  deposits: "Deposit Amount",
  withdrawals: "Withdrawal Amount",
  winloss: "Win/Loss",
};
