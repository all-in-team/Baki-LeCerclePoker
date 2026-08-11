import { NextRequest, NextResponse } from "next/server";
import { dzpkBotToken } from "@/lib/funnels/dzpk/config";

/**
 * Enregistrement du webhook du bot dzpk + diagnostic.
 *
 * ⚠️ Hors middleware d'auth (le matcher exclut `api/telegram`) : la route se
 * protège donc elle-même, même convention que les routes api/admin — header
 * `x-admin-token`, fail-closed si la variable manque. Sans ce garde, n'importe
 * qui pourrait détourner le webhook du bot vers son propre serveur.
 */
function guard(req: NextRequest): NextResponse | null {
  const adminToken = process.env.ADMIN_RECONCILE_TOKEN;
  if (!adminToken) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== adminToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const token = dzpkBotToken();
  if (!token) return NextResponse.json({ error: "DZPK_BOT_TOKEN not set" }, { status: 500 });

  const { webhookUrl } = await req.json();
  if (!webhookUrl) return NextResponse.json({ error: "webhookUrl required" }, { status: 400 });

  // `allowed_updates` volontairement RESTREINT à `message`.
  //
  // Le bot principal demande aussi callback_query / chat_member / my_chat_member.
  // Ici, rien de tout ça n'est traité en phase 1, et la détection du join ne
  // passe PAS par chat_member (elle passe par les notifs du club, cf. phase 2).
  // Demander des updates qu'on ne traite pas ne coûte pas rien : ça remplit la
  // file Telegram et ça masque le vrai trafic dans les logs.
  const body: Record<string, any> = {
    url: webhookUrl,
    allowed_updates: ["message"],
    // Un webhook réenregistré laisse traîner une file d'updates périmés que le
    // bot rejouerait d'un coup : des accueils envoyés à contretemps.
    drop_pending_updates: true,
  };
  const secret = process.env.DZPK_WEBHOOK_SECRET;
  if (secret) body.secret_token = secret;
  else console.warn("[DZPK SETUP] DZPK_WEBHOOK_SECRET absent — webhook non authentifié");

  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  return NextResponse.json({ webhook: await res.json(), secret_set: Boolean(secret) });
}

/** Diagnostic : état du webhook et identité du bot. Aucune écriture. */
export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const token = dzpkBotToken();
  if (!token) return NextResponse.json({ error: "DZPK_BOT_TOKEN not set" }, { status: 500 });

  const [meRes, hookRes] = await Promise.all([
    fetch(`https://api.telegram.org/bot${token}/getMe`),
    fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`),
  ]);
  const [me, webhook] = await Promise.all([meRes.json(), hookRes.json()]);

  return NextResponse.json({
    me,
    webhook,
    config: {
      club_invite_url_set: Boolean(process.env.DZPK_CLUB_INVITE_URL?.trim()),
      admin_chat_id_set: Boolean(process.env.DZPK_ADMIN_CHAT_ID?.trim()),
      agent_name_set: Boolean(process.env.DZPK_AGENT_NAME?.trim()),
      webhook_secret_set: Boolean(process.env.DZPK_WEBHOOK_SECRET),
    },
  });
}
