// Panneau conversation du back-office — lecture de l'historique et envoi d'une réponse.
//
// La réponse passe par replyToLead(), EXACTEMENT la même fonction que la réponse
// depuis Telegram : même envoi, même journalisation, même effet sur takeover_until
// (§5 du brief). Aucune logique d'envoi ne vit ici.
//
// Protégé par le middleware de session comme le reste du back-office (le matcher
// n'exclut que /api/telegram, /api/cron, /api/portal…).
import { NextRequest, NextResponse } from "next/server";
import {
  getConversation, markConversationRead, replyToLead, getLeadById, isTakeoverActive,
} from "@/lib/funnels/live-takeover";

function parseLeadId(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** GET ?lead_id=123 — historique complet. Ouvrir le panneau vaut « lu ». */
export async function GET(req: NextRequest) {
  const leadId = parseLeadId(req.nextUrl.searchParams.get("lead_id"));
  if (!leadId) return NextResponse.json({ error: "lead_id manquant ou invalide" }, { status: 400 });

  const lead = getLeadById(leadId);
  if (!lead) return NextResponse.json({ error: "Lead introuvable" }, { status: 404 });

  const messages = getConversation(leadId);
  // Marqué lu APRÈS lecture : la pastille du tableau s'éteint à l'ouverture du panneau.
  if (req.nextUrl.searchParams.get("read") !== "0") markConversationRead(leadId);

  return NextResponse.json({
    lead: {
      id: lead.id, label: lead.tg_username ? `@${lead.tg_username}` : (lead.first_name ?? `tg:${lead.tg_user_id}`),
      stage: lead.stage, source: lead.source, member_id: lead.member_id,
      blocked: lead.blocked, takeover_until: lead.takeover_until,
      takeover_active: isTakeoverActive(lead), takeover_by: lead.takeover_by,
    },
    messages,
  });
}

/** POST { lead_id, text } — réponse envoyée au lead sous l'identité du bot. */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON invalide" }, { status: 400 }); }

  const leadId = parseLeadId(String(body?.lead_id ?? ""));
  if (!leadId) return NextResponse.json({ error: "lead_id manquant ou invalide" }, { status: 400 });

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "Message vide" }, { status: 400 });

  const res = await replyToLead({ leadId, operator: "dashboard", text });
  if (!res.ok) return NextResponse.json({ error: res.error ?? "Envoi impossible" }, { status: 502 });

  markConversationRead(leadId);
  return NextResponse.json({ ok: true, messages: getConversation(leadId) });
}
