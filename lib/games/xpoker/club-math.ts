// XPoker Twd — MATH D'ARGENT, pure. Aucun import, aucun arrondi.
//
// Tout est en chips. L'arrondi se fait à l'AFFICHAGE et sur le montant réglé,
// jamais ici : le sheet garde 4 décimales sur ses intermédiaires et les deux cas
// d'acceptation du brief (§4) doivent retomber au 1/100 de centime.

/** Taux du bloc, en FRACTIONS (0.8 pour 80 %), tels que lus dans le fichier. */
export type ClubParams = { rb_pct: number; tax_pct: number };

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
  let total_winloss = 0, total_rake = 0;
  for (const r of rows) { total_winloss += r.winloss; total_rake += r.rake; }
  const rb = p.rb_pct * total_rake;
  const tax = p.tax_pct * (-total_winloss - total_rake);
  return { total_winloss, total_rake, rb, tax, total: rb + tax };
}

/**
 * Part d'action d'UNE ligne, sur SON win/lose — jamais un % appliqué au total du
 * bloc puis réparti. Convention de signe du repo (manual_settlements, NEXA) :
 * POSITIF = le joueur doit à l'agence (il a gagné), NÉGATIF = l'agence lui verse.
 * Cas §5 : 4107823, +14053.56 à 10 % → +1405.356.
 */
export function actionShareChips(winloss: number, action_pct: number): number {
  return (action_pct / 100) * winloss;
}

/** Rakeback dû au joueur sur SON rake (donnée interne, jamais notifiée). Toujours ≥ 0. */
export function rakebackChips(rake: number, rb_pct: number): number {
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
