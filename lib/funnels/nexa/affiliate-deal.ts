// Parsing du deal NEXA et contrôle de l'Affiliate Payment.
//
// MODULE PUR — aucun import (repo ou npm), aucun accès DB, aucun effet de bord,
// aucune horloge. C'est délibéré : ce fichier est LE point de validation unique,
// partagé par la saisie manuelle d'aujourd'hui et par un éventuel import XLSX
// demain. Les deux chemins produisent des `RawAffiliateRow` et passent par
// `validateRow` — il ne peut donc pas exister deux versions du contrôle.
// Ne PAS y introduire de dépendance : ce serait percer ce seam.
//
// ─────────────────────────────────────────────────────────────────────────────
// RÈGLE CARDINALE : on ne devine RIEN.
// Un texte de deal non reconnu est rejeté, avec le texte brut et le fragment
// fautif remontés à l'appelant pour affichage. Jamais de taux par défaut, jamais
// d'alias inventé, jamais de variante supposée. Un taux faux est invisible et se
// propage dans toute la comptabilité ; un rejet est visible et se corrige.
// ─────────────────────────────────────────────────────────────────────────────

/** Les 4 variantes du report, dans l'ordre des colonnes. */
export type Variant = "nlh" | "mtt" | "plo" | "spins";
export const VARIANTS: readonly Variant[] = ["nlh", "mtt", "plo", "spins"] as const;

/** Une valeur par variante — sert aussi bien aux montants qu'aux taux (en %). */
export type VariantMap = { nlh: number; mtt: number; plo: number; spins: number };
export type DealRates = VariantMap;

/**
 * Tolérance du contrôle Affiliate Payment, en unités de montant.
 * ⚠️ DOIT rester identique au CHECK de `nexa_affiliate_weeks` dans lib/db.ts :
 *    CHECK (ABS(check_delta) <= 0.02 OR override_reason IS NOT NULL)
 * Les deux comparent le même double IEEE754 ; changer l'un sans l'autre rendrait
 * la base plus stricte que l'UI (écriture refusée sur une ligne affichée valide).
 */
export const PAYMENT_TOLERANCE = 0.02;

// Jetons acceptés, EXACTEMENT ceux du format connu. Aucun alias : ni NLHE, ni
// HOLDEM, ni OMAHA, ni « Global Spins », ni SPIN au singulier. Le jour où NEXA
// écrit autrement, la ligne est rejetée et le nouveau libellé s'ajoute ICI, une
// fois, en connaissance de cause — plutôt que d'être avalé par une heuristique.
const TOKEN_TO_VARIANT: Readonly<Record<string, Variant>> = {
  NLH: "nlh",
  MTT: "mtt",
  PLO: "plo",
  SPINS: "spins",
};

/** `<nombre>%` puis la liste des variantes. `\s*` partout : « 40%NLH » et « 40 % NLH » passent. */
const SEGMENT_RE = /^([0-9]+(?:\.[0-9]+)?)\s*%\s*(.+)$/;
/** Séparateurs à l'intérieur d'une liste : « and » (entouré d'espaces), « & », « + ». */
const VARIANT_SEP_RE = /\s+and\s+|\s*&\s*|\s*\+\s*/i;

export type DealRejectCode =
  | "empty"              // null / undefined / non-chaîne / chaîne blanche
  | "segment_unparsable" // un segment ne ressemble pas à « <n>% <variantes> »
  | "unknown_variant"    // jeton hors des 4 connus
  | "duplicate_variant"  // même variante citée deux fois
  | "rate_out_of_range"  // % hors [0, 100]
  | "no_variant";        // aucune variante reconnue dans tout le texte

export type DealParse =
  | {
      ok: true;
      rates: DealRates;
      /** Variantes ABSENTES du deal : taux 0 appliqué, à signaler à l'écran. */
      missing: Variant[];
      raw: string;
    }
  | {
      ok: false;
      code: DealRejectCode;
      message: string;
      /** Le morceau exact qui coince — null quand c'est le texte entier. */
      fragment: string | null;
      /** Le texte brut, à réafficher tel quel : l'opérateur doit voir ce qu'il a tapé. */
      raw: string;
    };

/** Représentation sûre de n'importe quelle entrée, pour pouvoir toujours réafficher le brut. */
function asRaw(input: unknown): string {
  if (typeof input === "string") return input;
  if (input === null || input === undefined) return "";
  return String(input);
}

/**
 * Parse « 40% NLH and MTT, 45% PLO, 55% Spins » → taux par variante.
 *
 * Tolérances volontaires, aucune n'introduisant d'ambiguïté : casse libre,
 * espaces multiples, `%` collé au libellé, segments vides (virgule finale ou
 * doublée).
 *
 * Limite connue : les segments sont découpés sur la virgule, donc un décimal
 * écrit à la française (« 42,5% NLH ») est illisible et sera rejeté en
 * `segment_unparsable`. Le point est le seul séparateur décimal accepté.
 */
export function parseDealRates(input: unknown): DealParse {
  const raw = asRaw(input);
  if (typeof input !== "string" || raw.trim() === "") {
    return { ok: false, code: "empty", message: "Deal vide — aucun taux ne peut en être déduit.", fragment: null, raw };
  }

  const rates: DealRates = { nlh: 0, mtt: 0, plo: 0, spins: 0 };
  const seen = new Set<Variant>();

  for (const segment of raw.split(",")) {
    const seg = segment.trim();
    if (seg === "") continue; // virgule finale ou doublée : bénin, aucune ambiguïté

    const m = SEGMENT_RE.exec(seg);
    if (!m) {
      return {
        ok: false, code: "segment_unparsable", fragment: seg, raw,
        message: `Segment illisible : « ${seg} ». Format attendu : « 40% NLH and MTT ».`,
      };
    }

    const pct = Number(m[1]);
    if (!isFinite(pct) || pct < 0 || pct > 100) {
      return {
        ok: false, code: "rate_out_of_range", fragment: seg, raw,
        message: `Taux hors bornes dans « ${seg} » : ${m[1]}% (attendu entre 0 et 100).`,
      };
    }

    for (const tokenRaw of m[2].split(VARIANT_SEP_RE)) {
      const token = tokenRaw.trim();
      if (token === "") continue;

      const variant = TOKEN_TO_VARIANT[token.toUpperCase()];
      if (!variant) {
        return {
          ok: false, code: "unknown_variant", fragment: token, raw,
          message: `Variante inconnue : « ${token} ». Attendu : NLH, MTT, PLO ou SPINS.`,
        };
      }
      if (seen.has(variant)) {
        return {
          ok: false, code: "duplicate_variant", fragment: token, raw,
          message: `Variante « ${token} » citée deux fois — impossible de savoir quel taux appliquer.`,
        };
      }
      seen.add(variant);
      rates[variant] = pct;
    }
  }

  if (seen.size === 0) {
    return { ok: false, code: "no_variant", message: "Aucune variante reconnue dans le deal.", fragment: null, raw };
  }

  return { ok: true, rates, missing: VARIANTS.filter(v => !seen.has(v)), raw };
}

/**
 * Affiliate Payment recalculé depuis les montants et les taux.
 *
 * PAS d'arrondi : l'arrondi à 2 décimales appartient à la frontière d'affichage
 * (invariant #9). Arrondir ici décalerait le contrôle de tolérance.
 */
export function recomputePayment(amounts: VariantMap, rates: DealRates): number {
  let total = 0;
  for (const v of VARIANTS) total += (amounts[v] * rates[v]) / 100;
  return total;
}

/**
 * Le contrat d'entrée NEUTRE — le seam.
 * Produit aujourd'hui par la grille de saisie, demain par un parser XLSX.
 * `member_id` est optionnel : beaucoup de lignes du report n'en portent pas.
 */
export type RawAffiliateRow = {
  nickname: string;
  member_id?: string | null;
  deal_text: string;
  nlh: number;
  mtt: number;
  plo: number;
  spins: number;
  /** Le montant LU sur le screenshot — la référence, jamais recalculée à sa place. */
  affiliate_payment: number;
};

export type RowRejectCode =
  | DealRejectCode
  | "nickname_empty"
  | "amount_not_finite"
  | "variant_missing_with_amount"
  | "payment_mismatch";

export type RowVerdict =
  | {
      ok: true;
      rates: DealRates;
      recomputed: number;
      /** recomputed − saisi. Même convention que `nexa_affiliate_weeks.check_delta`. */
      delta: number;
      /** Variantes absentes du deal dont le montant est 0 : taux 0, à signaler. */
      zeroRated: Variant[];
    }
  | {
      ok: false;
      code: RowRejectCode;
      message: string;
      /** Le deal brut, à réafficher tel quel. */
      raw_deal: string;
      fragment: string | null;
      /** Renseignés sur payment_mismatch uniquement — alimentent « attendu X · saisi Y · écart Z ». */
      expected: number | null;
      delta: number | null;
    };

const reject = (
  code: RowRejectCode, message: string, raw_deal: string,
  fragment: string | null = null, expected: number | null = null, delta: number | null = null,
): RowVerdict => ({ ok: false, code, message, raw_deal, fragment, expected, delta });

/**
 * Vérifie une ligne de report de bout en bout.
 *
 * Le contrôle à 0,02 est le filet anti-faute de frappe : en saisie manuelle,
 * l'Affiliate Payment du screenshot est la seule référence externe disponible.
 * S'il ne retombe pas, c'est qu'un des 6 champs saisis est faux — la ligne est
 * refusée et l'appelant affiche l'écart.
 *
 * `payment_mismatch` est le SEUL rejet qu'un opérateur peut passer outre (avec
 * motif obligatoire, cf. `override_reason` en base) : ce cas existe parce que le
 * screenshot NEXA peut lui-même être incohérent. Tous les autres codes signalent
 * une saisie ou un deal invalide, et rien ne doit permettre de les forcer.
 */
export function validateRow(row: RawAffiliateRow): RowVerdict {
  const rawDeal = asRaw(row?.deal_text);

  if (typeof row?.nickname !== "string" || row.nickname.trim() === "") {
    return reject("nickname_empty", "Nickname vide — la ligne n'est rattachable à personne.", rawDeal);
  }

  // Les montants peuvent être NÉGATIFS (semaine perdante) : on ne contrôle que
  // la finitude, jamais le signe.
  for (const v of VARIANTS) {
    if (typeof row[v] !== "number" || !isFinite(row[v])) {
      return reject("amount_not_finite", `Montant ${v.toUpperCase()} invalide : « ${asRaw(row[v])} ».`, rawDeal, v);
    }
  }
  if (typeof row.affiliate_payment !== "number" || !isFinite(row.affiliate_payment)) {
    return reject("amount_not_finite", `Affiliate Payment invalide : « ${asRaw(row.affiliate_payment)} ».`, rawDeal);
  }

  const parsed = parseDealRates(row.deal_text);
  if (!parsed.ok) return reject(parsed.code, parsed.message, parsed.raw, parsed.fragment);

  // Variante absente du deal : taux 0 toléré tant que le montant est nul, rejet
  // dur sinon — sans quoi du rake disparaîtrait en silence de la commission.
  const zeroRated: Variant[] = [];
  for (const v of parsed.missing) {
    if (row[v] !== 0) {
      return reject(
        "variant_missing_with_amount",
        `${v.toUpperCase()} vaut ${row[v]} mais n'apparaît pas dans le deal — taux inconnu, ligne refusée.`,
        parsed.raw, v,
      );
    }
    zeroRated.push(v);
  }

  const recomputed = recomputePayment(row, parsed.rates);
  const delta = recomputed - row.affiliate_payment;
  if (Math.abs(delta) > PAYMENT_TOLERANCE) {
    return reject(
      "payment_mismatch",
      `Le recalcul ne retombe pas : attendu ${recomputed.toFixed(2)}, saisi ${row.affiliate_payment.toFixed(2)} (écart ${delta.toFixed(2)}).`,
      parsed.raw, null, recomputed, delta,
    );
  }

  return { ok: true, rates: parsed.rates, recomputed, delta, zeroRated };
}
