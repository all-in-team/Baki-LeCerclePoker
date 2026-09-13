// XPoker Twd — import hebdo : POST multipart { file, action: 'preview' | 'commit', … }.
// Route fine (invariant #2) : lecture du fichier, appel lib, réponse. Le parseur et
// le moteur (checksum, taux figé, résolution par Player ID) sont dans lib/games/xpoker.
//
//   preview : aperçu de tous les onglets, ZÉRO écriture (plages proposées, à confirmer).
//   commit  : UN onglet (tab_label) avec week_start / week_end CONFIRMÉS, override_reason
//             obligatoire si le checksum est KO. Le fichier est reparsé côté serveur.
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { previewWorkbookOn, commitTabOn } from "@/lib/games/xpoker/import";

const MAX_BYTES = 8 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const fd = await req.formData().catch(() => null);
  const file = fd?.get("file") as File | null;
  if (!fd || !file) return NextResponse.json({ error: "fichier requis (champ « file », XLSX ou CSV)" }, { status: 400 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: "fichier trop volumineux (max 8 Mo)" }, { status: 413 });
  const buffer = Buffer.from(await file.arrayBuffer());
  const action = String(fd.get("action") ?? "preview");
  const db = getDb();
  try {
    if (action === "preview") {
      const year = Number(fd.get("year")) || undefined;
      return NextResponse.json({ ok: true, preview: previewWorkbookOn(db, buffer, file.name ?? null, year) });
    }
    if (action === "commit") {
      const tab_label = String(fd.get("tab_label") ?? ""), week_start = String(fd.get("week_start") ?? ""), week_end = String(fd.get("week_end") ?? "");
      if (!tab_label || !week_start || !week_end) return NextResponse.json({ error: "tab_label, week_start, week_end requis" }, { status: 400 });
      const r = commitTabOn(db, buffer, {
        tab_label, week_start, week_end,
        override_reason: (fd.get("override_reason") as string | null) || null,
        note: (fd.get("note") as string | null) || null,
        filename: file.name ?? null,
      });
      if (!r.ok) return NextResponse.json({ ok: false, error: r.error, warnings: r.warnings ?? [] }, { status: 409 });
      return NextResponse.json(r);
    }
    return NextResponse.json({ error: `action inconnue : ${action}` }, { status: 400 });
  } catch (e: any) {
    console.error("[XPOKER_IMPORT]", e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
