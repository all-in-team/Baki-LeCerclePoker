import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  sendTestPostback, retryPostback, retryJoinPostback, resolveNetwork,
  postbackTemplate, joinPostbackTemplate,
  CB_PLACEHOLDER, POSTBACK_TIMEOUT_MS,
  type PostbackNetwork,
} from "@/lib/funnels/dzpk/postback";

/**
 * Postbacks S2S de conversion dzpk — observation et validation de la chaîne.
 *
 *   GET  → configuration vue par le serveur + état des leads (combien
 *          d'attribuables, combien de postbacks partis, les derniers résultats)
 *   POST → { network, cb }     : envoi de TEST avec un click id fourni à la main.
 *                                Ne touche à aucun lead. C'est ce qui permet de
 *                                valider avec « Test conversion » de PropellerAds
 *                                sans attendre un vrai /start.
 *          { leadId, retry }   : rejeu explicite pour un lead réel (lève le
 *                                verrou `postback_sent_at` puis renvoie).
 *          + goal: "join"      : sur l'un ou l'autre mode, vise le goal
 *                                SECONDAIRE (join) — gabarit *_POSTBACK_URL_JOIN
 *                                et verrou `join_postback_sent_at`.
 *
 * Même garde que les autres routes api/admin : `x-admin-token`, fail-closed.
 *
 * ┌─ POURQUOI UNE ROUTE ET PAS UN SCRIPT ──────────────────────────────────────┐
 * │ Les URL de postback vivent dans les variables Railway. Un script local     │
 * │ validerait une configuration locale — c'est-à-dire rien. Cette route       │
 * │ s'exécute là où tourne le bot, avec les vraies variables : ce qu'elle      │
 * │ renvoie est ce qui partira au prochain join.                               │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
function guard(req: NextRequest): NextResponse | null {
  const adminToken = process.env.ADMIN_RECONCILE_TOKEN;
  if (!adminToken) return NextResponse.json({ error: "ADMIN_RECONCILE_TOKEN not set" }, { status: 503 });
  if (req.headers.get("x-admin-token") !== adminToken) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return null;
}

/**
 * État d'un gabarit, SANS le divulguer.
 *
 * Ces URL portent des identifiants de campagne (`aid`, `tid`) : la route est
 * protégée, mais une réponse qui les recopie finit dans un presse-papier, un
 * ticket, un log. On renvoie de quoi diagnostiquer — présence, hôte, `{CB}`
 * substituable — et rien de plus.
 */
function templateStatus(network: PostbackNetwork, goal: "start" | "join" = "start") {
  const t = goal === "join" ? joinPostbackTemplate(network) : postbackTemplate(network);
  if (!t) return { configured: false, host: null, has_cb_placeholder: false };
  let host: string | null = null;
  try { host = new URL(t).host; } catch { host = "url illisible"; }
  return { configured: true, host, has_cb_placeholder: t.includes(CB_PLACEHOLDER) };
}

export async function GET(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  const db = getDb();

  // Le funnel de l'attribution, étage par étage. C'est la lecture qui répond à
  // « pourquoi si peu de postbacks ? » : chaque ligne est une marche perdue.
  const leads = db.prepare(
    `SELECT COUNT(*)                                                        AS total,
            SUM(CASE WHEN click_id IS NOT NULL THEN 1 ELSE 0 END)           AS avec_click_id,
            SUM(CASE WHEN club_joined_at IS NOT NULL THEN 1 ELSE 0 END)     AS ont_rejoint,
            SUM(CASE WHEN club_joined_at IS NOT NULL
                      AND click_id IS NOT NULL THEN 1 ELSE 0 END)           AS joins_attribuables,
            SUM(CASE WHEN postback_sent_at IS NOT NULL THEN 1 ELSE 0 END)   AS postbacks_tentes,
            SUM(CASE WHEN join_postback_sent_at IS NOT NULL THEN 1 ELSE 0 END) AS join_postbacks_tentes
       FROM dzpk_leads`
  ).get() as Record<string, number>;

  // Les joins attribuables qui n'ont PAS posté : c'est le seul chiffre qui
  // signale une chaîne cassée. Zéro partout ailleurs peut être normal (pas
  // encore de trafic) ; une valeur ici ne l'est jamais.
  const enAttente = db.prepare(
    `SELECT id, source, club_joined_at
       FROM dzpk_leads
      WHERE club_joined_at IS NOT NULL AND click_id IS NOT NULL AND postback_sent_at IS NULL
      ORDER BY club_joined_at DESC LIMIT 20`
  ).all() as Array<{ id: number; source: string; club_joined_at: string }>;

  const derniers = db.prepare(
    `SELECT id, source, postback_sent_at, postback_result,
            join_postback_sent_at, join_postback_result
       FROM dzpk_leads
      WHERE postback_sent_at IS NOT NULL OR join_postback_sent_at IS NOT NULL
      ORDER BY COALESCE(join_postback_sent_at, postback_sent_at) DESC LIMIT 20`
  ).all();

  return NextResponse.json({
    config: {
      // Goal principal : déclenché au /start (webhook), filet au join.
      propeller: templateStatus("propeller"),
      richads: templateStatus("richads"),
      // Goal secondaire : le join. Optionnel — non configuré n'est pas une anomalie.
      propeller_join: templateStatus("propeller", "join"),
      richads_join: templateStatus("richads", "join"),
      timeout_ms: POSTBACK_TIMEOUT_MS,
    },
    leads,
    // Ces leads sont attribuables et ont rejoint sans qu'aucun postback ne
    // parte. Cause la plus probable : join crédité avant la mise en service.
    joins_sans_postback: enAttente.map(l => ({
      ...l,
      reseau: resolveNetwork(l.source),
      rejouer: `POST /api/admin/dzpk-postback {"leadId": ${l.id}, "retry": true}`,
    })),
    derniers_postbacks: derniers,
  });
}

export async function POST(req: NextRequest) {
  const denied = guard(req);
  if (denied) return denied;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "corps JSON illisible" }, { status: 400 });
  }

  // ── Rejeu d'un lead réel ──────────────────────────────────────────────────
  // Explicitement demandé (`retry: true`), jamais déduit : lever le verrou d'un
  // lead est la seule opération de cette route capable de produire une
  // conversion en double côté réseau.
  // `goal` : "start" (défaut, goal principal) ou "join" (goal secondaire).
  const goal = String(body?.goal ?? "start").trim().toLowerCase();
  if (goal !== "start" && goal !== "join") {
    return NextResponse.json({ error: "goal doit valoir 'start' ou 'join'" }, { status: 400 });
  }

  if (body?.leadId != null) {
    const leadId = Number(body.leadId);
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return NextResponse.json({ error: "leadId invalide" }, { status: 400 });
    }
    if (body?.retry !== true) {
      return NextResponse.json(
        { error: "rejeu d'un lead : ajouter \"retry\": true (lève le verrou postback_sent_at)" },
        { status: 400 },
      );
    }
    const out = goal === "join" ? await retryJoinPostback(leadId) : await retryPostback(leadId);
    return NextResponse.json({ mode: "rejeu", goal, leadId, ...out });
  }

  // ── Envoi de test ─────────────────────────────────────────────────────────
  const network = String(body?.network ?? "").trim().toLowerCase();
  if (network !== "propeller" && network !== "richads") {
    return NextResponse.json(
      { error: "network doit valoir 'propeller' ou 'richads'" },
      { status: 400 },
    );
  }
  const cb = String(body?.cb ?? "").trim();
  // Même charset que les vrais click ids : un test qui accepterait ce que la
  // production refuse ne prouverait pas grand-chose.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(cb)) {
    return NextResponse.json(
      { error: "cb manquant ou hors charset (A-Z a-z 0-9 _ -, 64 max)" },
      { status: 400 },
    );
  }

  const out = await sendTestPostback(network as PostbackNetwork, cb, undefined, goal);
  return NextResponse.json({
    mode: "test",
    goal,
    network,
    cb,
    ...out,
    // Rappel utile dans la réponse elle-même : ce test ne prouve QUE le
    // transport. Que le réseau ait bien enregistré la conversion se lit chez
    // lui, pas ici — un 200 poli est le comportement par défaut d'un pixel.
    note: "un 2xx prouve que l'appel est parti et a été accepté ; la prise en compte se vérifie côté réseau",
  });
}
