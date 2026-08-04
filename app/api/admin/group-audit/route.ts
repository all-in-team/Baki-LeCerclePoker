import { NextRequest, NextResponse } from "next/server";
import { auditGroup, deleteChannelAsOwner } from "@/lib/telegram-userbot";

/**
 * Audit de groupes via le userbot — activité, owner, droits. LECTURE SEULE par défaut.
 *
 * Sert à l'arbitrage des doublons : décider quel groupe garder demande de voir lequel vit
 * (qui parle, quand) et qui en est owner. Rien dans le back-office ne lisait ça.
 *
 * POST { chat_ids: [-100…], limit?: 50 }              → audit
 * POST { action: "delete", chat_id: -100…, confirm: "<chat_id>" } → suppression
 *
 * La suppression est irréversible et n'est PAS un effet de bord d'un audit : elle exige
 * une action explicite, un `confirm` qui répète le chat_id, et échoue si le userbot n'est
 * pas créateur du groupe.
 */
export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== token) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({} as any));

  if (body.action === "delete") {
    const chatId = body.chat_id;
    if (chatId == null) return NextResponse.json({ error: "chat_id required" }, { status: 400 });
    // Le confirm doit répéter le chat_id : une suppression ne part jamais d'un payload
    // recopié à la va-vite sur le mauvais groupe.
    if (String(body.confirm ?? "") !== String(chatId)) {
      return NextResponse.json({ error: "confirm must repeat chat_id" }, { status: 400 });
    }
    const res = await deleteChannelAsOwner(chatId);
    return NextResponse.json(res, { status: res.ok ? 200 : 409 });
  }

  const chatIds: (string | number)[] = body.chat_ids ?? (body.chat_id != null ? [body.chat_id] : []);
  if (!chatIds.length) return NextResponse.json({ error: "chat_ids required" }, { status: 400 });

  const limit = Math.min(Number(body.limit ?? 50), 200);
  const out = [];
  for (const cid of chatIds) {
    out.push(await auditGroup(cid, limit));
  }
  return NextResponse.json({ ok: true, audits: out });
}
