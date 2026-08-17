// Transcription d'une photo de BANKROLL — LECTURE SEULE, AUCUNE ÉCRITURE.
//
// Le résultat PRÉ-REMPLIT le champ « BR de fin » du panneau de règlement. Il ne
// va pas en base, et il ne déclenche aucun calcul : le chemin reste photo →
// champ → relecture humaine → clic « régler ». Un producteur de montant de plus,
// exactement comme la saisie au clavier.
//
// Deux étages, volontairement séparés — même découpage que l'extraction du
// report d'affiliation :
//   1. ICI : l'appel vision, qui ne fait QUE transcrire. Sortie contrainte par
//      un JSON Schema.
//   2. parseBankrollAmount (../bankroll-engine, PUR) : lecture du montant,
//      arbitrage point/virgule, refus des ambiguïtés. Testable sans clé.
//
// LA PHOTO NE STOCKE RIEN, PAS MÊME ELLE-MÊME. Plusieurs photos déposées à la
// suite ne posent donc aucun problème d'ambiguïté : la dernière pré-remplit le
// champ, et c'est le champ — relu par Hugo — qui fait foi au verrouillage.
//
// La clé API est lue depuis process.env CÔTÉ SERVEUR et ne quitte jamais ce
// fichier — ni dans la réponse, ni dans un log, ni vers le client.
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { parseBankrollAmount } from "@/lib/funnels/nexa/bankroll-engine";
import { callVisionWithRetry } from "@/lib/funnels/nexa/vision-retry";

const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TAG = "NEXA_BANKROLL_EXTRACT";

// Cellule : chaîne, ou null quand elle est ILLISIBLE. La distinction est le cœur
// du contrat — un null est visible et repasse la main à la saisie manuelle, un 0
// inventé serait indétectable et deviendrait une bankroll de 0.
const CELL = { anyOf: [{ type: "string" }, { type: "null" }] } as const;

const SHOT_SCHEMA = {
  type: "object",
  properties: {
    bankroll: CELL,
    /** Ce que le modèle a vu autour du chiffre — sert à lever un doute à l'écran. */
    label_seen: CELL,
  },
  required: ["bankroll", "label_seen"],
  additionalProperties: false,
} as const;

// Le prompt ne demande QUE de la transcription. Toute tentative de faire
// calculer, convertir ou compléter le modèle est une porte ouverte à des
// chiffres inventés qui seraient indétectables ensuite.
const PROMPT = `Tu transcris le SOLDE affiché sur une capture d'écran d'application de poker.

TA SEULE TÂCHE EST DE RECOPIER LE CHIFFRE QUE TU VOIS. Tu ne calcules rien, tu ne
convertis rien, tu ne complètes rien.

- Champ bankroll : le solde principal du joueur, recopié EXACTEMENT comme affiché,
  séparateurs compris. « 377.99 » se transcrit "377.99", « 377,99 » se transcrit
  "377,99". Ne normalise pas, ne retire pas les séparateurs, n'ajoute pas de $.
- Champ label_seen : le libellé affiché à côté de ce chiffre, tel quel
  (ex. "Balance", "Solde", "Bankroll"). Il sert à vérifier qu'on lit le bon champ.

Règles, sans exception :
1. Si l'image montre PLUSIEURS montants et que tu n'es pas certain de savoir lequel
   est le solde du joueur, réponds null. Ne choisis pas le plus gros, ne choisis pas
   le premier.
2. Un chiffre flou, coupé, partiellement masqué ou ambigu se transcrit par null.
   JAMAIS par 0, jamais par une valeur devinée, jamais par une valeur reconstituée.
3. Si l'image n'est pas une capture d'application de poker, réponds null.

Si tu hésites entre deux lectures d'un chiffre, la réponse est null.`;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({
        error: "ANTHROPIC_API_KEY absente de l'environnement du serveur — extraction indisponible. "
             + "En local : relance avec ANTHROPIC_API_KEY=… npm run dev. La BR se saisit à la main en attendant.",
      }, { status: 503 });
    }

    const form = await req.formData();
    const file = form.get("file") as File | null;
    if (!file) return NextResponse.json({ error: "Aucune image reçue." }, { status: 400 });
    if (file.size > MAX_BYTES) {
      return NextResponse.json({ error: `Image trop lourde (${Math.round(file.size / 1024)} Ko, max ${MAX_BYTES / 1024 / 1024} Mo).` }, { status: 400 });
    }
    const mediaType = file.type || "image/png";
    if (!ACCEPTED.includes(mediaType)) {
      return NextResponse.json({ error: `Format non supporté : ${mediaType}. Attendu PNG, JPEG, WebP ou GIF.` }, { status: 400 });
    }

    const data = Buffer.from(await file.arrayBuffer()).toString("base64");
    // maxRetries: 0 — les reprises sont pilotées par callVisionWithRetry.
    const client = new Anthropic({ maxRetries: 0 }); // lit ANTHROPIC_API_KEY dans l'environnement

    const outcome = await callVisionWithRetry(() => client.messages.create({
      model: "claude-opus-5",
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SHOT_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/png", data } },
          { type: "text", text: PROMPT },
        ],
      }],
    }), TAG);
    if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    const response = outcome.message;

    // Un refus classifieur revient en HTTP 200 : à tester AVANT de lire content.
    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "La transcription a été refusée par le modèle. Saisis la BR à la main." }, { status: 422 });
    }
    if (response.stop_reason === "max_tokens") {
      return NextResponse.json({ error: "Transcription tronquée (max_tokens atteint)." }, { status: 422 });
    }

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) {
      return NextResponse.json({ error: "Le modèle n'a renvoyé aucun texte exploitable." }, { status: 502 });
    }

    let shot: { bankroll: string | null; label_seen: string | null };
    try {
      shot = JSON.parse(textBlock.text);
    } catch {
      return NextResponse.json({ error: "Transcription illisible (JSON invalide)." }, { status: 502 });
    }

    // Post-traitement déterministe. Un refus ici n'est PAS une erreur de la
    // route : c'est le cas nominal « je n'ai pas su lire, à toi de saisir ».
    // D'où le 200 avec ok:false — l'écran ouvre le champ, il n'affiche pas
    // une panne.
    const read = parseBankrollAmount(shot.bankroll);
    if (!read.ok) {
      return NextResponse.json({
        ok: false, error: read.reason, label_seen: shot.label_seen ?? null, raw: shot.bankroll ?? null,
      });
    }

    return NextResponse.json({
      ok: true,
      bankroll: read.value,
      label_seen: shot.label_seen ?? null,
      raw: shot.bankroll,
    });
  } catch (e: any) {
    console.error(`[${TAG}]`, e?.message ?? e);
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
