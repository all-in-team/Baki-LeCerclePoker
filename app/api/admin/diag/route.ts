export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST(req: NextRequest) {
  const token = process.env.ADMIN_RECONCILE_TOKEN;
  if (!token || req.headers.get("x-admin-token") !== token)
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const db = getDb();
  const result: Record<string, any> = {};

  result["1_players_broad"] = db.prepare(`
    SELECT id, name, telegram_handle, telegram_id, telegram_chat_id, telegram_group_id, status
    FROM players
    WHERE LOWER(name) LIKE '%geo%' OR LOWER(name) LIKE '%paab%' OR LOWER(name) LIKE '%pabz%'
       OR LOWER(COALESCE(telegram_handle,'')) LIKE '%geo%'
       OR LOWER(COALESCE(telegram_handle,'')) LIKE '%paab%'
  `).all();

  try {
    result["2_onboarding_leads_all"] = db.prepare(`SELECT * FROM onboarding_leads`).all();
  } catch (e: any) { result["2_onboarding_leads_all"] = e.message; }

  try {
    result["3_sessions_for_groups"] = db.prepare(`
      SELECT * FROM telegram_sessions
      WHERE chat_id IN ('-1003905481160','-1003910811338','-1003864176417')
    `).all();
  } catch (e: any) { result["3_sessions_for_groups"] = e.message; }

  try {
    result["4_tg_messages_from_groups"] = db.prepare(`
      SELECT * FROM tg_messages
      WHERE tg_chat_id IN ('-1003905481160','-1003910811338','-1003864176417')
      ORDER BY msg_date DESC LIMIT 20
    `).all();
  } catch (e: any) { result["4_tg_messages_from_groups"] = e.message; }

  try {
    result["5_crm_notes_geo_paab"] = db.prepare(`
      SELECT * FROM crm_notes
      WHERE LOWER(content) LIKE '%geo%' OR LOWER(content) LIKE '%paab%'
      ORDER BY created_at DESC LIMIT 10
    `).all();
  } catch (e: any) { result["5_crm_notes_geo_paab"] = e.message; }

  try {
    result["6_agent_convos_geo_paab"] = db.prepare(`
      SELECT id, chat_id, role, SUBSTR(content, 1, 300) as preview, created_at
      FROM agent_conversations
      WHERE LOWER(content) LIKE '%geo%' OR LOWER(content) LIKE '%paab%'
      ORDER BY created_at DESC LIMIT 10
    `).all();
  } catch (e: any) { result["6_agent_convos_geo_paab"] = e.message; }

  result["7_all_players"] = db.prepare(`
    SELECT id, name, telegram_handle, telegram_id FROM players ORDER BY name
  `).all();

  return NextResponse.json(result);
}
