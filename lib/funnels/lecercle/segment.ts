// Segment des diffusions @LeCercle_Lebot — module PUR (aucun import), partagé
// par le serveur (audience.ts) et l'écran, qui ne doit pas tirer la base.

export const SOURCE_KEYS = ["onboarding", "nexa", "qqpk", "affiliate", "player", "other"] as const;
export type SourceKey = typeof SOURCE_KEYS[number];

export const SOURCE_LABELS: Record<SourceKey, string> = {
  onboarding: "Onboarding",
  nexa: "Nexa funnel",
  qqpk: "QQPK funnel",
  affiliate: "Parrainage (ref_)",
  player: "Joueur (DM avec le bot)",
  other: "Autre (vu par le webhook seulement)",
};

export const ONBOARDING_STAGES = ["welcome", "discovered", "joined"] as const;
export const NEXA_STAGES = ["started", "app_installed", "account_created", "deposit_done", "room_verified", "played"] as const;
export const QQPK_STAGES = [0, 1, 2, 3, 4] as const;

export type ExclusionMotive = "owner" | "blocked" | "relances_off" | "takeover";

export const MOTIVE_LABELS: Record<ExclusionMotive, string> = {
  owner: "opérateur (OWNER_IDS)",
  blocked: "a bloqué le bot",
  relances_off: "relances coupées (Nexa)",
  takeover: "takeover live / attend un humain",
};

export interface LecercleSegment {
  /** Au moins une source : le compte est retenu s'il appartient à L'UNE d'elles. */
  sources: SourceKey[];
  /** `null` = toutes les étapes de ce funnel. Ne s'applique qu'à sa source. */
  onboardingStages: string[] | null;
  nexaStages: string[] | null;
  /** Canal d'acquisition Nexa (ig, tg, direct…). `null` = tous. */
  nexaSources: string[] | null;
  qqpkStages: number[] | null;
  /** Rattaché à une fiche `players` (par telegram_id). */
  linked: "any" | "yes" | "no";
  /** Date du premier contact, bornes INCLUSES, jours calendaires UTC+8 (YYYY-MM-DD). */
  startedFrom: string | null;
  startedTo: string | null;
  /** Vu dans les N derniers jours. */
  activeWithinDays: number | null;
  /** Pas vu depuis N jours (jamais vu compte comme inactif). */
  inactiveForDays: number | null;
  /** Joueurs sans preuve de /start. Décoché par défaut. */
  includeUnproven: boolean;
}

export const DEFAULT_SEGMENT: LecercleSegment = {
  sources: [...SOURCE_KEYS],
  onboardingStages: null,
  nexaStages: null,
  nexaSources: null,
  qqpkStages: null,
  linked: "any",
  startedFrom: null,
  startedTo: null,
  activeWithinDays: null,
  inactiveForDays: null,
  includeUnproven: false,
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (v: string) => DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00+08:00`));

/** Le segment est-il exploitable ? Rendu tel quel à l'écran. */
export function segmentError(s: LecercleSegment): string | null {
  if (!s || typeof s !== "object") return "Segment manquant";
  if (!Array.isArray(s.sources)) return "sources doit être une liste";
  if (s.sources.some(x => !SOURCE_KEYS.includes(x))) return "Source inconnue";
  if (s.sources.length === 0 && !s.includeUnproven) return "Aucune source sélectionnée";
  const listOk = (v: unknown, allowed: readonly (string | number)[]) =>
    v === null || (Array.isArray(v) && v.every(x => allowed.includes(x as any)));
  if (!listOk(s.onboardingStages, ONBOARDING_STAGES)) return "Étape onboarding inconnue";
  if (!listOk(s.nexaStages, NEXA_STAGES)) return "Étape Nexa inconnue";
  if (!listOk(s.qqpkStages, QQPK_STAGES)) return "Étape QQPK inconnue";
  if (s.nexaSources !== null && !(Array.isArray(s.nexaSources) && s.nexaSources.every(x => typeof x === "string"))) {
    return "Sources Nexa invalides";
  }
  for (const [k, v] of [["onboarding", s.onboardingStages], ["nexa", s.nexaStages], ["qqpk", s.qqpkStages]] as const) {
    if (Array.isArray(v) && v.length === 0) return `Aucune étape ${k} sélectionnée`;
  }
  if (Array.isArray(s.nexaSources) && s.nexaSources.length === 0) return "Aucune source Nexa sélectionnée";
  if (!["any", "yes", "no"].includes(s.linked)) return "Filtre joueur rattaché invalide";
  if (s.startedFrom !== null && !isDay(s.startedFrom)) return "Date de début invalide";
  if (s.startedTo !== null && !isDay(s.startedTo)) return "Date de fin invalide";
  for (const v of [s.activeWithinDays, s.inactiveForDays]) {
    if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 3650)) return "Nombre de jours invalide";
  }
  if (typeof s.includeUnproven !== "boolean") return "includeUnproven doit être un booléen";
  return null;
}

