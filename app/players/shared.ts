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
  /** Soft-delete : non-null ⇒ masqué de la liste par défaut, restaurable via le toggle. */
  archived_at: string | null;
  archive_reason: string | null;
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

/**
 * Période active de la page Joueurs. `key` est la valeur brute de `?filter=`
 * (donc `custom:...` en entier pour une plage libre), `kind` la famille qui
 * décide des libellés, `from`/`to` les bornes en dates nues.
 *
 * Granularité JOUR, y compris pour custom, alors que le sélecteur custom de la
 * barre propose des heures. Ce n'est pas une approximation par paresse : la
 * colonne agrège des sources qui n'ont PAS d'horodatage — les reports Wepoker
 * portent une `report_date` et les sessions grindhouse une `session_date`, deux
 * dates nues. Couper à l'heure sur les mouvements wallet tout en gardant la
 * journée entière sur les deux autres sources produirait un total qui ne
 * correspond à aucune fenêtre réelle. Les heures choisies sont donc arrondies à
 * la journée, et l'UI affiche les dates effectivement appliquées.
 *
 * ⚠️ Ces journées sont des journées UTC, pas des journées Paris. `from`/`to`
 * repartent en base via `periodToDateRange` sous la forme `date + "T00:00:00Z"`,
 * comparée à `tx_datetime` qui est stocké en UTC. Une fenêtre « du 1er au 5 août »
 * couvre donc 01/08 02:00 → 06/08 01:59 heure de Paris en été. Un cashout de
 * 00:30 tombe dans le mauvais jour. Corriger vraiment ce point demande de
 * toucher `periodToDateRange` dans lib/queries.ts (chemin money, accord de Baki
 * requis) — en attendant, l'UI annonce des journées UTC plutôt que de mentir.
 */
export interface PlayersPeriod {
  key: string;
  kind: "7d" | "30d" | "lifetime" | "custom";
  from?: string;
  to?: string;
}

export const PLAYERS_PERIOD_STORAGE_KEY = "players_period";

/** `2026-08-01` → `01/08/2026`. */
function frDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

/** Libellé court de la période, pour les en-têtes secondaires (Kanban, drawer). */
export function periodShortLabel(period: PlayersPeriod): string {
  switch (period.kind) {
    case "lifetime": return "lifetime";
    case "7d": return "7j";
    case "30d": return "30j";
    case "custom": return `${frDate(period.from!)} → ${frDate(period.to!)}`;
  }
}

/** Libellé de la colonne agency cut — dépend de la période active. */
export function agencyColumnLabel(period: PlayersPeriod): string {
  switch (period.kind) {
    case "lifetime": return "Agency cut — Lifetime";
    case "7d": return "Agency cut 7j";
    case "30d": return "Agency cut 30j";
    case "custom": return `Agency cut — ${frDate(period.from!)} → ${frDate(period.to!)}`;
  }
}

/** Sous-titre de la page. */
export function periodSubtitle(period: PlayersPeriod): string {
  const base = "Roster, deals par game et contribution agence";
  switch (period.kind) {
    case "lifetime": return `${base} depuis le début.`;
    case "7d": return `${base} sur 7 jours.`;
    case "30d": return `${base} sur 30 jours.`;
    case "custom": return `${base} du ${frDate(period.from!)} au ${frDate(period.to!)}.`;
  }
}

/**
 * Texte de la ligne de rappel sous les boutons de la barre.
 *
 * Deux formulations sont volontairement prudentes, parce que la requête ne tient
 * pas ce que la version précédente promettait :
 * - lifetime n'est PAS « depuis le premier mouvement » : getWalletSummaryByPlayer
 *   borne à `pgd.start_date` sur toutes les périodes, donc les mouvements
 *   antérieurs au deal sont exclus. Et la part grindhouse est plafonnée à
 *   [2020-01-01, aujourd'hui] par getGrinderProfitability.
 * - les bornes custom sont des journées UTC, pas des journées Paris : elles
 *   partent en base sous la forme `date + "T00:00:00Z"`. En été, la fenêtre est
 *   donc décalée de 2 h par rapport à l'heure de Paris.
 */
export function periodRangeLabel(period: PlayersPeriod): string {
  switch (period.kind) {
    case "lifetime":
      // Avertissement à l'écran, pas seulement dans docs/PLAYERS_PERIOD_RESERVES.md :
      // le lifetime est retarifé aux deals actuels (pas d'historique dans
      // player_game_deals) et le CNY converti au taux du jour. Chiffre indicatif.
      return "Tout l'historique disponible, depuis le début de chaque deal — indicatif : retarifé aux deals actuels, ne pas utiliser pour un règlement";
    case "7d": return "7 derniers jours";
    case "30d": return "30 derniers jours";
    case "custom":
      return `Du ${frDate(period.from!)} au ${frDate(period.to!)} inclus — journées calendaires UTC`;
  }
}

export interface PlayersViewProps {
  players: Player[];
  gamesByPlayer: Record<number, string[]>;
  dealsByPlayer: Record<number, Deal[]>;
  agencyByPlayer: Record<number, number>;
  pnlByPlayerGame: Record<string, { player_net: number; agency_pnl: number }>;
  activeGames: Game[];
  apps: App[];
  affiliatedByPlayer: Record<number, { name: string; handle: string | null }>;
  period: PlayersPeriod;
}

// Un joueur "actif" au sens du roster : les deux status que le bot écrit.
export function isActiveStatus(status: string): boolean {
  return status === "active" || status === "signed";
}

export function fmtAmt(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toLocaleString("fr-FR", { maximumFractionDigits: 0 })}`;
}
