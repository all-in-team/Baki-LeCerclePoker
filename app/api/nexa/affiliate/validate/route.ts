// Contrôle à blanc d'une saisie — AUCUNE ÉCRITURE.
//
// Appelée à la frappe (débouncée) par la grille pour colorer les lignes. Le
// contrôle tourne ICI et pas dans le navigateur : invariant #2, aucune math
// d'argent côté client. C'est aussi ce qui garantit qu'il n'existe qu'une seule
// implémentation du recalcul — celle de validateRow, partagée avec l'écriture.
//
// Route fine : validation des paramètres, appel lib, réponse. Rien d'autre.
import { NextRequest, NextResponse } from "next/server";
import { previewWeek, resolveRows, isMondayISO } from "@/lib/funnels/nexa/affiliate-ingest";
import type { RawAffiliateRow } from "@/lib/funnels/nexa/affiliate-deal";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null);
    if (!body || !Array.isArray(body.rows)) {
      return NextResponse.json({ error: "Corps invalide : { week_start, rows[] } attendu." }, { status: 400 });
    }
    const weekStart = String(body.week_start ?? "");
    if (!isMondayISO(weekStart)) {
      return NextResponse.json({ error: `Semaine « ${weekStart} » invalide — attendu un LUNDI (YYYY-MM-DD).` }, { status: 400 });
    }

    const rows = body.rows as RawAffiliateRow[];
    const opts = {
      overrides: (body.overrides ?? {}) as Record<string, string>,
      deletions: (body.deletions ?? []) as string[],
    };

    const resolved = resolveRows(rows);
    const diff = previewWeek(weekStart, rows, opts);

    return NextResponse.json({
      ok: true,
      week_start: weekStart,
      // Un verdict par ligne, dans l'ordre de la grille : la ligne i de la
      // réponse correspond à la ligne i de la saisie.
      rows: resolved.map(r => ({
        row_key: r.row_key,
        nickname_key: r.nickname_key,
        player_id: r.player_id,
        resolved_by: r.resolved_by,
        hint: r.hint,
        verdict: r.verdict,
      })),
      diff,
    });
  } catch (e: any) {
    console.error("[NEXA_AFFILIATE_VALIDATE]", e);
    return NextResponse.json({ error: e.message ?? String(e) }, { status: 500 });
  }
}
