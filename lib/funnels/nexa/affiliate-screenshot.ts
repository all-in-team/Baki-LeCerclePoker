// Post-traitement déterministe d'un screenshot de report NEXA.
//
// MODULE PUR — un seul import, de TYPE uniquement (`RawAffiliateRow`), effacé à
// la compilation : aucune dépendance à l'exécution, aucun accès DB, aucun réseau.
// La transcription de l'image (appel vision) vit ailleurs ; ici on ne fait que
// convertir une transcription BRUTE en lignes exploitables, de façon reproductible
// et testable sans clé API.
//
// Le résultat est un tableau de `RawAffiliateRow` — le même contrat que la saisie
// manuelle et qu'un futur XLSX. L'extraction n'écrit RIEN : elle pré-remplit la
// grille, qui passe ensuite par validate puis commitWeek comme d'habitude.
//
// ─────────────────────────────────────────────────────────────────────────────
// On ne répare rien. Une cellule illisible, une plage de dates incohérente, un
// total manquant : c'est un rejet nommé, jamais une valeur inventée. Un 0 posé à
// la place d'un chiffre non lu serait indétectable en aval.
// ─────────────────────────────────────────────────────────────────────────────
import type { RawAffiliateRow } from "./affiliate-deal";

/** Une cellule telle que la transcription la rend : nombre, texte brut, ou null = illisible. */
export type RawCell = number | string | null | undefined;

/** Une ligne du tableau, transcrite sans interprétation. */
export type ExtractedRow = {
  nickname: RawCell;
  member_id: RawCell;
  affiliate: RawCell;
  deal_text: RawCell;
  nlh: RawCell;
  mtt: RawCell;
  plo: RawCell;
  spins: RawCell;          // colonne « Global Spins »
  affiliate_payment: RawCell;
};

/** Ce que la transcription doit produire pour un screenshot. */
export type ExtractedSheet = {
  /** En haut à GAUCHE, ex. "July 2026". Porte l'année. */
  month_label: RawCell;
  /** En haut à DROITE, ex. "13.07.-19.07." ou "27.07.-02.08.". */
  week_label: RawCell;
  rows: ExtractedRow[];
  /** Dernière ligne, en gras, colonne Payment. Sert de checksum — pas un joueur. */
  total_payment: RawCell;
};

// ── Montants ──────────────────────────────────────────────────────────────

export type AmountResult =
  | { ok: true; value: number }
  | { ok: false; reason: string };

/**
 * « $1,111.95 » → 1111.95 · « -$61.46 » et « $-61.46 » → -61.46 · « » → 0.
 *
 * Cellule VIDE = 0 : c'est le format NEXA, pas une donnée manquante (constaté
 * sur les 3 screens réels). Cellule NULL = illisible : rejet. La distinction est
 * portée par la transcription, qui doit rendre "" pour une case vide et null
 * pour une case qu'elle n'arrive pas à lire.
 */
export function parseAmount(raw: RawCell): AmountResult {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "cellule illisible (null) — aucune valeur ne peut en être déduite" };
  }
  if (typeof raw === "number") {
    return isFinite(raw) ? { ok: true, value: raw } : { ok: false, reason: `nombre non fini : ${raw}` };
  }

  const s = String(raw).trim();
  if (s === "" || s === "-" || s === "—") return { ok: true, value: 0 }; // case vide du format NEXA

  // Le signe peut précéder ou suivre le $ ; les milliers sont séparés par des virgules.
  const cleaned = s.replace(/\s/g, "").replace(/\$/g, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, reason: `montant illisible : « ${s} »` };
  }
  const n = Number(cleaned);
  return isFinite(n) ? { ok: true, value: n } : { ok: false, reason: `montant illisible : « ${s} »` };
}

// ── Semaine ───────────────────────────────────────────────────────────────

const MONTHS: Readonly<Record<string, number>> = {
  JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6,
  JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12,
};

export type WeekResult =
  | { ok: true; week_start: string; week_end: string }
  | { ok: false; reason: string };

const iso = (y: number, m: number, d: number) =>
  `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * « July 2026 » + « 13.07.-19.07. » → lundi 2026-07-13, dimanche 2026-07-19.
 *
 * L'année ne figure QUE dans le libellé de gauche ; la plage n'a que jour.mois.
 * Deux chevauchements à gérer, tous deux vus ou prévisibles sur les vrais fichiers :
 *   • de mois  : « 27.07.-02.08. » — la fin est le mois suivant (screen réel) ;
 *   • d'année  : « 29.12.-04.01. » — la fin bascule sur l'année suivante.
 * Détection sur le mois de fin < mois de début, jamais sur une supposition.
 *
 * Trois garde-fous, chacun un rejet nommé plutôt qu'un recalage silencieux :
 * le début doit être un LUNDI, l'écart doit faire exactement 6 jours, et le mois
 * de début doit correspondre au libellé de gauche.
 */
export function parseWeekRange(monthLabel: RawCell, weekLabel: RawCell): WeekResult {
  const ml = String(monthLabel ?? "").trim();
  const wl = String(weekLabel ?? "").trim();
  if (ml === "") return { ok: false, reason: "libellé de mois absent — l'année est introuvable" };
  if (wl === "") return { ok: false, reason: "plage de dates absente" };

  const mm = /^([A-Za-zÀ-ÿ]+)\s+(\d{4})$/.exec(ml);
  if (!mm) return { ok: false, reason: `libellé de mois illisible : « ${ml} » (attendu « July 2026 »)` };
  const labelMonth = MONTHS[mm[1].toUpperCase()];
  if (!labelMonth) return { ok: false, reason: `mois inconnu : « ${mm[1]} » (libellés anglais attendus)` };
  const labelYear = Number(mm[2]);

  const wm = /^(\d{1,2})\.(\d{1,2})\.\s*-\s*(\d{1,2})\.(\d{1,2})\.?$/.exec(wl);
  if (!wm) return { ok: false, reason: `plage illisible : « ${wl} » (attendu « 13.07.-19.07. »)` };
  const [d1, m1, d2, m2] = [Number(wm[1]), Number(wm[2]), Number(wm[3]), Number(wm[4])];

  if (m1 !== labelMonth) {
    return { ok: false, reason: `incohérence : la plage commence en mois ${m1} mais le libellé dit « ${ml} »` };
  }
  // Le mois de fin recule ⇒ on a franchi le 31 décembre.
  const endYear = m2 < m1 ? labelYear + 1 : labelYear;

  const start = new Date(`${iso(labelYear, m1, d1)}T00:00:00Z`);
  const end = new Date(`${iso(endYear, m2, d2)}T00:00:00Z`);
  if (Number.isNaN(start.getTime())) return { ok: false, reason: `date de début impossible : ${d1}.${m1}.${labelYear}` };
  if (Number.isNaN(end.getTime())) return { ok: false, reason: `date de fin impossible : ${d2}.${m2}.${endYear}` };
  if (start.toISOString().slice(0, 10) !== iso(labelYear, m1, d1)) {
    return { ok: false, reason: `date de début inexistante : ${d1}.${m1}.${labelYear}` };
  }

  if (start.getUTCDay() !== 1) {
    return { ok: false, reason: `le début de plage ${iso(labelYear, m1, d1)} n'est pas un lundi` };
  }
  const days = Math.round((end.getTime() - start.getTime()) / 86400000);
  if (days !== 6) {
    return { ok: false, reason: `la plage couvre ${days + 1} jour(s) au lieu de 7` };
  }

  return { ok: true, week_start: start.toISOString().slice(0, 10), week_end: end.toISOString().slice(0, 10) };
}

// ── Ligne de total ────────────────────────────────────────────────────────

/**
 * La dernière ligne du tableau est le total de la colonne Payment, en gras.
 * Elle n'a ni pseudo, ni ID, ni deal, ni montant par variante — uniquement un
 * Payment. Ce n'est PAS un joueur : l'inclure fausserait toute la comptabilité.
 */
export function isTotalRow(row: ExtractedRow): boolean {
  const blank = (c: RawCell) => c === null || c === undefined || String(c).trim() === "";
  return blank(row.nickname) && blank(row.member_id) && blank(row.deal_text) && !blank(row.affiliate_payment);
}

// ── Checksum ──────────────────────────────────────────────────────────────

/**
 * Tolérance du checksum : 0,02 × nombre de lignes retenues.
 *
 * NEXA additionne les Payments NON ARRONDIS puis arrondit le total, alors que la
 * colonne affiche chaque Payment déjà arrondi. Sur le report du 27.07 : la somme
 * des valeurs affichées fait 711,07 quand le total imprimé dit 711,06 — fichier
 * parfaitement recopié, écart purement mécanique. Un seuil fixe à 0,02 hurlerait
 * dessus ; le seuil proportionnel absorbe l'arrondi sans masquer une ligne perdue
 * (une ligne oubliée décale d'un montant réel, pas de quelques centimes).
 */
export const CHECKSUM_PER_ROW = 0.02;

export type Checksum = {
  /** Total lu en bas du screenshot, ou null s'il était absent/illisible. */
  total_read: number | null;
  /** Σ des Affiliate Payment extraits (hors ligne de total). */
  sum_rows: number;
  /** sum_rows − total_read, ou null sans total. */
  delta: number | null;
  tolerance: number;
  /** false ⇒ une ligne manque, est en trop, ou un montant a été mal lu. */
  ok: boolean;
  message: string | null;
};

// ── Conversion ────────────────────────────────────────────────────────────

export type SheetReject = {
  /** Index de la ligne dans le screenshot (0 = première ligne joueur), null = en-tête. */
  row: number | null;
  nickname: string | null;
  reason: string;
};

export type SheetResult =
  | { ok: true; week_start: string; week_end: string; rows: RawAffiliateRow[]; checksum: Checksum; rejected: SheetReject[] }
  | { ok: false; reason: string; rejected: SheetReject[] };

const text = (c: RawCell) => (c === null || c === undefined ? "" : String(c).trim());

/**
 * Transcription brute → lignes exploitables + checksum.
 *
 * Ne valide PAS le recalcul de l'Affiliate Payment : c'est le rôle de
 * `validateRow` (./affiliate-deal), appelé ensuite par le contrôle serveur de la
 * grille. Une seule implémentation de cette règle, comme pour tous les chemins.
 */
export function buildSheet(sheet: ExtractedSheet): SheetResult {
  const rejected: SheetReject[] = [];

  const week = parseWeekRange(sheet?.month_label, sheet?.week_label);
  if (!week.ok) return { ok: false, reason: week.reason, rejected };

  const rows: RawAffiliateRow[] = [];
  let sumRows = 0;

  const src = Array.isArray(sheet?.rows) ? sheet.rows : [];
  for (let i = 0; i < src.length; i++) {
    const r = src[i];
    if (!r || isTotalRow(r)) continue; // la ligne de total n'est jamais un joueur

    const nickname = text(r.nickname);
    // Une ligne entièrement vide est un artefact de grille, pas une erreur.
    const allBlank = [r.nickname, r.member_id, r.deal_text, r.nlh, r.mtt, r.plo, r.spins, r.affiliate_payment]
      .every(c => text(c) === "");
    if (allBlank) continue;

    if (nickname === "") {
      rejected.push({ row: i, nickname: null, reason: "pseudo illisible ou absent — ligne non rattachable" });
      continue;
    }
    const deal = text(r.deal_text);
    if (deal === "") {
      rejected.push({ row: i, nickname, reason: "colonne « Affiliate deal » vide ou illisible — taux inconnus" });
      continue;
    }

    const amounts: Record<string, number> = {};
    let bad: string | null = null;
    for (const [key, cell] of [["nlh", r.nlh], ["mtt", r.mtt], ["plo", r.plo],
                               ["spins", r.spins], ["affiliate_payment", r.affiliate_payment]] as const) {
      const p = parseAmount(cell);
      if (!p.ok) { bad = `${key.toUpperCase()} : ${p.reason}`; break; }
      amounts[key] = p.value;
    }
    if (bad) { rejected.push({ row: i, nickname, reason: bad }); continue; }

    const memberId = text(r.member_id);
    rows.push({
      nickname,
      member_id: memberId === "" ? null : memberId,
      deal_text: deal,
      nlh: amounts.nlh, mtt: amounts.mtt, plo: amounts.plo, spins: amounts.spins,
      affiliate_payment: amounts.affiliate_payment,
    });
    sumRows += amounts.affiliate_payment;
  }

  // Checksum sur les lignes RETENUES : c'est bien celles-là que la grille recevra.
  const totalParsed = parseAmount(sheet?.total_payment);
  const tolerance = CHECKSUM_PER_ROW * Math.max(rows.length, 1);
  let checksum: Checksum;
  if (!totalParsed.ok) {
    checksum = {
      total_read: null, sum_rows: sumRows, delta: null, tolerance, ok: false,
      message: `Total du screenshot illisible (${totalParsed.reason}) — le contrôle de complétude ne peut pas être fait.`,
    };
  } else {
    const delta = sumRows - totalParsed.value;
    const ok = Math.abs(delta) <= tolerance;
    checksum = {
      total_read: totalParsed.value, sum_rows: sumRows, delta, tolerance, ok,
      message: ok ? null
        : `Σ des lignes ${sumRows.toFixed(2)} ≠ total lu ${totalParsed.value.toFixed(2)} ` +
          `(écart ${delta.toFixed(2)}, toléré ${tolerance.toFixed(2)}) — une ligne manque, est en trop, ou un montant est mal lu.`,
    };
  }

  return { ok: true, week_start: week.week_start, week_end: week.week_end, rows, checksum, rejected };
}
