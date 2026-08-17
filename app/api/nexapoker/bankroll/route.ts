// Règlement hebdomadaire sur bankroll — NEXAPOKER.
//
// GET    → aperçu de la semaine à clôturer + historique des semaines figées.
// POST   → verrouille la semaine (une transaction : versement, règlement, provenance, win/loss).
// DELETE → déverrouille la DERNIÈRE semaine figée, pour corriger une BR mal saisie.
//
// Route fine (invariant #2) : validation de paramètres, appel lib, réponse.
// AUCUNE math ici. Le corps du POST porte une BR de fin, jamais un montant : le
// résultat, ma part et le versement sont recalculés dans la transaction de lock,
// sur les mouvements lus à ce moment-là. Ce que l'écran affichait a pu être
// calculé avant l'ajout d'un buy-in. Même doctrine que /api/nexapoker/settle-action.
import { NextRequest, NextResponse } from "next/server";
import {
  previewBankrollWeek, lockBankrollWeek, unlockBankrollWeek, getBankrollWeeks,
} from "@/lib/funnels/nexa/bankroll";

/** Aujourd'hui en UTC — le même calendrier que les lundis de semaine partout ailleurs. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** `null` si le paramètre est absent ; `undefined` s'il est présent mais illisible. */
function numParam(raw: string | null): number | null | undefined {
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams;
    const playerId = Number(q.get("player_id"));
    if (!Number.isInteger(playerId) || playerId <= 0) {
      return NextResponse.json({ error: "player_id manquant ou invalide." }, { status: 400 });
    }
    const history = getBankrollWeeks(playerId);

    const week = q.get("week_start");
    if (!week) return NextResponse.json({ ok: true, history, preview: null });

    const brClose = numParam(q.get("br_close"));
    const brOpen = numParam(q.get("br_open"));
    if (brClose === undefined || brOpen === undefined) {
      return NextResponse.json({ error: "br_close / br_open illisibles." }, { status: 400 });
    }

    const r = previewBankrollWeek({
      player_id: playerId, week_start: week, br_close: brClose, br_open_manual: brOpen, today: today(),
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 400 });
    return NextResponse.json({ ok: true, history, preview: r.preview });
  } catch (e: any) {
    console.error("[NEXAPOKER_BANKROLL_GET]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const b = await req.json().catch(() => null);
    if (!b || typeof b.player_id !== "number" || typeof b.week_start !== "string"
        || typeof b.br_close !== "number") {
      return NextResponse.json(
        { error: "Corps invalide : { player_id, week_start, br_close, br_open?, note? } attendu." },
        { status: 400 },
      );
    }
    const r = lockBankrollWeek({
      player_id: b.player_id,
      week_start: b.week_start,
      br_close: b.br_close,
      br_open_manual: typeof b.br_open === "number" ? b.br_open : null,
      note: b.note ?? null,
      today: today(),
    });
    // 409 et non 400 : le refus porte sur l'ÉTAT (semaine déjà figée, trou de
    // semaines, part d'action absente), pas sur la forme du corps. L'écran doit
    // pouvoir afficher le message tel quel — il dit quoi faire.
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    // `...r` porte déjà `ok: true` — le réécrire après l'écraserait avec la même
    // valeur, mais TS a raison de le signaler : c'est le genre de duplication qui
    // devient un bug le jour où l'une des deux change.
    return NextResponse.json(r);
  } catch (e: any) {
    console.error("[NEXAPOKER_BANKROLL_POST]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const q = req.nextUrl.searchParams;
    const playerId = Number(q.get("player_id"));
    const week = q.get("week_start") ?? "";
    if (!Number.isInteger(playerId) || playerId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return NextResponse.json({ error: "player_id et week_start (YYYY-MM-DD) requis." }, { status: 400 });
    }
    const r = unlockBankrollWeek(playerId, week);
    if (!r.ok) return NextResponse.json({ ok: false, error: r.error }, { status: 409 });
    return NextResponse.json({ ok: true, week_start: r.week_start });
  } catch (e: any) {
    console.error("[NEXAPOKER_BANKROLL_DELETE]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
