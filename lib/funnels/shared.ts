// Couche partagée des funnels de room (QQPK, Nexa, …).
//
// PUR : aucun accès DB, aucun import serveur (xlsx…), aucun JSX — ce module est
// importable côté client comme côté serveur. Le parsing XLSX vit dans
// ./xlsx-import.ts (serveur uniquement), les composants dans components/funnel/.
//
// But : un funnel = un jeu de stages + une config de room. Tout ce qui est commun
// (cards de conversion, badge de vérification, agrégats, formatage) est ici, une
// seule fois, au lieu d'être recopié par room.

// ── Handles support ───────────────────────────────────────
// Les DEUX handles vers qui un lead est renvoyé vivent ici, et nulle part ailleurs :
// changer de destinataire = éditer cette section, rien d'autre. Sans `@` — il est
// ajouté par le copy, qui décide de la formulation.
//
// Pas d'env var volontairement : ce module est importé côté client, et une variable
// non préfixée NEXT_PUBLIC_ y vaudrait `undefined` dans le bundle.

/** Humain qui répond aux leads en DM (funnel Nexa + fin de funnel QQPK). */
export const SUPPORT_HANDLE = "hugoroine";

/** Canal support poker QQPK — destinataire distinct de SUPPORT_HANDLE, volontairement. */
export const SUPPORT_HANDLE_QQPK = "LecercleSupportPK";

// ── Stages ────────────────────────────────────────────────
// Une room décrit ses étapes par ordre croissant. QQPK utilise un stage entier
// (0-4), les funnels suivants un slug — d'où le champ générique `key`.
export type FunnelStageDef<K extends string | number = string | number> = {
  key: K;
  label: string;
  /** Couleur du label dans le tableau des leads. */
  color: string;
};

/** Retrouve la définition d'une étape, avec repli sur la première. */
export function stageDef<K extends string | number>(
  stages: FunnelStageDef<K>[],
  key: K,
): FunnelStageDef<K> {
  return stages.find(s => s.key === key) ?? stages[0];
}

// ── Cards de conversion ───────────────────────────────────
// Une card = un libellé + un prédicat. Le sous-titre par défaut est le % du total
// des leads (le funnel se lit de haut en bas) ; `sub` le remplace quand la card
// n'est pas une étape de conversion (ex. "ont lancé le bot", "rake > 0").
export type FunnelCardSpec<L> = {
  label: string;
  match: (lead: L) => boolean;
  sub?: string;
  /** Card du KPI qui porte le revenu — mise en avant visuellement. */
  accent?: boolean;
};

export type ConversionCard = {
  label: string;
  count: number;
  sub: string;
  /**
   * Remplace `count` à l'affichage. Sert aux cards qui portent un MONTANT et non
   * un effectif : un montant se formate (décimales, devise) et ne se compare pas
   * aux autres cards. `count` reste renseigné pour ne pas perdre l'effectif.
   */
  value?: string;
  accent?: boolean;
};

export function buildConversionCards<L>(leads: L[], specs: FunnelCardSpec<L>[]): ConversionCard[] {
  const total = leads.length;
  return specs.map(spec => {
    const count = leads.filter(spec.match).length;
    const sub = spec.sub ?? (total === 0 ? "—" : `${Math.round((count / total) * 100)}%`);
    return { label: spec.label, count, sub, accent: spec.accent };
  });
}

// ── Badge de vérification room ────────────────────────────
// Un Member ID n'est "vérifié" que s'il apparaît dans au moins un import hebdo du
// report de la room — c'est la seule preuve que le compte existe vraiment. Un ID
// inventé reste "à vérifier" indéfiniment. (Origine : PR #42 sur QQPK.)
export type VerificationState = "none" | "pending" | "verified";

export function verificationState(memberId: string | null | undefined, weeksCount: number): VerificationState {
  if (!memberId) return "none";
  return weeksCount > 0 ? "verified" : "pending";
}

/** Un lead est "vérifié room" dès qu'il a au moins une semaine importée. */
export function isRoomVerified(lead: { weeks_count: number }): boolean {
  return lead.weeks_count > 0;
}

/** Un lead "a joué" dès que son rake cumulé est > 0. */
export function hasPlayed(lead: { total_rake: number }): boolean {
  return lead.total_rake > 0;
}

// ── Agrégats des reports hebdo ────────────────────────────
/** Regroupe les lignes hebdo par Member ID (ordre d'entrée préservé). */
export function groupByMember<R extends { member_id: string }>(rows: R[]): Record<string, R[]> {
  const out: Record<string, R[]> = {};
  for (const r of rows) (out[r.member_id] ??= []).push(r);
  return out;
}

// ── Formatage (frontière d'affichage uniquement) ──────────
export function fmtAmount(n: number): string {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtDateTime(s: string | null): string {
  if (!s) return "—";
  return s.slice(0, 16).replace("T", " ");
}

/**
 * Lundi de la semaine PASSÉE — valeur par défaut du champ "Semaine du" à l'import
 * (les reports room livrent toujours les chiffres de la semaine écoulée).
 */
export function lastWeekMonday(): string {
  const d = new Date();
  const day = d.getDay() === 0 ? 7 : d.getDay(); // lundi=1 … dimanche=7
  d.setDate(d.getDate() - (day - 1) - 7);
  return d.toISOString().slice(0, 10);
}
