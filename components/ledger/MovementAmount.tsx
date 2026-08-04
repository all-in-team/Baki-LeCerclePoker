/**
 * Couleur des mouvements de wallet — LA convention du repo, en un seul endroit.
 *
 *   DÉPÔT   = ROUGE      RETRAIT = VERT
 *
 * C'est l'inverse de l'usage courant, et c'est assumé : c'est ce qui est acté
 * sur le back-office. Ne pas « corriger » sans arbitrage de Baki.
 *
 * Cette convention n'existait qu'en UNE copie en dur (SettlementFlow.tsx, bouton
 * de type de transaction manuelle). Elle est extraite ici pour qu'un troisième
 * écran ne réinvente pas sa propre couleur — et SettlementFlow consomme
 * désormais ce module.
 *
 * Arrondi à la frontière d'affichage uniquement (invariant #9) ; les comparaisons
 * de flottants passent par un epsilon, jamais par `=== 0`.
 */

export const MOVEMENT_COLOR = {
  deposit: "#F87171",
  withdrawal: "var(--green)",
} as const;

export const NEUTRAL = "#8888A0";
/** Sous ce seuil, un solde est « nul » à l'affichage — jamais de `=== 0` sur un REAL. */
const EPS = 0.005;

export function movementColor(type: "deposit" | "withdrawal"): string {
  return MOVEMENT_COLOR[type];
}

/**
 * Couleur d'un solde net (Σ retraits − Σ dépôts).
 *
 * Il suit la MÊME convention que les mouvements qui le composent : un net
 * négatif est dominé par les dépôts, donc ROUGE ; un net positif est dominé par
 * les retraits, donc VERT. C'est volontairement l'inverse du réflexe
 * « négatif = rouge parce que c'est une perte ».
 */
export function netColor(value: number): string {
  if (Math.abs(value) < EPS) return NEUTRAL;
  return value < 0 ? MOVEMENT_COLOR.deposit : MOVEMENT_COLOR.withdrawal;
}

export function isZeroAmount(value: number): boolean {
  return Math.abs(value) < EPS;
}
