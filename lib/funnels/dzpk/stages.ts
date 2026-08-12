// Étapes et cards du funnel dzpk — module PUR.
//
// Séparé de ./config.ts VOLONTAIREMENT : config.ts lit `process.env` à chaque
// appel (token du bot, lien du club…). Importé depuis un composant client, il
// embarquerait ces lecteurs dans le bundle navigateur, où ils rendraient tous
// `null` sans que rien ne le signale. Ici : aucune dépendance, aucun accès base,
// aucun JSX — importable des deux côtés, comme lib/funnels/nexa/config.ts.

import type { FunnelStageDef, FunnelCardSpec } from "@/lib/funnels/shared";
import type { DzpkState } from "./leads";

// ── Étapes ────────────────────────────────────────────────
// Les clés SONT celles de `deriveState` (lib/funnels/dzpk/leads.ts) : l'état
// affiché est dérivé des faits, jamais stocké. Ajouter une étape ici sans
// l'ajouter là-bas ne produirait qu'un libellé mort.
//
// « Banni » n'est PAS une étape, et c'est un arbitrage, pas un oubli : un joueur
// banni a bel et bien été rattaché, donc il a produit du revenu. Le sortir de
// « Rattaché » ferait mécaniquement baisser le taux de conversion de sa source.
// Il s'affiche en ATTRIBUT (badge 🚫) sur la ligne, en plus de son étape.
// (Même raisonnement que leads.ts:335.)
export const DZPK_STAGES: FunnelStageDef<DzpkState>[] = [
  { key: "started", label: "🚀 Started", color: "#8888A0" },
  { key: "replied", label: "💬 A écrit", color: "#60A5FA" },
  { key: "joined", label: "👥 A rejoint", color: "#F0B90B" },
  { key: "bound", label: "🍓 Rattaché", color: "#34D399" },
  { key: "converted", label: "✅ Converti", color: "#10B981" },
];

// ── Cards de conversion ───────────────────────────────────
// Cumulatives et non exclusives, comme getStatsBySource : un lead rattaché
// compte aussi dans « A rejoint » s'il porte une date de join. Un taux
// start → rattaché se lit donc directement de haut en bas.
//
// Conséquence à garder en tête : « A rejoint » >= « Rattaché » n'est PAS
// garanti. Le club peut rattacher un joueur dont la notif de join n'a jamais été
// vue (notif ratée, ou lead entré avant la mise en service de l'ingestion).
type LeadForCards = {
  club_joined_at: string | null;
  bound_at: string | null;
  banned_at: string | null;
};

export const DZPK_CARDS: FunnelCardSpec<LeadForCards>[] = [
  { label: "Started", match: () => true, sub: "ont lancé le bot" },
  { label: "A rejoint 已进群", match: l => l.club_joined_at !== null },
  // LE KPI. C'est le seul gabarit du club qui crée du revenu (arbitrage Baki,
  // cf. docs/DZPK_BOT.md § « Le revenu se scelle au premier JEU, pas au join »).
  { label: "Rattaché 已绑定为代理 🍓", match: l => l.bound_at !== null, accent: true },
  { label: "Banni", match: l => l.banned_at !== null },
];

// ── Statut d'appariement ──────────────────────────────────
// Ce que le back-office doit dire d'un lead face aux notifications du club :
// est-ce que son rattachement est PROUVÉ, DÉCIDÉ par un humain, ou EN ATTENTE
// d'une décision ? Un rattachement faux déplace du revenu d'une source vers une
// autre sans que rien ne le signale — d'où une colonne dédiée, pas une nuance
// cachée dans une infobulle.
export type DzpkMatchStatus = "pending" | "manual" | "auto" | "none";

export const MATCH_LABELS: Record<DzpkMatchStatus, { label: string; color: string; title: string }> = {
  pending: {
    label: "🟡 à réconcilier",
    color: "#F0B90B",
    title: "Au moins une notification du club hésite entre plusieurs leads dont celui-ci — personne n'a encore tranché",
  },
  manual: {
    label: "🔗 lié à la main",
    color: "#C084FC",
    title: "Rattachement tranché par un humain — le lien de nom est mémorisé pour les fois suivantes",
  },
  auto: {
    label: "🟢 auto-certain",
    color: "#34D399",
    title: "Nom du club identique au display_name capturé au /start, sans homonyme et antérieur à la notification",
  },
  none: {
    label: "—",
    color: "#3A3A48",
    title: "Aucune notification du club ne concerne ce lead pour l'instant",
  },
};
