// Règlement hebdomadaire sur BANKROLL — MODULE PUR.
//
// Zéro import, zéro accès DB, zéro horloge : tout entre par les paramètres. Même
// découpage que ./rakeback-engine (moteur pur) vs ./players (base). Le calcul se
// teste donc au chiffre près, sans base et sans clé API.
//
// ─────────────────────────────────────────────────────────────────────────────
// CE QUE CE MODULE PRODUIT : un WIN/LOSS. Rien d'autre.
//
// Il n'existe PAS de « résultat bankroll » à côté du win/loss de la grille : la
// bankroll est le CALCULATEUR, `nexa_player_weekly_winloss` reste la seule table
// de résultat, et son UNIQUE(player_id, week_start) interdit structurellement
// qu'une semaine porte deux chiffres différents. Une fois le win/loss écrit, la
// chaîne existante (computeRakeback → part d'action → règlement) s'applique
// telle quelle, sans une ligne de changement.
//
//   résultat = (BR fin + cash-outs) − (BR début + dépôts)
//   ma part  = résultat × action_pct / 100
//   résultat > 0 → le joueur a gagné → il me doit ma part
//   résultat < 0 → le joueur a perdu → je lui verse |ma part| sur sa wallet game
//
// La convention de signe est CELLE DU REPO, pas une convention locale :
// `action_amount = winloss × action_pct / 100`, positif = le joueur doit au
// Cercle (cf. rakeback-engine.ts et manual_settlements.amount_due_usdt).
//
// ARRONDI AU CENTIME, DEMI-SUPÉRIEUR EN VALEUR ABSOLUE (arbitrage Hugo,
// 2026-08-17). Math.round() seul est asymétrique sur les négatifs — −0.005 lui
// donne −0.00 quand +0.005 donne +0.01 — et TOUS les montants d'ici sont signés.
// Une perte et un gain de même ampleur doivent s'arrondir pareil.
//
// L'arrondi n'a lieu qu'à DEUX endroits, `result` et `action_amount`, et les
// deux sont stockés arrondis : le résidu sub-centime ne rentre jamais dans la
// chaîne, puisque la BR de début de la semaine suivante repart d'une valeur déjà
// arrondie. Les entrées, elles, sont EXIGÉES au centime exact (même règle que
// ./movement-command) — on ne rattrape pas une saisie à trois décimales, on la
// refuse.
// ─────────────────────────────────────────────────────────────────────────────

export const EPS = 0.0000001;

/**
 * Arrondi au centime, demi-supérieur en valeur absolue.
 * `|| 0` : `Math.sign(-0.001) * 0` rend `-0`, qui s'affiche « -0.00 ».
 */
export function round2(x: number): number {
  return (Math.sign(x) * Math.round(Math.abs(x) * 100)) / 100 || 0;
}

/**
 * Le montant tombe-t-il juste au centime ?
 *
 * La tolérance 1e-9 n'est pas une coquetterie : `377.99 * 100` vaut
 * 37798.999999999996 en flottant. Comparer à l'entier sans tolérance refuserait
 * des montants parfaitement légitimes — et le premier réflexe serait alors
 * d'assouplir la règle au mauvais endroit.
 */
export function isCentExact(x: number): boolean {
  return Number.isFinite(x) && Math.abs(x * 100 - Math.round(x * 100)) < 1e-9;
}

/** Une semaine de bankroll, telle qu'elle se présente au moment de la clôture. */
export type BankrollWeekInput = {
  /** BR de début — reprise de la semaine précédente, ou saisie pour la première. */
  br_open: number;
  /** BR de fin — saisie manuelle, ou pré-remplie depuis la photo. */
  br_close: number;
  /** Σ des buy-ins de la semaine, HORS versements de règlement (cf. encadré infra). */
  deposits: number;
  /** Σ des cash-outs de la semaine, HORS versements de règlement. */
  cashouts: number;
  /** Part d'action en vigueur au lundi de la semaine. */
  action_pct: number;
};

export type BankrollWeekComputed = {
  /** (BR fin + cash-outs) − (BR début + dépôts). Signé, arrondi au centime. */
  result: number;
  /** result × action_pct / 100. Positif = il me doit. Négatif = je lui dois. */
  action_amount: number;
  /**
   * Ce que je verse sur sa wallet game, TOUJOURS POSITIF (0 s'il a gagné).
   * Le sens est porté par le fait qu'il existe, pas par son signe — même parti
   * pris que addMovement, où le sens vit dans le `type` et jamais dans le montant.
   */
  transfer_amount: number;
  /**
   * BR de début de la semaine suivante = BR de fin, sans rien y ajouter.
   *
   * MON VERSEMENT N'EST PAS REPORTÉ ICI, et c'est le cœur du modèle. Il compte
   * comme un DÉPÔT de bankroll dans la semaine de sa date de paiement réelle
   * (cf. l'encadré de carriedBrOpen). Le reporter reviendrait à supposer qu'il a
   * eu lieu — alors qu'il peut traîner, et que la chaîne fabriquerait alors une
   * seconde dette pour la même perte.
   */
  next_br_open: number;
  /**
   * Sa bankroll UNE FOIS le versement reçu — pour l'affichage, jamais pour le
   * calcul. C'est le « il redémarre à 864,59 » d'Hugo : vrai comme description
   * de sa BR après paiement, faux comme entrée du calcul tant qu'on n'a pas payé.
   */
  br_after_transfer: number;
};

export type ComputeResult =
  | { ok: true; value: BankrollWeekComputed }
  | { ok: false; error: string };

const FIELDS: readonly (keyof BankrollWeekInput)[] = [
  "br_open", "br_close", "deposits", "cashouts", "action_pct",
];

const LABELS: Readonly<Record<keyof BankrollWeekInput, string>> = {
  br_open: "BR de début", br_close: "BR de fin",
  deposits: "dépôts de la semaine", cashouts: "cash-outs de la semaine",
  action_pct: "part d'action",
};

/**
 * Calcule une semaine de bankroll.
 *
 * REFUSE plutôt que de réparer, exactement comme ./affiliate-screenshot : une
 * entrée à trois décimales, un négatif là où c'est impossible, un % hors bornes
 * sont des rejets nommés. Un montant « rattrapé » en silence serait indétectable
 * en aval, et c'est de l'argent.
 */
export function computeBankrollWeek(i: BankrollWeekInput): ComputeResult {
  for (const f of FIELDS) {
    const v = i[f];
    if (!Number.isFinite(v)) return { ok: false, error: `${LABELS[f]} : nombre attendu.` };
  }

  // La bankroll et les mouvements sont des grandeurs physiques : une BR négative
  // ou un dépôt négatif n'existent pas. Le RÉSULTAT, lui, est signé — c'est la
  // seule grandeur d'ici qui a le droit de l'être (avec la part d'action).
  for (const f of ["br_open", "br_close", "deposits", "cashouts"] as const) {
    if (i[f] < 0) return { ok: false, error: `${LABELS[f]} : un montant négatif n'a pas de sens ici.` };
  }

  // LE CONTRÔLE AU CENTIME NE PORTE QUE SUR LES MONTANTS SAISIS.
  //
  // br_open et br_close sont tapés (ou lus sur la photo) : trois décimales y sont
  // une faute de frappe, et on la refuse. deposits et cashouts, eux, sont des
  // SOMMES de mouvements déjà validés au centime un par un — et une somme de
  // flottants dérive : 50 buy-ins de 1234.56 donnent 61727.999999999956, hors de
  // la tolérance de 1e-9. Leur appliquer le même contrôle rendait la semaine
  // IMPOSSIBLE À CLÔTURER, avec un message accusant une saisie à trois décimales
  // qui n'a jamais eu lieu — et aucune issue depuis l'écran.
  // (Constat money-auditor 2026-08-17, démontré sur 50 mouvements.)
  //
  // On les arrondit à la place : chaque terme est cent-exact, donc l'arrondi de
  // leur somme REND la valeur exacte au lieu de la déformer.
  for (const f of ["br_open", "br_close"] as const) {
    if (!isCentExact(i[f])) {
      return { ok: false, error: `${LABELS[f]} : deux décimales maximum (reçu ${i[f]}).` };
    }
  }
  const deposits = round2(i.deposits);
  const cashouts = round2(i.cashouts);

  if (i.action_pct <= 0 || i.action_pct > 100) {
    return { ok: false, error: `Part d'action de ${i.action_pct} % hors bornes — le règlement BR ne concerne que les joueurs stakés.` };
  }

  const result = round2((i.br_close + cashouts) - (i.br_open + deposits));
  const actionAmount = round2((result * i.action_pct) / 100);
  // Il n'y a versement QUE si je dois. S'il a gagné, il me doit : rien ne part de
  // chez moi, la dette vit dans le règlement et se paie par le hub /payments.
  const transfer = actionAmount < -EPS ? -actionAmount : 0;

  return {
    ok: true,
    value: {
      result,
      action_amount: actionAmount,
      transfer_amount: transfer,
      next_br_open: round2(i.br_close),
      // Arrondi : les deux termes le sont déjà, mais l'addition de deux flottants
      // au centime peut rendre 864.5900000000001.
      br_after_transfer: round2(i.br_close + transfer),
    },
  };
}

/**
 * BR de début reprise de la semaine précédente : SA BR DE FIN, et rien d'autre.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ON NE REPORTE PAS LE VERSEMENT. C'est contre-intuitif — la règle d'Hugo dit
 * « BR de début = BR fin + mon versement » — et pourtant c'est ce qui la rend
 * vraie dans tous les cas au lieu d'un seul.
 *
 * Le versement ne part pas au verrouillage : le règlement reste 'locked' et
 * l'argent bouge plus tard (arbitrage Hugo). L'ajouter ici reviendrait à
 * SUPPOSER qu'il a eu lieu. Si la semaine suivante est clôturée avant le
 * paiement, la BR de départ est alors surévaluée du montant du versement, le
 * résultat de cette semaine est négatif d'autant, et le moteur produit UNE
 * SECONDE DETTE POUR LA MÊME PERTE — qui se compose semaine après semaine.
 * Démontré : 486,60 non payé → seconde part d'action de 145,98 sortie de nulle
 * part. (Constat money-auditor, passe 3 ; c'est le correctif du versement-au-
 * paiement qui avait ouvert ce trou.)
 *
 * Le versement compte donc là où il compte vraiment : comme un DÉPÔT de
 * bankroll, dans la semaine de sa date de paiement réelle (cf. getWeekMovementsOn).
 * Le modèle devient auto-correcteur — payé tôt ou tard, l'argent est compté une
 * fois, dans la bonne semaine — et rien ne bloque jamais la clôture.
 *
 * La règle d'Hugo reste vraie comme DESCRIPTION de sa bankroll après paiement :
 * c'est `br_after_transfer`, affiché, jamais calculé.
 * ─────────────────────────────────────────────────────────────────────────────
 */
export function carriedBrOpen(prev: { br_close: number }): number {
  return round2(prev.br_close);
}

// ── Lecture d'un montant de bankroll saisi ou transcrit ───────────────────
//
// Le format d'une photo de BR n'est pas celui du report d'affiliation : pas de $,
// pas d'en-tête, un seul nombre, et un séparateur décimal qui peut être le point
// (377.99) ou la virgule (377,99) selon la locale de l'app du joueur.
//
// parseAmount de ./affiliate-screenshot ne convient PAS ici : il traite toute
// virgule comme un séparateur de milliers, donc « 377,99 » y deviendrait 37799.
// Un facteur 100 sur une bankroll, en silence. On écrit donc une lecture dédiée
// qui TRANCHE l'ambiguïté ou REFUSE, jamais ne devine.

export type AmountRead = { ok: true; value: number } | { ok: false; reason: string };

/**
 * « 377.99 » · « 377,99 » · « 1,234.56 » · « 1.234,56 » · « $864.59 » → nombre.
 * « 1,234 » → REFUS : mille deux cent trente-quatre ou un virgule deux trois quatre ?
 *
 * La règle : quand les deux séparateurs sont présents, le DERNIER est le
 * décimal. Quand un seul l'est, il n'est décimal que s'il est suivi d'exactement
 * deux chiffres — un groupe de trois est un séparateur de milliers. Tout le
 * reste est un rejet nommé, et le champ repasse en saisie manuelle.
 */
export function parseBankrollAmount(raw: string | number | null | undefined): AmountRead {
  if (raw === null || raw === undefined) {
    return { ok: false, reason: "montant illisible sur la photo — à saisir à la main" };
  }
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return { ok: false, reason: `nombre non fini : ${raw}` };
    return isCentExact(raw) ? { ok: true, value: raw } : { ok: false, reason: `${raw} : deux décimales maximum` };
  }

  const s = String(raw).trim().replace(/[\s  ]/g, "").replace(/\$/g, "").replace(/USDT/gi, "");
  if (s === "") return { ok: false, reason: "montant vide" };
  if (!/^[+-]?[\d.,]+$/.test(s)) return { ok: false, reason: `montant illisible : « ${String(raw).trim()} »` };

  const neg = s.startsWith("-");
  const body = s.replace(/^[+-]/, "");
  const lastDot = body.lastIndexOf("."), lastComma = body.lastIndexOf(",");

  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Les deux : le dernier est le décimal, l'autre sépare les milliers.
    const dec = Math.max(lastDot, lastComma);
    normalized = body.slice(0, dec).replace(/[.,]/g, "") + "." + body.slice(dec + 1);
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = body.split(sep);
    if (parts.length > 2) {
      // « 1.234.567 » : trois groupes, aucun décimal possible — que des milliers.
      if (parts.slice(1).every(p => p.length === 3)) normalized = parts.join("");
      else return { ok: false, reason: `montant illisible : « ${String(raw).trim()} »` };
    } else if (parts[1].length === 2) {
      normalized = parts[0] + "." + parts[1];           // 377,99 → décimal
    } else if (parts[1].length === 3) {
      return { ok: false, reason: `« ${String(raw).trim()} » ambigu : ${parts[1]} peut être des milliers ou des décimales — saisis-le à la main` };
    } else if (parts[1].length === 1) {
      normalized = parts[0] + "." + parts[1];           // 377,9 → décimal, sans ambiguïté
    } else {
      return { ok: false, reason: `montant illisible : « ${String(raw).trim()} »` };
    }
  } else {
    normalized = body;
  }

  if (!/^\d+(\.\d+)?$/.test(normalized)) {
    return { ok: false, reason: `montant illisible : « ${String(raw).trim()} »` };
  }
  const n = Number(normalized) * (neg ? -1 : 1);
  if (!Number.isFinite(n)) return { ok: false, reason: `montant illisible : « ${String(raw).trim()} »` };
  if (!isCentExact(n)) return { ok: false, reason: `« ${String(raw).trim()} » : deux décimales maximum` };
  return { ok: true, value: n };
}
