// Import hebdo du report QQPK (export XLSX du back-office de la room).
// Le parsing et la règle "seuls les Member ID enregistrés sont retenus" vivent
// dans lib/funnels/xlsx-import.ts (partagé avec les autres rooms) ; ce handler ne
// fait que la validation des paramètres et la persistance.
// Chaque import = les chiffres d'UNE semaine (week_start), accumulés via
// UNIQUE(member_id, week_start) + INSERT OR REPLACE (ré-upload = correction).
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { parseWeeklyXlsx } from "@/lib/funnels/xlsx-import";
import { QQPK_COLUMN_MAP } from "@/lib/funnels/qqpk/config";

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const weekStart = String(formData.get("week_start") ?? "").trim();

    if (!file) return NextResponse.json({ error: "Fichier manquant" }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return NextResponse.json({ error: "week_start invalide (attendu YYYY-MM-DD)" }, { status: 400 });
    }

    const db = getDb();
    const registered = new Set(
      (db.prepare(`SELECT qqpk_member_id FROM qqpk_funnel_leads WHERE qqpk_member_id IS NOT NULL`).all() as { qqpk_member_id: string }[])
        .map(r => r.qqpk_member_id)
    );

    const bytes = await file.arrayBuffer();
    let parsed;
    try {
      parsed = parseWeeklyXlsx(Buffer.from(bytes), QQPK_COLUMN_MAP, registered);
    } catch (e: any) {
      // Classeur vide / colonne Member ID absente → erreur utilisateur, pas 500.
      return NextResponse.json({ error: e.message ?? String(e) }, { status: 400 });
    }

    const upsert = db.prepare(`
      INSERT OR REPLACE INTO qqpk_funnel_reports
        (member_id, week_start, nickname, rake, deposits, withdrawals, winloss, insurance, rewards)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction(() => {
      for (const r of parsed.records) {
        upsert.run(r.member_id, weekStart, r.nickname, r.rake, r.deposits, r.withdrawals, r.winloss, r.insurance, r.rewards);
      }
    });
    tx();

    return NextResponse.json({
      ok: true, week_start: weekStart,
      rows: parsed.rows, matched: parsed.matched, ignored: parsed.ignored,
      matched_ids: parsed.matchedIds,
    });
  } catch (e: any) {
    console.error("[QQPK_FUNNEL_IMPORT]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
