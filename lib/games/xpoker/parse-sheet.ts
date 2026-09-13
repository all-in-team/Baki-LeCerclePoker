// XPoker Twd — parseur du sheet hebdo du club. SERVEUR UNIQUEMENT (dépend de `xlsx`).
//
// ─────────────────────────────────────────────────────────────────────────────
// LE MAPPING EST DÉRIVÉ DES LIBELLÉS, JAMAIS D'ADRESSES DE CELLULES.
// Un onglet contient PLUSIEURS blocs de clubs, décalés dans la même feuille ; le
// nôtre se repère par ses libellés (paramètres 幣值/反水/TAX, en-tête « Player ID »
// … « Rake(without MTT) », pied « Total Win/Lose » … « Total ») et par le nom du
// club sur la ligne des paramètres ET sur celle de l'en-tête. Les libellés eux-
// mêmes sont un paramètre (XpokerSheetLabels) : un nouveau classeur se teste en
// changeant la config, pas le code. Rien n'est figé en dur ici.
//
// RÈGLES DE LECTURE (constatées sur 19 onglets, cf. étape 1) :
//   • grille à hauteur fixe, lignes vides au milieu : on lit TOUTE la zone entre
//     l'en-tête et le pied et on retient les lignes dont « Player ID » est un
//     entier — surtout pas « jusqu'à la première ligne vide » ;
//   • champ vide = NON SAISI, jamais zéro : une ligne avec Player ID mais sans
//     Win/Lose ou sans Rake fait REFUSER l'onglet (règle anti-troncature NEXA) ;
//   • R (ID) et T (nickname) sont des libellés : on ne rattache JAMAIS dessus ;
//     T n'a pas d'en-tête dans le classeur observé (colonne Player ID + 1) ;
//   • CSV natif : les taux arrivent en texte « 80% » / « 5% », et le nom
//     d'onglet est perdu (« Sheet1 ») ;
//   • la formule TAX du pied est figée dans la feuille (−5 %) et ne lit PAS la
//     cellule TAX des paramètres : on lit la cellule (c'est la source déclarée),
//     et si elle diverge de la formule le checksum le dit (onglet 3/23 : D2 = 0).
//
// CHECKSUM : recalcul ligne à ligne sur TOUTES les lignes que le club additionne
// (agent OU super-agent = notre agent, comptes agence compris — décision Baki Q4/Q5)
// et comparaison au « Total » du pied, au centime. L'appelant REFUSE l'import sur
// écart, sauf sortie explicite « écart acté » avec motif (xpoker_imports.override_reason).
// ─────────────────────────────────────────────────────────────────────────────

import * as XLSX from "xlsx";
import { clubSettlement, withinTolerance, type ClubSettlement } from "./club-math";
import { XPOKER_CHECK_TOLERANCE } from "./schema";

export type XpokerSheetLabels = {
  chipValue: string; rakeback: string; tax: string;
  idLabel: string; playerId: string; nickname: string | null; agent: string; agentId: string; superAgentId: string;
  winloss: string; rake: string;
  totalWinloss: string; totalRake: string; totalTax: string; total: string;
  cleared: string; templateTab: string;
};

/** Libellés du classeur observé (club 花順, mars → août 2026). */
export const XPOKER_DEFAULT_LABELS: XpokerSheetLabels = {
  chipValue: "幣值", rakeback: "反水", tax: "TAX",
  idLabel: "ID", playerId: "Player ID", nickname: null, agent: "Agent", agentId: "Agent ID", superAgentId: "Super Agent ID",
  winloss: "Win/Lose", rake: "Rake(without MTT)",
  totalWinloss: "Total Win/Lose", totalRake: "Total Rake", totalTax: "TAX", total: "Total",
  cleared: "總交收", templateTab: "公版",
};

export type XpokerParseOptions = {
  /** ID agent (chips) — lignes retenues : Agent ID = agent OU Super Agent ID = agent. */
  agentId: string;
  /** Nom du club attendu sur la ligne des paramètres et sur l'en-tête de grille. */
  clubName: string;
  /** Player ID qui sont des comptes agence (xpoker_agency_accounts). */
  agencyMemberIds: ReadonlySet<string>;
  labels?: Partial<XpokerSheetLabels>;
  tolerance?: number;
};

export type XpokerParsedRow = {
  member_id: string;
  id_label: string | null;
  nickname: string | null;
  agent: string | null;
  agent_id: string;
  super_agent_id: string;
  winloss: number;
  rake: number;
  /** 'agent' = notre agent en direct · 'sub_agent' = sous-agent sous notre agent · 'foreign' = ni l'un ni l'autre */
  scope: "agent" | "sub_agent" | "foreign";
  is_agency: boolean;
};

export type XpokerParsedBlock = {
  tab_label: string;
  /** Taux du sheet en FRACTIONS (0.8 = 80 %) — l'unité est dans le nom, cf. club-math.ts. */
  params: { club: string; chip_value: number; rb_fraction: number; tax_fraction: number };
  footer: { total_winloss: number; total_rake: number; tax: number; rb_amount: number; rb_rate_label: number | null; total: number };
  /** « 總交收 » du bloc de règlement (B20) — NULL si absent. */
  cleared: number | null;
  /** Ligne « <club> » du bloc de règlement (B11) — NULL si absente. */
  cleared_club_line: number | null;
  /** Lignes que le club additionne (scope agent + sub_agent), agence comprise. */
  rows: XpokerParsedRow[];
  /** Lignes hors périmètre (scope 'foreign') — jamais importées, listées pour le rapport. */
  foreign_rows: XpokerParsedRow[];
  recompute: ClubSettlement;
  checks: {
    checksum_ok: boolean;
    check_delta: number;               // recompute.total − footer.total
    rb_ok: boolean;                     // recompute.rb ≈ footer.rb_amount
    tax_ok: boolean;                    // recompute.tax ≈ footer.tax
    cleared_matches: boolean | null;    // 總交收 ≈ Total (null si 總交收 absent)
    rb_rate_label_matches: boolean | null; // T21 (taux affiché au pied) ≈ rb_fraction des paramètres
    sub_agent_present: boolean;
    foreign_rows: number;
  };
  /** Avertissements non bloquants, lisibles tels quels. */
  warnings: string[];
};

export class XpokerParseError extends Error {
  constructor(message: string, public readonly tab?: string) { super(message); this.name = "XpokerParseError"; }
}

// ── valeurs ──────────────────────────────────────────────────────────────────

/** 0.8 | "80%" | "80 %" | "0,8" → 0.8 ; null si vide. */
export function parsePct(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const m = s.match(/^(-?[\d.,]+)\s*%$/);
  if (m) { const n = parseFloat(m[1].replace(",", ".")); return Number.isFinite(n) ? n / 100 : null; }
  const n = parseFloat(s.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/**
 * Nombre ou null — "" n'est PAS 0. "1,234.56" (virgule = milliers) et "-136,2"
 * (virgule décimale, locale FR : pas de point, 1-2 décimales) acceptés. "1,234"
 * reste lu comme mille deux cent trente-quatre — la virgule suivie de 3 chiffres
 * est un séparateur de milliers ; un CSV en locale FR à 3 décimales ferait
 * échouer le checksum, jamais un import silencieux.
 */
export function parseNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  const decimalComma = /^-?\d+,\d{1,2}$/.test(s);
  const normalized = decimalComma ? s.replace(",", ".") : s.replace(/,/g, "");
  // Match COMPLET exigé : parseFloat("-31 267.4") rendrait −31 en silence.
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

/** Un Player ID = entier d'au moins 5 chiffres (jamais un pseudo « XP4136708 »). */
export function isMemberId(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  const s = typeof v === "number" ? String(v) : String(v).trim();
  return /^\d{5,}$/.test(s);
}

const text = (v: unknown): string | null => (v === null || v === undefined || v === "") ? null : String(v).trim();
const norm = (v: unknown): string => String(v ?? "").trim().toLowerCase();

// ── grille ───────────────────────────────────────────────────────────────────

type Grid = unknown[][];

function toGrid(ws: XLSX.WorkSheet): Grid {
  if (!ws["!ref"]) return [];
  const range = XLSX.utils.decode_range(ws["!ref"]);
  const g: Grid = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: unknown[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row[c] = cell ? cell.v : undefined;
    }
    g[r] = row;
  }
  return g;
}

type Pos = { r: number; c: number };
function findAll(g: Grid, label: string): Pos[] {
  const want = norm(label), out: Pos[] = [];
  g.forEach((row, r) => row && row.forEach((v, c) => { if (norm(v) === want) out.push({ r, c }); }));
  return out;
}
function findOne(g: Grid, label: string, tab: string, where?: (p: Pos) => boolean): Pos {
  const all = findAll(g, label).filter(p => !where || where(p));
  if (all.length !== 1) {
    throw new XpokerParseError(`libellé « ${label} » : ${all.length} occurrence(s) trouvée(s), 1 attendue`, tab);
  }
  return all[0];
}

// ── parseur d'un onglet ──────────────────────────────────────────────────────

export function parseXpokerTab(ws: XLSX.WorkSheet, tabLabel: string, opts: XpokerParseOptions): XpokerParsedBlock {
  const L: XpokerSheetLabels = { ...XPOKER_DEFAULT_LABELS, ...(opts.labels ?? {}) };
  const tol = opts.tolerance ?? XPOKER_CHECK_TOLERANCE;
  const g = toGrid(ws);
  const warnings: string[] = [];

  // 1. Paramètres : libellés sur une ligne, valeurs sur la suivante, club juste à gauche.
  const hChip = findOne(g, L.chipValue, tabLabel);
  const hRb = findOne(g, L.rakeback, tabLabel, p => p.r === hChip.r);
  const hTax = findOne(g, L.tax, tabLabel, p => p.r === hChip.r);
  const pRow = g[hChip.r + 1] ?? [];
  const clubCol = hChip.c - 1;
  const club = text(pRow[clubCol]);
  if (club !== opts.clubName) {
    throw new XpokerParseError(`club des paramètres = « ${club ?? ""} », attendu « ${opts.clubName} »`, tabLabel);
  }
  const chip_value = parseNum(pRow[hChip.c]), rb_fraction = parsePct(pRow[hRb.c]), tax_fraction = parsePct(pRow[hTax.c]);
  if (chip_value === null || rb_fraction === null || tax_fraction === null) {
    throw new XpokerParseError(`paramètre vide (幣值=${pRow[hChip.c]}, 反水=${pRow[hRb.c]}, TAX=${pRow[hTax.c]}) — vide ≠ zéro`, tabLabel);
  }

  // 2. En-tête de grille : tous les libellés sur la ligne de « Player ID », club juste à gauche de « ID ».
  const hPid = findOne(g, L.playerId, tabLabel);
  const onHdr = (p: Pos) => p.r === hPid.r;
  const col = {
    id: findOne(g, L.idLabel, tabLabel, onHdr).c,
    pid: hPid.c,
    agent: findOne(g, L.agent, tabLabel, onHdr).c,
    agentId: findOne(g, L.agentId, tabLabel, onHdr).c,
    superAgentId: findOne(g, L.superAgentId, tabLabel, onHdr).c,
    winloss: findOne(g, L.winloss, tabLabel, onHdr).c,
    rake: findOne(g, L.rake, tabLabel, onHdr).c,
    nick: -1,
  };
  // Nickname : par en-tête s'il en a un (config), sinon la colonne sans en-tête à droite de Player ID.
  col.nick = L.nickname ? findOne(g, L.nickname, tabLabel, onHdr).c : hPid.c + 1;
  const clubHdr = text(g[hPid.r]?.[col.id - 1]);
  if (clubHdr !== opts.clubName) {
    throw new XpokerParseError(`club de l'en-tête de grille = « ${clubHdr ?? ""} », attendu « ${opts.clubName} »`, tabLabel);
  }

  // 3. Pied de bloc : libellés dans une colonne, valeurs dans la colonne suivante.
  const fWL = findOne(g, L.totalWinloss, tabLabel, p => p.r > hPid.r);
  const inFooterCol = (p: Pos) => p.c === fWL.c && p.r > hPid.r;
  const fRake = findOne(g, L.totalRake, tabLabel, inFooterCol);
  const fTax = findOne(g, L.totalTax, tabLabel, inFooterCol);
  const fTot = findOne(g, L.total, tabLabel, inFooterCol);
  const vc = fWL.c + 1;
  const footerNum = (p: Pos, what: string): number => {
    const n = parseNum(g[p.r]?.[vc]);
    if (n === null) throw new XpokerParseError(`pied de bloc : « ${what} » sans valeur`, tabLabel);
    return n;
  };
  // Ligne du taux : entre TAX et Total, libellé = pourcentage, valeur = 反水 × Σrake.
  let rbRow: number | null = null;
  for (let r = Math.min(fTax.r, fTot.r) + 1; r < Math.max(fTax.r, fTot.r); r++) {
    if (parsePct(g[r]?.[fWL.c]) !== null) { rbRow = r; break; }
  }
  if (rbRow === null) throw new XpokerParseError(`pied de bloc : ligne du taux 反水 (entre TAX et Total) introuvable`, tabLabel);
  const footer = {
    total_winloss: footerNum(fWL, L.totalWinloss),
    total_rake: footerNum(fRake, L.totalRake),
    tax: footerNum(fTax, L.totalTax),
    rb_rate_label: parsePct(g[rbRow]?.[fWL.c]),
    rb_amount: footerNum({ r: rbRow, c: fWL.c }, "taux 反水"),
    total: footerNum(fTot, L.total),
  };

  // 4. Bloc de règlement (colonnes club/valeur des paramètres) : « 總交收 » et la ligne du club.
  const clearedPos = findAll(g, L.cleared).filter(p => p.c === clubCol && p.r > hChip.r + 1);
  if (clearedPos.length > 1) warnings.push(`« ${L.cleared} » trouvé ${clearedPos.length} fois dans la colonne du club — première occurrence retenue`);
  const cleared = clearedPos.length ? parseNum(g[clearedPos[0].r]?.[hChip.c]) : null;
  let cleared_club_line: number | null = null;
  for (let r = hChip.r + 2; r < (clearedPos[0]?.r ?? g.length); r++) {
    if (text(g[r]?.[clubCol]) === opts.clubName) { cleared_club_line = parseNum(g[r]?.[hChip.c]); break; }
  }

  // 5. Lignes joueurs : toute la zone entre l'en-tête et le pied, retenues sur Player ID entier.
  const all: XpokerParsedRow[] = [];
  const seen = new Set<string>();
  for (let r = hPid.r + 1; r < fWL.r; r++) {
    const row = g[r] ?? [];
    const pidCell = row[col.pid];
    if (!isMemberId(pidCell)) continue;
    const member_id = typeof pidCell === "number" ? String(pidCell) : String(pidCell).trim();
    const winloss = parseNum(row[col.winloss]), rake = parseNum(row[col.rake]);
    if (winloss === null || rake === null) {
      throw new XpokerParseError(`Player ID ${member_id} (ligne ${r + 1}) : Win/Lose ou Rake vide — non saisi ≠ 0`, tabLabel);
    }
    if (seen.has(member_id)) throw new XpokerParseError(`Player ID ${member_id} présent deux fois dans le bloc`, tabLabel);
    seen.add(member_id);
    const agent_id = text(row[col.agentId]) ?? "", super_agent_id = text(row[col.superAgentId]) ?? "";
    const scope: XpokerParsedRow["scope"] =
      agent_id === opts.agentId ? "agent" : super_agent_id === opts.agentId ? "sub_agent" : "foreign";
    all.push({
      member_id, id_label: text(row[col.id]), nickname: text(row[col.nick]), agent: text(row[col.agent]),
      agent_id, super_agent_id, winloss, rake, scope, is_agency: opts.agencyMemberIds.has(member_id),
    });
  }
  const rows = all.filter(r => r.scope !== "foreign");
  const foreign_rows = all.filter(r => r.scope === "foreign");
  if (rows.length === 0) throw new XpokerParseError(`aucune ligne joueur pour l'agent ${opts.agentId} dans le bloc`, tabLabel);

  // 6. Recalcul et contrôles.
  const recompute = clubSettlement(rows, { rb_fraction, tax_fraction });
  const check_delta = recompute.total - footer.total;
  const checks = {
    checksum_ok: withinTolerance(recompute.total, footer.total, tol),
    check_delta,
    rb_ok: withinTolerance(recompute.rb, footer.rb_amount, tol),
    tax_ok: withinTolerance(recompute.tax, footer.tax, tol),
    cleared_matches: cleared === null ? null : withinTolerance(cleared, footer.total, tol),
    rb_rate_label_matches: footer.rb_rate_label === null ? null : withinTolerance(footer.rb_rate_label, rb_fraction, 1e-9),
    sub_agent_present: rows.some(r => r.scope === "sub_agent"),
    foreign_rows: foreign_rows.length,
  };
  if (!withinTolerance(recompute.total_winloss, footer.total_winloss, tol) || !withinTolerance(recompute.total_rake, footer.total_rake, tol)) {
    warnings.push(`Σ des lignes retenues (W/L ${recompute.total_winloss}, rake ${recompute.total_rake}) ≠ totaux du pied (${footer.total_winloss}, ${footer.total_rake})`);
  }
  if (!checks.tax_ok && checks.rb_ok) {
    warnings.push(`TAX recalculée ${recompute.tax} ≠ TAX du pied ${footer.tax} : le taux TAX des paramètres (${tax_fraction}) ne correspond pas à la formule de la feuille`);
  }
  if (checks.rb_rate_label_matches === false) warnings.push(`taux affiché au pied (${footer.rb_rate_label}) ≠ 反水 des paramètres (${rb_fraction})`);
  if (checks.cleared_matches === false) warnings.push(`« ${L.cleared} » (${cleared}) ≠ « Total » (${footer.total}) : le montant réglé et le total calculé divergent`);
  if (cleared_club_line !== null && cleared !== null && !withinTolerance(cleared_club_line, cleared, tol)) {
    warnings.push(`ligne « ${opts.clubName} » du bloc de règlement (${cleared_club_line}) ≠ « ${L.cleared} » (${cleared}) : d'autres clubs sont sommés dans ce bloc`);
  }
  if (foreign_rows.length) warnings.push(`${foreign_rows.length} ligne(s) hors périmètre (ni agent ni super-agent = ${opts.agentId}) : ${foreign_rows.map(r => r.member_id).join(", ")}`);
  if (checks.sub_agent_present) warnings.push(`sous-agent présent : ${rows.filter(r => r.scope === "sub_agent").map(r => `${r.member_id} (agent ${r.agent ?? r.agent_id})`).join(", ")} — partage de revenu à confirmer`);

  return { tab_label: tabLabel, params: { club, chip_value, rb_fraction, tax_fraction }, footer, cleared, cleared_club_line, rows, foreign_rows, recompute, checks, warnings };
}

// ── classeur ─────────────────────────────────────────────────────────────────

export type XpokerWorkbook = { source: "xlsx" | "csv"; tabs: { label: string; is_template: boolean; ws: XLSX.WorkSheet }[] };

/** Lit un XLSX (classeur complet ou onglet seul) ou un CSV natif (UTF-8). */
export function readXpokerWorkbook(buffer: Buffer, opts?: { templateTab?: string }): XpokerWorkbook {
  const isZip = buffer.length > 3 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  const source: "xlsx" | "csv" = isZip ? "xlsx" : "csv";
  // CSV : codepage 65001, le CSV natif de Google Sheets est en UTF-8 (libellés
  // chinois). Un BOM UTF-8 en tête fait dérailler la détection de `xlsx` (lu comme
  // de l'UTF-16, libellés illisibles) : on le retire nous-mêmes.
  const hasBom = !isZip && buffer.length > 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const wb = XLSX.read(hasBom ? buffer.subarray(3) : buffer, { type: "buffer", codepage: 65001, raw: false });
  const template = opts?.templateTab ?? XPOKER_DEFAULT_LABELS.templateTab;
  return {
    source,
    tabs: wb.SheetNames.map(label => ({ label, is_template: label === template, ws: wb.Sheets[label] })),
  };
}
