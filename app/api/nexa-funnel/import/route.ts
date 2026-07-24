// Import hebdo du report NEXAPOKER (export XLSX du back-office de la room).
// Parsing + règle « seuls les Member ID enregistrés sont retenus » : couche partagée
// (lib/funnels/xlsx-import.ts). Ce handler valide, persiste et promeut les leads.
//
// ⚠️ Tant que NEXA_COLUMN_MAP_READY est false (XLSX d'exemple pas encore fourni),
// l'import est refusé avec un message explicite : mieux vaut un refus clair qu'un
// import silencieusement faux sur des noms de colonnes devinés.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { parseWeeklyXlsx } from "@/lib/funnels/xlsx-import";
import { NEXA_COLUMN_MAP, NEXA_COLUMN_MAP_READY } from "@/lib/funnels/nexa/config";
import { applyNexaImportPromotions } from "@/lib/nexa-funnel";

export async function POST(req: NextRequest) {
  try {
    if (!NEXA_COLUMN_MAP_READY) {
      return NextResponse.json({
        error: "Mapping des colonnes NEXAPOKER pas encore câblé — dépose le XLSX d'exemple " +
          "et je renseigne NEXA_COLUMN_MAP (lib/funnels/nexa/config.ts).",
      }, { status: 400 });
    }

    const formData = await req.formData();
    const file = formData.get("file") as File | null;
    const weekStart = String(formData.get("week_start") ?? "").trim();

    if (!file) return NextResponse.json({ error: "Fichier manquant" }, { status: 400 });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return NextResponse.json({ error: "week_start invalide (attendu YYYY-MM-DD)" }, { status: 400 });
    }

    const db = getDb();
    const registered = new Set(
      (db.prepare(`SELECT member_id FROM nexa_leads WHERE member_id IS NOT NULL`).all() as { member_id: string }[])
        .map(r => r.member_id)
    );

    const bytes = await file.arrayBuffer();
    let parsed;
    try {
      parsed = parseWeeklyXlsx(Buffer.from(bytes), NEXA_COLUMN_MAP, registered);
    } catch (e: any) {
      return NextResponse.json({ error: e.message ?? String(e) }, { status: 400 });
    }

    // Un upload = une ligne d'historique ; les stats pointent dessus.
    const reportInfo = db.prepare(
      `INSERT INTO nexa_weekly_reports (week_start, filename, rows_read, matched_count) VALUES (?, ?, ?, ?)`
    ).run(weekStart, file.name ?? null, parsed.rows, parsed.matched);
    const reportId = Number(reportInfo.lastInsertRowid);

    // Ré-upload de la même semaine = correction (UNIQUE(week_start, member_id)).
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO nexa_weekly_stats
        (report_id, member_id, week_start, nickname, rake, deposits, withdrawals, winloss)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const tx = db.transaction(() => {
      for (const r of parsed.records) {
        upsert.run(reportId, r.member_id, weekStart, r.nickname, r.rake, r.deposits, r.withdrawals, r.winloss);
      }
    });
    tx();

    // Premier match d'un ID → room_verified (+ played si rake > 0) + message bot.
    const promo = await applyNexaImportPromotions(
      parsed.records.map(r => ({ member_id: r.member_id, rake: r.rake }))
    );

    return NextResponse.json({
      ok: true, week_start: weekStart,
      rows: parsed.rows, matched: parsed.matched, ignored: parsed.ignored,
      newly_verified: promo.newlyVerified, newly_played: promo.newlyPlayed,
    });
  } catch (e: any) {
    console.error("[NEXA_FUNNEL_IMPORT]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
