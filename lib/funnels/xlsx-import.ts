// Parsing des reports hebdo XLSX des rooms — SERVEUR UNIQUEMENT (dépend de `xlsx`).
//
// RÈGLE COMMUNE À TOUS LES FUNNELS : seules les lignes dont le Member ID est
// enregistré par un lead du funnel sont retenues. Le back-office d'une room
// contient des centaines de joueurs legacy hors funnel — ils sont ignorés
// (Hugo : "je veux pas avoir 250 mecs alors que seulement 10 sont dans le funnel").
//
// Chaque room décrit ses en-têtes via un WeeklyColumnMap : c'est la SEULE chose
// spécifique à la room. Aucun nom de colonne n'est deviné ici.
import * as XLSX from "xlsx";

/** En-têtes de colonnes du report d'une room. Seul `memberId` est obligatoire. */
export type WeeklyColumnMap = {
  memberId: string;
  nickname?: string;
  rake?: string;
  deposits?: string;
  withdrawals?: string;
  winloss?: string;
  insurance?: string;
  rewards?: string;
};

export type ParsedWeeklyRow = {
  member_id: string;
  nickname: string | null;
  rake: number;
  deposits: number;
  withdrawals: number;
  winloss: number;
  insurance: number;
  rewards: number;
};

export type ParsedWeeklyReport = {
  /** Lignes joueur lues (Member ID numérique), hors en-tête/totaux/vides. */
  rows: number;
  /** Lignes retenues = Member ID enregistré par un lead. */
  matched: number;
  /** Lignes ignorées = joueurs hors funnel. */
  ignored: number;
  records: ParsedWeeklyRow[];
  matchedIds: string[];
};

/** Les montants du back-office arrivent parfois en string ("1,234.56"). */
function num(v: any): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return isFinite(n) ? n : 0;
}

/**
 * Parse un classeur de report hebdo et ne retient que les Member ID enregistrés.
 * Jette une Error explicite si le fichier est vide ou si la colonne Member ID est
 * absente (mauvais fichier) — l'appelant la transforme en réponse 400.
 */
export function parseWeeklyXlsx(
  buffer: Buffer,
  map: WeeklyColumnMap,
  registeredIds: Set<string>,
): ParsedWeeklyReport {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error("Classeur vide");

  const grid = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: "" });

  // L'en-tête n'est pas forcément en ligne 1 → on cherche la ligne qui porte la
  // colonne Member ID de la room.
  const headerIdx = grid.findIndex(row => row.some((c: any) => String(c).trim() === map.memberId));
  if (headerIdx === -1) {
    throw new Error(`Colonne "${map.memberId}" introuvable — mauvais fichier ?`);
  }
  const header = grid[headerIdx].map((c: any) => String(c).trim());
  const idx = (label?: string) => (label ? header.indexOf(label) : -1);

  const iMember = idx(map.memberId);
  const iNick = idx(map.nickname);
  const iRake = idx(map.rake);
  const iDeposit = idx(map.deposits);
  const iWithdraw = idx(map.withdrawals);
  const iWinloss = idx(map.winloss);
  const iInsurance = idx(map.insurance);
  const iRewards = idx(map.rewards);

  let rows = 0, matched = 0, ignored = 0;
  const records: ParsedWeeklyRow[] = [];
  const matchedIds: string[] = [];

  for (let r = headerIdx + 1; r < grid.length; r++) {
    const row = grid[r];
    const memberId = String(row[iMember] ?? "").trim();
    if (!/^\d+$/.test(memberId)) continue; // ligne vide / totaux / footer
    rows++;

    if (!registeredIds.has(memberId)) { ignored++; continue; }

    records.push({
      member_id: memberId,
      nickname: iNick >= 0 ? (String(row[iNick] ?? "").trim() || null) : null,
      rake: iRake >= 0 ? num(row[iRake]) : 0,
      deposits: iDeposit >= 0 ? num(row[iDeposit]) : 0,
      withdrawals: iWithdraw >= 0 ? num(row[iWithdraw]) : 0,
      winloss: iWinloss >= 0 ? num(row[iWinloss]) : 0,
      insurance: iInsurance >= 0 ? num(row[iInsurance]) : 0,
      rewards: iRewards >= 0 ? num(row[iRewards]) : 0,
    });
    matched++;
    matchedIds.push(memberId);
  }

  return { rows, matched, ignored, records, matchedIds };
}
