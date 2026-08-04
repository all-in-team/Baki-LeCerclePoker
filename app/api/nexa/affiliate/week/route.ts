// Lecture et écriture d'une semaine de report NEXA.
//
// GET  ?week_start=YYYY-MM-DD  → les lignes déjà enregistrées, pour pré-remplir
//                                la grille (on édite, on ne retape pas).
// PUT  { week_start, rows[], deletions[], overrides{} }
//                              → écriture via commitWeek, le chemin unique.
//
// Route fine : validation des paramètres, appel lib, réponse. Toute la logique
// (résolution, diff, garde anti-omission, transaction) est dans
// lib/funnels/nexa/affiliate-ingest.
import { NextRequest, NextResponse } from "next/server";
import { getWeekRows, commitWeek, isMondayISO } from "@/lib/funnels/nexa/affiliate-ingest";
import type { RawAffiliateRow } from "@/lib/funnels/nexa/affiliate-deal";

export async function GET(req: NextRequest) {
  try {
    const weekStart = req.nextUrl.searchParams.get("week_start") ?? "";
    if (!isMondayISO(weekStart)) {
      return NextResponse.json({ error: `Semaine « ${weekStart} » invalide — attendu un LUNDI (YYYY-MM-DD).` }, { status: 400 });
    }
    return NextResponse.json({ ok: true, week_start: weekStart, rows: getWeekRows(weekStart) });
  } catch (e: any) {
    console.error("[NEXA_AFFILIATE_WEEK_GET]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.rows)) {
      return NextResponse.json({ error: "Corps invalide : { week_start, rows[] } attendu." }, { status: 400 });
    }
    const weekStart = String(body.week_start ?? "");

    const result = commitWeek(weekStart, body.rows as RawAffiliateRow[], {
      source: "manual",
      actor: "baki",
      note: typeof body.note === "string" ? body.note : null,
      overrides: (body.overrides ?? {}) as Record<string, string>,
      deletions: (body.deletions ?? []) as string[],
    });

    // Un refus n'est PAS une erreur serveur : il porte le diff complet, que la
    // grille affiche telle quelle (orphelines nommées, lignes en erreur, etc.).
    if (!result.ok) {
      return NextResponse.json({ ok: false, reason: result.reason, error: result.message, diff: result.diff }, { status: 409 });
    }
    return NextResponse.json({ ok: true, entry_id: result.entry_id, written: result.written, diff: result.diff });
  } catch (e: any) {
    console.error("[NEXA_AFFILIATE_WEEK_PUT]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
