// Fixture XPoker Twd — reproduit la DISPOSITION observée du sheet du club (pas le
// fichier), paramétrable : décalage du bloc, taux en texte, blocs voisins, libellé
// retiré, 總交收 divergent. Partagée par scripts/xpoker-parse.test.ts et
// scripts/xpoker-e2e.test.ts. Aucune lecture du classeur réel ici.
import * as XLSX from "xlsx";
import { parseXpokerTab, type XpokerParseOptions, type XpokerParsedBlock } from "../lib/games/xpoker/parse-sheet";

export type FixRow = { id?: string; pid: string; nick?: string; agent?: string; agentId?: string; sagentId?: string; wl: number | ""; rake: number | "" };
export type FixOpts = {
  club?: string; chip?: number; rb?: number; taxParam?: number; taxFormula?: number;
  rows: FixRow[]; dc?: number; dr?: number; asText?: boolean; clearedFrom?: "total" | "rb";
  otherBlocks?: boolean; dropLabel?: string; clubHeader?: string;
};

export function buildAoa(o: FixOpts): unknown[][] {
  const club = o.club ?? "花順", chip = o.chip ?? 1, rb = o.rb ?? 0.8, taxParam = o.taxParam ?? 0.05, taxF = o.taxFormula ?? 0.05;
  const dc = o.dc ?? 0, dr = o.dr ?? 0;
  const pct = (x: number) => o.asText ? `${Math.round(x * 100)}%` : x;
  const g: unknown[][] = [];
  const set = (r: number, c: number, v: unknown) => { (g[r + dr] ??= [])[c + dc] = v; };
  const L = (s: string) => s === o.dropLabel ? "" : s;
  // paramètres B1:D1 / A2:D2
  set(0, 1, L("幣值")); set(0, 2, L("反水")); set(0, 3, L("TAX"));
  set(1, 0, club); set(1, 1, chip); set(1, 2, pct(rb)); set(1, 3, pct(taxParam));
  // en-tête grille Q2:Z2 (T sans en-tête)
  const Q = 16;
  set(1, Q, o.clubHeader ?? club); set(1, Q + 1, L("ID")); set(1, Q + 2, L("Player ID")); set(1, Q + 4, L("Agent"));
  set(1, Q + 5, L("Agent ID")); set(1, Q + 6, L("Super Agent")); set(1, Q + 7, L("Super Agent ID")); set(1, Q + 8, L("Win/Lose")); set(1, Q + 9, L("Rake(without MTT)"));
  // lignes 3.. (grille à hauteur fixe : on laisse des trous)
  o.rows.forEach((r, i) => {
    const rr = 2 + i;
    set(rr, Q + 1, r.id ?? r.nick ?? `XP${r.pid}`); set(rr, Q + 2, Number(r.pid)); set(rr, Q + 3, r.nick ?? `XP${r.pid}`);
    set(rr, Q + 4, r.agent ?? "LeCercleAdmin2"); set(rr, Q + 5, Number(r.agentId ?? "3970004"));
    set(rr, Q + 6, "LeCercleAdmin2"); set(rr, Q + 7, Number(r.sagentId ?? "3970004"));
    set(rr, Q + 8, r.wl); set(rr, Q + 9, r.rake);
  });
  // totaux calculés comme la feuille (sur TOUTES les lignes du bloc)
  const num = o.rows.filter(r => r.wl !== "" && r.rake !== "");
  const twl = num.reduce((s, r) => s + (r.wl as number), 0), trake = num.reduce((s, r) => s + (r.rake as number), 0);
  const tax = (twl + trake) * -taxF, rbAmt = trake * rb, total = rbAmt + tax;
  // bloc de règlement A10/A11/A20
  set(9, 1, "交收"); set(10, 0, club); set(10, 1, o.clearedFrom === "rb" ? rbAmt : total);
  set(19, 0, L("總交收")); set(19, 1, o.clearedFrom === "rb" ? rbAmt : total);
  // pied T18:U22
  const T = Q + 3;
  set(17, T, L("Total Win/Lose")); set(17, T + 1, twl);
  set(18, T, L("Total Rake")); set(18, T + 1, trake);
  set(19, T, L("TAX")); set(19, T + 1, tax);
  set(20, T, pct(rb)); set(20, T + 1, rbAmt);
  set(21, T, L("Total")); set(21, T + 1, total);
  if (o.otherBlocks) {
    // blocs d'autres clubs, vides, avec leurs propres 總交收 et taux — comme dans le classeur
    set(16, 30, "總輸贏"); set(16, 31, 0); set(17, 30, "總服務費"); set(17, 31, 0); set(19, 30, "總交收"); set(19, 31, 0);
    set(45, 50, "總輸贏"); set(45, 51, 0); set(47, 50, 0.6); set(48, 50, "總交收"); set(48, 51, 0);
    set(81, 10, "總輸贏"); set(81, 11, 0); set(83, 10, 0.65); set(84, 10, "總交收"); set(84, 11, 0);
  }
  // normaliser (aoa_to_sheet veut des tableaux denses)
  const maxC = Math.max(...g.filter(Boolean).map(r => r.length));
  for (let r = 0; r < g.length; r++) { g[r] ??= []; for (let c = 0; c < maxC; c++) if (g[r][c] === undefined) g[r][c] = null; }
  return g;
}
export const sheet = (o: FixOpts) => XLSX.utils.aoa_to_sheet(buildAoa(o) as any[][]);


export const OPTS: XpokerParseOptions = { agentId: "3970004", clubName: "花順", agencyMemberIds: new Set(["3970004", "3999050"]) };

export const CAS1: FixRow[] = [{ id: "冲浪者", pid: "3062825", nick: "Carolina", wl: -136.2, rake: 256.43 }];
export const CAS2: FixRow[] = [
  { id: "冲浪者", pid: "3062825", nick: "Carolina", wl: -31267.4, rake: 4647.88 },
  { pid: "4136708", wl: -11722.87, rake: 2731.06 },
  { id: "jsuisAll-in", pid: "4107823", nick: "jsuisAll-in", wl: 14053.56, rake: 2845.38 },
];

/** Bloc parsé prêt pour le moteur. */
export const block = (o: FixOpts, tab = "x", opts: XpokerParseOptions = OPTS): XpokerParsedBlock => parseXpokerTab(sheet(o), tab, opts);
