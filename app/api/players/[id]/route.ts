import { NextRequest, NextResponse } from "next/server";
import { updatePlayer, assertUpdatablePlayerFields } from "@/lib/queries";
import { archivePlayers, unarchivePlayer, deletePlayerChecked } from "@/lib/players-archive";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json();

  // `archived` est traité à part : c'est l'archive (colonne dédiée), pas un champ libre de
  // `players` — il ne doit pas transiter par le SET d'updatePlayer. Archiver est toujours
  // permis (règle Baki) : un joueur à régler passe en tête d'« Archivés », rien ne s'efface.
  const { archived, archive_reason, ...fields } = body ?? {};
  try {
    // Champs vérifiés AVANT toute écriture : un champ refusé ne doit pas laisser un
    // archivage déjà écrit derrière lui.
    if (Object.keys(fields).length > 0) assertUpdatablePlayerFields(Object.keys(fields));
    if (archived === true) archivePlayers([Number(id)], archive_reason ?? "retiré à la main");
    else if (archived === false) unarchivePlayer(Number(id));
    if (Object.keys(fields).length > 0) updatePlayer(Number(id), fields);
  } catch (e: any) {
    if (/non modifiable/.test(e?.message ?? "")) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }

  return NextResponse.json({ ok: true });
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    deletePlayerChecked(Number(id));
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    // Money-history guard or FK failure — surface the reason instead of a silent 500
    // (the CRM used to swallow it and the player "reappeared" on refresh).
    return NextResponse.json({ error: e.message }, { status: 409 });
  }
}
