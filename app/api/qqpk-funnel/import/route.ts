// Import hebdo du report QQPK (export XLSX du back-office de la room).
// RÈGLE CRITIQUE : seules les lignes dont Member ID = ID enregistré par un lead du
// funnel sont importées. Le back-office contient ~250 joueurs legacy hors funnel —
// ils sont IGNORÉS (Hugo : "je veux pas avoir 250 mecs alors que seulement 10 sont
// dans le funnel"). Chaque import = les chiffres d'UNE semaine (week_start), accumulés
// via UNIQUE(member_id, week_start) + INSERT OR REPLACE (ré-upload = correction).
import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getDb } from "@/lib/db";

// Valeurs numériques du back-office : parfois "1,234.56" en string.
function num(v: any): number {
  if (typeof v === "number") return isFinite(v) ? v : 0;
  if (v == null) return 0;
  const n = parseFloat(String(v).replace(/,/g, "").trim());
  return isFinite(n) ? n : 0;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const weekStart = String(formData.get("week_start") ?? "").trim();

    if (!file) return NextResponse.json({ error: "Fichier manquant" }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return NextResponse.json({ error: "week_start invalide (attendu YYYY-MM-DD)" }, { status: 400 });
    }

    const bytes = await file.arrayBuffer();
    const wb = XLSX.read(Buffer.from(bytes), { type: "buffer" });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return NextResponse.json({ error: "Classeur vide" }, { status: 400 });

    const grid = XLSX.utils.sheet_to_json<any[]>(sheet, { header: 1, defval: "" });

    // Le header n'est pas forcément en ligne 1 → on cherche la ligne contenant "Member ID".
    const headerIdx = grid.findIndex(row => row.some((c: any) => String(c).trim() === "Member ID"));
    if (headerIdx === -1) {
      return NextResponse.json({ error: `Colonne "Member ID" introuvable — mauvais fichier ?` }, { status: 400 });
    }
    const header = grid[headerIdx].map((c: any) => String(c).trim());
    const col = (name: string) => header.indexOf(name);

    const iMember = col("Member ID");
    const iNick = col("Member nickname");
    const iDeposit = col("Deposit Amount");
    const iWithdraw = col("Withdrawal Amount");
    const iRake = col("Rake (Cash Game)");
    const iInsurance = col("Insurance");
    const iWinloss = col("Win/Loss (Cash Game)");
    const iRewards = col("Total Rewards");

    const db = getDb();
    const registered = new Set(
      (db.prepare(`SELECT qqpk_member_id FROM qqpk_funnel_leads WHERE qqpk_member_id IS NOT NULL`).all() as { qqpk_member_id: string }[])
        .map(r => r.qqpk_member_id)
    );

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO qqpk_funnel_reports
        (member_id, week_start, nickname, rake, deposits, withdrawals, winloss, insurance, rewards)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let rows = 0, matched = 0, ignored = 0;
    const matchedIds: string[] = [];

    const tx = db.transaction(() => {
      for (let r = headerIdx + 1; r < grid.length; r++) {
        const row = grid[r];
        const memberId = String(row[iMember] ?? "").trim();
        if (!/^\d+$/.test(memberId)) continue; // ligne vide / totaux / footer
        rows++;

        if (!registered.has(memberId)) { ignored++; continue; }

        upsert.run(
          memberId,
          weekStart,
          iNick >= 0 ? String(row[iNick] ?? "").trim() || null : null,
          iRake >= 0 ? num(row[iRake]) : 0,
          iDeposit >= 0 ? num(row[iDeposit]) : 0,
          iWithdraw >= 0 ? num(row[iWithdraw]) : 0,
          iWinloss >= 0 ? num(row[iWinloss]) : 0,
          iInsurance >= 0 ? num(row[iInsurance]) : 0,
          iRewards >= 0 ? num(row[iRewards]) : 0,
        );
        matched++;
        matchedIds.push(memberId);
      }
    });
    tx();

    return NextResponse.json({ ok: true, week_start: weekStart, rows, matched, ignored, matched_ids: matchedIds });
  } catch (e: any) {
    console.error("[QQPK_FUNNEL_IMPORT]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
