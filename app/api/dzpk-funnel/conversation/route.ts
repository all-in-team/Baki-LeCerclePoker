// Panneau conversation du back-office dzpk — historique et réponse.
//
// Calque de `app/api/nexa-funnel/conversation/route.ts`, avec ce qui n'a pas
// d'équivalent ici en moins : pas de `takeover_until` à exposer, pas de lien vers
// un sujet Telegram (le relais vers un chat admin n'existe pas encore).
//
// Toute la logique d'envoi vit dans `replyToLead` — le handler reste mince
// (invariant #2 : les routes valident et délèguent).
//
// Protégé par le middleware de session comme le reste du back-office : le matcher
// n'exclut que /api/telegram, /api/cron, /api/admin…
import { NextRequest, NextResponse } from "next/server";
import {
  getConversation, markConversationRead, replyToLead, getConversationHead,
} from "@/lib/funnels/dzpk/takeover";

export const dynamic = "force-dynamic";

function parseLeadId(raw: string | null): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** GET ?lead_id=123 — le fil complet. Ouvrir le panneau vaut « lu ». */
export async function GET(req: NextRequest) {
  const leadId = parseLeadId(req.nextUrl.searchParams.get("lead_id"));
  if (!leadId) return NextResponse.json({ error: "lead_id manquant ou invalide" }, { status: 400 });

  const head = getConversationHead(leadId);
  if (!head) return NextResponse.json({ error: "Lead introuvable" }, { status: 404 });

  const messages = getConversation(leadId);
  // Marqué lu APRÈS la lecture : la pastille s'éteint à l'ouverture du panneau.
  if (req.nextUrl.searchParams.get("read") !== "0") markConversationRead(leadId);

  return NextResponse.json({ lead: head, messages });
}

/** POST { lead_id, text } — la réponse part au lead sous l'identité du bot. */
export async function POST(req: NextRequest) {
  let body: any;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "JSON invalide" }, { status: 400 }); }

  const leadId = parseLeadId(String(body?.lead_id ?? ""));
  if (!leadId) return NextResponse.json({ error: "lead_id manquant ou invalide" }, { status: 400 });

  const text = typeof body?.text === "string" ? body.text.trim() : "";
  if (!text) return NextResponse.json({ error: "Message vide" }, { status: 400 });

  const res = await replyToLead({ leadId, operator: String(body?.operator ?? "baki"), text });
  // 502 : l'échec vient de Telegram, pas de la requête. Le distinguer d'un 400
  // évite de faire chercher une faute de saisie là où il n'y en a pas.
  if (!res.ok) return NextResponse.json({ error: res.error ?? "Envoi impossible" }, { status: 502 });

  markConversationRead(leadId);
  return NextResponse.json({ ok: true, messages: getConversation(leadId) });
}
