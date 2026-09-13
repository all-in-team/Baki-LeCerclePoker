// XPoker Twd — nom d'onglet → PROPOSITION de semaine. Module pur, aucun import.
//
// Le nom d'onglet est un libellé OPAQUE : « 8/3 » dans Google Sheets, « 83 » dans
// l'export XLSX (le « / » est interdit dans un nom de feuille), « Sheet1 » dans un
// CSV natif. Il ne porte pas l'année, et sans « / » il est ambigu (« 111 » = 1/11
// ou 11/1 — 36 collisions sur l'année). Donc :
//   • l'ANNÉE N'EST JAMAIS DÉDUITE : l'appelant la fournit (suggestion, à confirmer) ;
//   • on rend TOUS les candidats, jamais un seul choisi en silence ;
//   • la semaine stockée est une plage de dates COMPLÈTE confirmée à la main.
//
// Convention par défaut (inférence Baki, à confirmer par le club) : l'onglet est
// nommé par le LUNDI de règlement et couvre la semaine PRÉCÉDENTE (« 3/23 » →
// lun 16/03 → dim 22/03). Le classeur a été créé le lundi 2026-03-23, jour de son
// premier onglet. L'autre convention reste disponible, pas cachée.

export type TabDateCandidate = { month: number; day: number; label: string };

export type WeekConvention = "previous_week" | "starting_week";

/** Tous les (mois, jour) que le libellé peut désigner. Vide si ce n'est pas une date M/D. */
export function tabDateCandidates(label: string): TabDateCandidate[] {
  const s = String(label ?? "").trim();
  const slash = s.match(/^(\d{1,2})[\/\-.](\d{1,2})$/);
  if (slash) {
    const m = Number(slash[1]), d = Number(slash[2]);
    return validMD(m, d) ? [{ month: m, day: d, label: `${m}/${d}` }] : [];
  }
  if (!/^\d{2,4}$/.test(s)) return [];
  // Sans séparateur : toutes les coupes M|D valides, dans l'ordre naturel.
  const out: TabDateCandidate[] = [];
  for (let cut = 1; cut < s.length; cut++) {
    const m = Number(s.slice(0, cut)), d = Number(s.slice(cut));
    if (String(m) !== s.slice(0, cut) || String(d) !== s.slice(cut)) continue; // pas de zéro de tête muet
    if (validMD(m, d)) out.push({ month: m, day: d, label: `${m}/${d}` });
  }
  return out;
}

function validMD(m: number, d: number): boolean {
  return Number.isInteger(m) && Number.isInteger(d) && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** 'YYYY-MM-DD' en UTC, ou null si la date n'existe pas (30/02). */
export function isoDate(year: number, month: number, day: number): string | null {
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return dt.toISOString().slice(0, 10);
}

export const DAY_NAMES = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"] as const;

export function dayOfWeek(iso: string): (typeof DAY_NAMES)[number] {
  return DAY_NAMES[new Date(iso + "T00:00:00Z").getUTCDay()];
}

function addDays(iso: string, n: number): string {
  const dt = new Date(iso + "T00:00:00Z");
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** Lundi de la semaine ISO contenant `iso`. */
export function mondayOf(iso: string): string {
  const dow = new Date(iso + "T00:00:00Z").getUTCDay(); // 0 = dimanche
  return addDays(iso, -((dow + 6) % 7));
}

export type WeekProposal = {
  /** Date que le libellé désigne, dans l'année fournie. */
  tab_date: string;
  tab_day: (typeof DAY_NAMES)[number];
  week_start: string;   // lundi
  week_end: string;     // dimanche
  convention: WeekConvention;
  /** Vrai si tab_date n'est pas un lundi : la convention « lundi de règlement » ne s'applique pas telle quelle. */
  not_a_monday: boolean;
};

/**
 * Propose une semaine pour UN candidat et UNE année. Ne choisit ni l'un ni
 * l'autre : l'appelant les affiche, Baki confirme.
 */
export function proposeWeek(c: TabDateCandidate, year: number, convention: WeekConvention = "previous_week"): WeekProposal | null {
  const tab_date = isoDate(year, c.month, c.day);
  if (!tab_date) return null;
  const monday = mondayOf(tab_date);
  const week_start = convention === "previous_week" ? addDays(monday, -7) : monday;
  return {
    tab_date, tab_day: dayOfWeek(tab_date),
    week_start, week_end: addDays(week_start, 6),
    convention, not_a_monday: monday !== tab_date,
  };
}
