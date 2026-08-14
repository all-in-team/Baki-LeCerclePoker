import { NextRequest, NextResponse } from "next/server";

/**
 * Webhook du bot d'acquisition dzpk.
 *
 * ⚠️ ROUTE ENTIÈREMENT SÉPARÉE de `app/api/telegram/webhook/route.ts`.
 * Le bot dzpk a son propre token, donc sa propre URL de webhook : les deux flux
 * ne se croisent jamais. Aucun handler du bot principal n'est appelé ici, et
 * aucune table NEXA n'est touchée. C'est une isolation structurelle, pas une
 * convention à respecter.
 *
 * Cette route est hors du middleware d'auth (son matcher exclut `api/telegram`),
 * ce qui est indispensable — Telegram n'a pas de session. La protection est le
 * `secret_token` posé à l'enregistrement du webhook.
 *
 * Contrat de réponse : on renvoie TOUJOURS 200. Un non-200 fait rejouer l'update
 * par Telegram en boucle ; nos erreurs se logguent, elles ne se propagent pas.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.DZPK_WEBHOOK_SECRET;
  if (secret && req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: any;
  try {
    update = await req.json();
  } catch (e: any) {
    console.error("[DZPK WEBHOOK] JSON illisible:", e?.message ?? e);
    return NextResponse.json({ ok: true });
  }

  try {
    const { isDuplicateDzpkUpdate, recordStart, recordLeadMessage, markBlocked } =
      await import("@/lib/funnels/dzpk/leads");

    if (isDuplicateDzpkUpdate(update?.update_id)) {
      console.log(`[DZPK WEBHOOK] update ${update.update_id} déjà traité — ignoré`);
      return NextResponse.json({ ok: true });
    }

    const msg = update?.message;
    if (!msg || msg.from?.is_bot) return NextResponse.json({ ok: true });

    // Le bot dzpk ne parle qu'en conversation privée. Sa présence éventuelle dans
    // un groupe ne doit produire aucun effet de bord — surtout pas créer des leads.
    if (msg.chat?.type !== "private") return NextResponse.json({ ok: true });

    const identity = {
      telegram_id: msg.from?.id as number,
      username: msg.from?.username ?? null,
      first_name: msg.from?.first_name ?? null,
      last_name: msg.from?.last_name ?? null,
    };
    if (!identity.telegram_id) return NextResponse.json({ ok: true });

    const text: string | undefined = msg.text;

    // ── /start ────────────────────────────────────────────────────────────
    if (typeof text === "string" && /^\/start(\s|$|@)/.test(text)) {
      // Payload brut : ni découpé, ni mis en minuscules ici. C'est
      // normalizeSource() qui décide, en un seul endroit.
      const parts = text.split(/\s+/);
      const payload = parts.length > 1 ? parts.slice(1).join(" ") : null;

      const { lead, created, observedSource, observedClickId } = recordStart(identity, payload);
      console.log(
        `[DZPK START] lead=${lead.id} tg=${identity.telegram_id} @${identity.username ?? "-"} ` +
        `source=${lead.source}${observedSource !== lead.source ? ` (vue: ${observedSource}, first-touch conservée)` : ""} ` +
        // Le click id est tracé dès le /start : c'est ici, et nulle part
        // ailleurs, qu'on voit si le lien de pub l'a bien transporté. Le
        // constater au moment du join serait trop tard — le clic est passé.
        `cb=${lead.click_id ?? "aucun"}${observedClickId && observedClickId !== lead.click_id ? ` (vu: ${observedClickId}, first-touch conservé)` : ""} ` +
        `${created ? "nouveau" : `re-start #${lead.start_count}`}`
      );

      // Le /start EST la conversion remontée au réseau (goal principal, étape 2
      // de l'optimisation) : c'est le seul événement avec assez de volume pour
      // nourrir le SmartCPC. Toute la décision — click id présent, réseau
      // déduit de la source, verrou anti-doublon — vit dans postback.ts ; un
      // re-/start retombe sur le verrou et ne renvoie rien. Fire-and-forget :
      // l'accueil du lead ne doit jamais attendre un tiers.
      const { fireConversionPostback } = await import("@/lib/funnels/dzpk/postback");
      fireConversionPostback(lead.id);

      const { sendWelcome } = await import("@/lib/funnels/dzpk/welcome");
      const res = await sendWelcome(identity.telegram_id);
      if (res.blocked) markBlocked(lead.id);

      // L'accueil entre dans le fil, comme n'importe quel message du bot. Sans
      // lui, la conversation d'un lead qui répond s'ouvrirait sur sa réponse,
      // sans la question — illisible pour qui relit six semaines plus tard.
      if (res.ok) {
        const { logMessage } = await import("@/lib/funnels/dzpk/takeover");
        logMessage({
          leadId: lead.id, direction: "out", sender: "bot", kind: "text",
          text: res.text ?? null, telegramMessageId: res.messageId ?? null,
        });
      }
      return NextResponse.json({ ok: true });
    }

    // ── Toute autre commande : ignorée en silence ─────────────────────────
    // Le bot dzpk n'a pas de commandes. Répondre « commande inconnue » à un lead
    // chinois n'apporte rien ; le message est journalisé, ça suffit.
    if (typeof text === "string" && text.startsWith("/")) {
      const lead = recordLeadMessage(identity, text, "command");
      // Une commande inconnue reste un message que le lead a tapé : elle a sa
      // place dans le fil, sinon l'opérateur voit une conversation trouée.
      if (lead) {
        const { captureInbound } = await import("@/lib/funnels/dzpk/takeover");
        captureInbound(msg, lead.id);
      }
      return NextResponse.json({ ok: true });
    }

    // ── Message libre du lead ─────────────────────────────────────────────
    // PHASE 1 : on enregistre, on ne répond pas. Le relais vers un humain
    // (Support DZPK) arrive en phase 3.
    //
    // Le TEXTE est conservé dès maintenant dans le journal. Sans ça, tout ce
    // que les leads écriront entre la mise en service du bot et la phase 3
    // serait définitivement perdu — c'est exactement le bug que le live
    // takeover a corrigé côté NEXA, on ne le réintroduit pas ici.
    const kind = text != null ? "message" : mediaKind(msg);
    const lead = recordLeadMessage(identity, text ?? null, kind);
    if (!lead) {
      // Message d'un inconnu : personne n'a jamais fait /start avec ce compte.
      // On ne crée PAS de lead — un lead sans /start n'a pas de source, et en
      // fabriquer une fausserait l'attribution. On le trace, c'est tout.
      console.log(`[DZPK] message d'un non-lead tg=${identity.telegram_id} @${identity.username ?? "-"}`);
      return NextResponse.json({ ok: true });
    }

    // Le fil de conversation, lu par /dzpk-funnel. Écriture SÉPARÉE de
    // recordLeadMessage ci-dessus : ce dernier tient le journal d'événements et
    // l'historique d'identité de l'appariement, il ne sait pas ce qu'est une
    // direction. Les deux coexistent, aucun ne remplace l'autre.
    const { captureInbound } = await import("@/lib/funnels/dzpk/takeover");
    const captured = captureInbound(msg, lead.id);
    console.log(
      `[DZPK MSG] lead=${lead.id} @${identity.username ?? "-"} ${captured.kind}` +
      `${captured.duplicate ? " (rejeu ignoré)" : ""}`
    );
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error(`[DZPK WEBHOOK] erreur sur update ${update?.update_id}:`, e?.message ?? e, e?.stack);
    return NextResponse.json({ ok: true });
  }
}

/** Type de média, pour que le journal distingue « a envoyé une photo » de « n'a rien envoyé ». */
function mediaKind(msg: any): string {
  if (msg.photo) return "photo";
  if (msg.document) return "document";
  if (msg.voice) return "voice";
  if (msg.video) return "video";
  if (msg.audio) return "audio";
  if (msg.sticker) return "sticker";
  return "other";
}
