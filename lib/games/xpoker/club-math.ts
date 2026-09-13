// XPoker Twd — MATH D'ARGENT, pure. Aucun import, aucun arrondi.
//
// Tout est en chips. L'arrondi se fait à l'AFFICHAGE et sur le montant réglé,
// jamais ici : le sheet garde 4 décimales sur ses intermédiaires et les deux cas
// d'acceptation du brief (§4) doivent retomber au 1/100 de centime.
//
// ─────────────────────────────────────────────────────────────────────────────
// RÈGLE DE SIGNE DE LA PART D'ACTION — confirmée par Baki le 2026-09-13.
//
//   part d'action = action_pct × winloss du joueur, DU POINT DE VUE AGENCE.
//
//   joueur gagne 1000 → action 10 % = +100 → LE JOUEUR ME DOIT 100
//   joueur perd  1000 → action 10 % = −100 → JE DOIS 100 AU JOUEUR
//
// Symétrique et sans exception : je prends ma part de ses gains, je couvre ma
// part de ses pertes. Pas de plancher à zéro, pas de makeup, pas de traitement
// différent selon le signe. C'est la convention de manual_settlements et du hub
// /payments (due > 0 = « Il nous doit », vert · due < 0 = « On lui doit », rouge).
//
// Cas de référence (semaine à 3 joueurs, action 10 %, onglet 7/20) :
//   4107823  wl = +14053,56 → +1405,356 → il me doit 1405,356
//   4136708  wl = −11722,87 → −1172,287 → je lui dois 1172,287
//   3062825  wl = −31267,4  → −3126,74  → je lui dois 3126,74
// Ces trois lignes coexistent la même semaine où le règlement CLUB est de
// +9115,0755 : deux flux distincts (le club me règle en chips ; je règle chaque
// joueur sur SON résultat), jamais nettés l'un contre l'autre.
//
// Et avec XPoker HORS compensation inter-rooms (Baki Q1) : un joueur qui me doit
// 1405 chips XPoker et à qui je dois 300 USDT sur KKPOKER, ce sont DEUX lignes
// dans /payments, jamais un net de 1105.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// DEUX UNITÉS, DEUX NOMS — jamais le même mot pour les deux (R2, 2026-09-13) :
//   *_fraction : taux du SHEET, 0.8 pour 80 %   (ClubParams, xpoker_imports)
//   *_pct      : taux du DEAL, 10 pour 10 %      (xpoker_player_deals, actionShareChips…)
// Les gardes ci-dessous refusent l'unité inverse à l'EXÉCUTION : une fraction > 1
// n'existe pas, un pourcent dans ]0, 1[ est une fraction déguisée. Une validation
// d'écran se contourne ; celles-ci, non.
// ─────────────────────────────────────────────────────────────────────────────

/** Taux du bloc, en FRACTIONS (0.8 pour 80 %), tels que lus dans le fichier. */
export type ClubParams = { rb_fraction: number; tax_fraction: number };

export function assertFraction(v: number, what: string): void {
  if (!(Number.isFinite(v) && v >= 0 && v <= 1)) throw new Error(`${what} : fraction attendue dans [0, 1], reçu ${v} — un pourcent (${v} %) n'a rien à faire ici`);
}
export function assertPct(v: number, what: string): void {
  if (!Number.isFinite(v) || v < 0 || v > 100) throw new Error(`${what} : pourcent attendu dans [0, 100], reçu ${v}`);
  if (v > 0 && v < 1) throw new Error(`${what} : ${v} ressemble à une fraction (${v * 100} %) — les deals sont en POURCENT (10 = 10 %)`);
}

export type ClubSettlement = {
  total_winloss: number;
  total_rake: number;
  /** 反水% × Σrake — ce que le club reverse sur le rake. */
  rb: number;
  /** TAX% × (−Σwinlose − Σrake) — SIGNÉ : négatif quand les joueurs gagnent, il se déduit. */
  tax: number;
  /** rb + tax. Ce que le club règle (en chips) — avant confirmation par Baki. */
  total: number;
};

/**
 * Règlement club, formule confirmée sur 2 jeux de données puis 18 onglets :
 *   total = rb% × Σrake + tax% × (−Σwinlose − Σrake)
 * L'expression est implémentée TELLE QUELLE : pas de valeur absolue, pas de
 * plancher à zéro, pas de branche selon le signe. (Dans le sheet : U20 =
 * (U18+U19) × −5 %, U21 = U19 × C2, U22 = U21 + U20.)
 *
 * Les lignes passées ici sont TOUTES les lignes du bloc que le club additionne
 * (agence et sous-agent comprises) — sinon le checksum ne peut pas retomber.
 */
export function clubSettlement(rows: { winloss: number; rake: number }[], p: ClubParams): ClubSettlement {
  assertFraction(p.rb_fraction, "rb_fraction"); assertFraction(p.tax_fraction, "tax_fraction");
  let total_winloss = 0, total_rake = 0;
  for (const r of rows) { total_winloss += r.winloss; total_rake += r.rake; }
  const rb = p.rb_fraction * total_rake;
  const tax = p.tax_fraction * (-total_winloss - total_rake);
  return { total_winloss, total_rake, rb, tax, total: rb + tax };
}

/**
 * Part d'action d'UNE ligne, sur SON win/lose — jamais un % appliqué au total du
 * bloc puis réparti. Signe : voir la règle en tête de fichier — POSITIF = le joueur
 * doit à l'agence (il a gagné), NÉGATIF = l'agence lui doit (il a perdu).
 */
export function actionShareChips(winloss: number, action_pct: number): number {
  assertPct(action_pct, "action_pct");
  return (action_pct / 100) * winloss;
}

/** Rakeback dû au joueur sur SON rake (donnée interne, jamais notifiée). Toujours ≥ 0. */
export function rakebackChips(rake: number, rb_pct: number): number {
  assertPct(rb_pct, "rb_pct");
  return (rb_pct / 100) * rake;
}

/**
 * Dû net d'une semaine pour un joueur : sa part d'action moins son rakeback.
 * POSITIF = il doit à l'agence, NÉGATIF = l'agence lui doit.
 */
export function weekDueChips(winloss: number, rake: number, action_pct: number, rb_pct: number): number {
  return actionShareChips(winloss, action_pct) - rakebackChips(rake, rb_pct);
}

/** Équivalent USD — AFFICHAGE SEULEMENT, jamais un montant à payer (Baki Q1/Q1bis). */
export function chipsToUsd(chips: number, chipsPerUsd: number): number {
  if (!(chipsPerUsd > 0)) throw new Error(`taux chips/USD invalide : ${chipsPerUsd}`);
  return chips / chipsPerUsd;
}

/** Égalité « au centime » : la seule comparaison de flottants autorisée ici. */
export function withinTolerance(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) <= tolerance;
}
