// Transcription d'un screenshot de report NEXA — LECTURE SEULE, AUCUNE ÉCRITURE.
//
// Le résultat PRÉ-REMPLIT la grille de saisie. Il ne va pas en base : le chemin
// reste extraction → grille → validate → relecture humaine → commitWeek. Un
// producteur de RawAffiliateRow de plus, exactement comme le futur XLSX.
//
// Deux étages, volontairement séparés :
//   1. ICI : l'appel vision, qui ne fait QUE transcrire (aucun calcul, aucune
//      interprétation). Sa sortie est contrainte par un JSON Schema.
//   2. buildSheet (./affiliate-screenshot, PUR) : plage de dates, montants,
//      ligne de total, checksum. Déterministe et testable sans clé.
// Le recalcul de l'Affiliate Payment n'est fait ni ici ni là : c'est validateRow,
// via le contrôle serveur de la grille. Une seule implémentation de cette règle.
//
// La clé API est lue depuis process.env CÔTÉ SERVEUR et ne quitte jamais ce
// fichier — ni dans la réponse, ni dans un log, ni vers le client.
import { NextRequest, NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { buildSheet, type ExtractedSheet } from "@/lib/funnels/nexa/affiliate-screenshot";

/** Un screenshot fait quelques dizaines de Ko ; au-delà, c'est autre chose. */
const MAX_BYTES = 8 * 1024 * 1024;
const ACCEPTED = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// ── Saturation de l'API (529) ─────────────────────────────────────────────
//
// Le 529 `overloaded_error` est transitoire : l'API est saturée, la même requête
// passera dans quelques secondes. Le SDK retente déjà les 5xx, mais avec un
// backoff court (quelques centaines de ms) taillé pour un hoquet, pas pour une
// saturation qui dure. On lui coupe donc ses reprises (`maxRetries: 0`) et on
// pilote nous-mêmes, avec des délais assez longs pour laisser passer la vague —
// sans multiplier les tentatives à l'insu de tout le monde (3 reprises SDK × 3
// boucles = 9 appels vision facturés).
//
// UNIQUEMENT SUR 529. Un 400 (image invalide) ou un 401 (clé fausse) ne
// deviendront jamais bons en réessayant : les retenter brûle du temps et de
// l'argent pour finir sur la même erreur.
const RETRY_DELAYS_MS = [2_000, 5_000, 10_000];

/** 529 / overloaded_error, et rien d'autre. */
function isOverloaded(e: unknown): boolean {
  if (!(e instanceof Anthropic.APIError)) return false;
  // `status` et `type` sont portés par les sous-classes APIStatusError ; on les
  // lit sans caster la classe elle-même (elle est exportée comme valeur, pas type).
  const { status, type } = e as unknown as { status?: number; type?: string };
  return status === 529 || type === "overloaded_error";
}

const OVERLOADED_MESSAGE =
  "API saturée, réessaie dans une minute. Rien n'a été perdu : ton screenshot n'est pas encore enregistré, "
  + "il suffit de le redéposer. (Le serveur a déjà réessayé plusieurs fois de son côté.)";

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// Cellule : chaîne, ou null quand elle est ILLISIBLE. La distinction est le cœur
// du contrat — une case vide vaut "" (elle vaut 0 dans le format NEXA), une case
// qu'on n'arrive pas à lire vaut null et fera rejeter la ligne en aval.
const CELL = { anyOf: [{ type: "string" }, { type: "null" }] } as const;

const ROW_PROPS = {
  nickname: CELL, member_id: CELL, affiliate: CELL, deal_text: CELL,
  nlh: CELL, mtt: CELL, plo: CELL, spins: CELL, affiliate_payment: CELL,
} as const;

const SHEET_SCHEMA = {
  type: "object",
  properties: {
    month_label: CELL,
    week_label: CELL,
    rows: {
      type: "array",
      items: {
        type: "object",
        properties: ROW_PROPS,
        required: Object.keys(ROW_PROPS),
        additionalProperties: false,
      },
    },
    total_payment: CELL,
  },
  required: ["month_label", "week_label", "rows", "total_payment"],
  additionalProperties: false,
} as const;

// Le prompt ne demande QUE de la transcription. Toute tentative de faire calculer,
// corriger ou compléter le modèle est une porte ouverte à des chiffres inventés
// qui seraient indétectables ensuite.
const PROMPT = `Tu transcris un tableau extrait d'un screenshot de report d'affiliation poker.

TA SEULE TÂCHE EST DE RECOPIER CE QUE TU VOIS. Tu ne calcules rien, tu ne corriges
rien, tu ne complètes rien, tu ne réordonnes rien.

Structure du tableau :
- En haut à GAUCHE : le mois et l'année, ex. "July 2026" → champ month_label.
- En haut à DROITE : la plage de la semaine, ex. "13.07.-19.07." → champ week_label.
- Colonnes, dans cet ordre : Nickname | ID | Affiliate | Affiliate deal |
  NLH | MTT | PLO | Global Spins | Affiliate Payment.
  La colonne "Global Spins" correspond au champ spins.
- DERNIÈRE LIGNE : un total en gras, seul dans la colonne Affiliate Payment, sans
  pseudo ni ID. Ce n'est PAS un joueur. Mets-le dans total_payment et NE le mets
  PAS dans rows.

Règles de transcription, sans exception :
1. Recopie chaque cellule EXACTEMENT comme affichée, symbole $ et virgules de
   milliers compris : "$1,111.95" se transcrit "$1,111.95", pas 1111.95.
2. Les montants NÉGATIFS existent (semaine perdante) : "-$61.46" se transcrit tel
   quel, signe compris. Ne les transforme jamais en positif.
3. Une cellule VIDE se transcrit par la chaîne vide "". C'est normal dans ce
   format et cela ne signale aucun problème.
4. Une cellule que tu n'arrives PAS À LIRE de façon certaine — floue, coupée,
   ambiguë — se transcrit par null. JAMAIS par 0, jamais par une valeur devinée,
   jamais par une valeur reconstituée à partir des autres colonnes. Un 0 inventé
   serait indétectable en aval ; un null est visible et sera corrigé à la main.
5. La colonne ID est souvent vide : c'est normal, transcris "".
6. Le texte du deal se recopie mot pour mot, casse comprise
   (ex. "40% NLH and MTT, 45% PLO, 55% SPINS").
7. N'invente aucune ligne et n'en omets aucune. Si une ligne est entièrement
   vide, transcris-la avec toutes ses cellules à "".

Si tu hésites entre deux lectures d'un chiffre, la réponse est null.`;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({
        error: "ANTHROPIC_API_KEY absente de l'environnement du serveur — extraction indisponible. " +
               "En local : relance avec ANTHROPIC_API_KEY=… npm run dev.",
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
    // maxRetries: 0 — les reprises sont pilotées ci-dessous, voir l'encadré 529.
    const client = new Anthropic({ maxRetries: 0 }); // lit ANTHROPIC_API_KEY dans l'environnement

    const callVision = () => client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      output_config: { format: { type: "json_schema", schema: SHEET_SCHEMA as unknown as Record<string, unknown> } },
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mediaType as "image/png", data } },
          { type: "text", text: PROMPT },
        ],
      }],
    });

    // `!` : la boucle sort soit par `break` (response assignée), soit par un
    // `return`/`throw`. TypeScript ne sait pas le déduire d'un for(;;).
    let response!: Anthropic.Message;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await callVision();
        break;
      } catch (e) {
        // Toute autre erreur remonte au catch général : on ne retente QUE la saturation.
        if (!isOverloaded(e)) throw e;
        if (attempt >= RETRY_DELAYS_MS.length) {
          console.error(`[NEXA_AFFILIATE_EXTRACT] 529 overloaded après ${attempt + 1} tentative(s) — abandon.`);
          return NextResponse.json({ error: OVERLOADED_MESSAGE }, { status: 503 });
        }
        const wait = RETRY_DELAYS_MS[attempt];
        console.warn(`[NEXA_AFFILIATE_EXTRACT] 529 overloaded — reprise ${attempt + 1}/${RETRY_DELAYS_MS.length} dans ${wait} ms`);
        await sleep(wait);
      }
    }

    // Un refus classifieur revient en HTTP 200 : à tester AVANT de lire content.
    if (response.stop_reason === "refusal") {
      return NextResponse.json({ error: "La transcription a été refusée par le modèle. Saisis la semaine à la main." }, { status: 422 });
    }
    if (response.stop_reason === "max_tokens") {
      return NextResponse.json({ error: "Transcription tronquée (max_tokens atteint) — screenshot probablement trop dense." }, { status: 422 });
    }

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    if (!textBlock) {
      return NextResponse.json({ error: "Le modèle n'a renvoyé aucun texte exploitable." }, { status: 502 });
    }

    let sheet: ExtractedSheet;
    try {
      sheet = JSON.parse(textBlock.text) as ExtractedSheet;
    } catch {
      return NextResponse.json({ error: "Transcription illisible (JSON invalide)." }, { status: 502 });
    }

    // Post-traitement déterministe : plage de dates, montants, total, checksum.
    const built = buildSheet(sheet);
    if (!built.ok) {
      return NextResponse.json({ ok: false, error: built.reason, raw: sheet }, { status: 422 });
    }

    return NextResponse.json({
      ok: true,
      week_start: built.week_start,
      week_end: built.week_end,
      rows: built.rows,
      checksum: built.checksum,
      rejected: built.rejected,
      // La transcription brute, pour que l'écran puisse montrer ce qui a été LU
      // quand une ligne est rejetée. Ne contient jamais de secret.
      raw: sheet,
      usage: { input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens },
    });
  } catch (e: any) {
    // Surtout ne pas relayer l'objet d'erreur brut : il peut porter des en-têtes
    // de requête, donc la clé. On ne garde que le message.
    console.error("[NEXA_AFFILIATE_EXTRACT]", e?.message ?? e);
    const status = typeof e?.status === "number" ? e.status : 500;

    // Le message d'une erreur SDK est le JSON de l'API ({"type":"error",...}) :
    // illisible à l'écran. On traduit les cas connus et on garde le brut en log.
    if (isOverloaded(e)) {
      return NextResponse.json({ error: OVERLOADED_MESSAGE }, { status: 503 });
    }
    if (e instanceof Anthropic.RateLimitError) {
      return NextResponse.json({
        error: "Quota API atteint (trop de requêtes). Attends une minute avant de redéposer le screenshot.",
      }, { status: 429 });
    }
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
      return NextResponse.json({
        error: "La clé API du serveur est refusée par Anthropic — extraction indisponible. Saisis la semaine à la main.",
      }, { status });
    }
    if (e instanceof Anthropic.APIConnectionError) {
      return NextResponse.json({
        error: "Impossible de joindre l'API Anthropic (réseau). Réessaie dans un instant.",
      }, { status: 503 });
    }
    if (e instanceof Anthropic.APIError) {
      // Erreur API non identifiée : on affiche le statut, pas la charge JSON.
      return NextResponse.json({
        error: `L'API a répondu ${status}. Réessaie, ou saisis la semaine à la main.`,
      }, { status });
    }
    return NextResponse.json({ error: e?.message ?? "Erreur d'extraction." }, { status });
  }
}
