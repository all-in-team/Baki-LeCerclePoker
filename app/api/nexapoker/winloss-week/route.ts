// Grille de saisie hebdomadaire des win/loss — LECTURE SEULE.
//
// Rend, pour UNE semaine, la liste des joueurs stakés (part d'action > 0) avec le
// montant déjà saisi s'il existe. L'écriture, elle, passe par la route existante
// /api/nexapoker/winloss, joueur par joueur : aucune logique d'écriture n'est
// dupliquée ici.
//
// `amount: null` ≠ `amount: 0`. Une clé absente de la table veut dire « pas encore
// saisi », et le moteur refuse de calculer une part d'action dessus. Renvoyer 0 à
// la place ferait apparaître la grille comme remplie et produirait des parts
// d'action fondées sur une saisie qui n'a jamais eu lieu.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getNexaPlayersOn, getWinlossForWeekOn } from "@/lib/funnels/nexa/players";

export async function GET(req: NextRequest) {
  try {
    const week = req.nextUrl.searchParams.get("week_start") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(week)) {
      return NextResponse.json({ error: "week_start (YYYY-MM-DD) requis." }, { status: 400 });
    }
    const db = getDb();
    const saved = getWinlossForWeekOn(db, week);
    // getNexaPlayersOn dédoublonne déjà par player_id (cf. son commentaire) : la
    // grille ne peut pas afficher deux fois le même joueur.
    const rows = getNexaPlayersOn(db).map(p => ({
      player_id: p.player_id,
      name: p.name,
      action_pct: p.action_pct,
      amount: saved.has(p.player_id) ? saved.get(p.player_id)! : null,
    }));
    return NextResponse.json({ ok: true, week_start: week, players: rows });
  } catch (e: any) {
    console.error("[NEXAPOKER_WINLOSS_WEEK]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
