// Normalisation des noms pour l'appariement dzpk.
//
// ┌─ POURQUOI PAS `lib/normalize.ts` ──────────────────────────────────────────┐
// │ `normalizeForMatch` applique `[^\w\s]` → tout ce qui n'est pas [A-Za-z0-9_] │
// │ disparaît. Sur des noms chinois, ça rend la CHAÎNE VIDE :                   │
// │                                                                             │
// │     "张伟" → ""      "李娜" → ""      "王小明 🐉" → ""                       │
// │                                                                             │
// │ Réutilisée ici, chaque lead chinois porterait la même clé vide et la        │
// │ première notif venue les matcherait TOUS. C'est le rattachement aveugle de  │
// │ masse, sur de l'argent. D'où ce module, qui conserve le CJK.                │
// └─────────────────────────────────────────────────────────────────────────────┘
//
// Ce module est PUR : aucune DB, aucun réseau, aucune configuration. C'est ce
// qui le rend testable exhaustivement.

/**
 * Retire ce qui est décoratif ou invisible et qui ferait diverger deux formes
 * du même nom : emoji, sélecteurs de variante, ZWJ, teintes de peau, marques
 * directionnelles, espaces de largeur nulle.
 *
 * Ne touche à AUCUN caractère porteur de sens — lettres latines, cyrilliques,
 * idéogrammes, kana, hangul sont conservés tels quels.
 */
export function stripDecorations(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (
      c === 0xfe0f || c === 0xfe0e ||                 // sélecteurs de variante
      c === 0x200d ||                                  // ZWJ
      c === 0x200b || c === 0x200c ||                  // espaces de largeur nulle
      (c >= 0x200e && c <= 0x200f) ||                  // marques directionnelles
      (c >= 0x202a && c <= 0x202e) ||                  // encadrements bidi
      (c >= 0x1f3fb && c <= 0x1f3ff) ||                // teintes de peau
      (c >= 0x1f300 && c <= 0x1faff) ||                // pictogrammes
      (c >= 0x2600 && c <= 0x27bf) ||                  // symboles divers (♠ ♥ ✅…)
      (c >= 0x2b00 && c <= 0x2bff) ||
      (c >= 0xfe00 && c <= 0xfe0f)
    ) continue;
    out += ch;
  }
  return out;
}

/**
 * Clé d'appariement principale.
 *
 * NFKC d'abord : il replie les formes pleine chasse (`ＦＵＮ` → `FUN`) sur leur
 * équivalent demi-chasse, cas courant dans les clients chinois. Appliqué ICI et
 * pas sur le message entier — au niveau du message, NFKC transformerait aussi la
 * virgule idéographique `，` en virgule ASCII et polluerait l'extraction des
 * montants.
 *
 * Les espaces sont RÉDUITS, pas supprimés : `"FUN SEONG"` et `"FUNSEONG"` sont
 * deux clés distinctes. Les coller reviendrait à décider qu'ils désignent la
 * même personne, ce qui n'est pas démontrable.
 */
export function nameKey(raw: string | null | undefined): string {
  if (raw == null) return "";
  return stripDecorations(String(raw).normalize("NFKC"))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Variante sans aucun espace.
 *
 * Réservée à la SUGGESTION de candidats dans l'écran de réconciliation. Jamais
 * utilisée pour un rattachement automatique : l'espacement d'un nom chinois est
 * instable, mais l'ignorer fusionnerait des personnes différentes.
 */
export function nameKeyTight(raw: string | null | undefined): string {
  return nameKey(raw).replace(/\s+/g, "");
}

/**
 * Égalité d'identifiants décoratifs (l'agent 🍓, le libellé du club).
 *
 * `🍓` arrive avec ou sans U+FE0F selon le client émetteur, et `♠️❤️` de même.
 * Une comparaison brute échouerait donc par intermittence — et un filtre agent
 * qui tombe en silence, c'est du revenu attribué à quelqu'un d'autre.
 *
 * On compare sur la forme brute débarrassée des sélecteurs, PAS sur nameKey() :
 * stripDecorations() supprimerait l'emoji en entier, et `🍓` deviendrait `""`,
 * ce qui rendrait tous les agents égaux.
 */
export function decoratedEquals(a: string | null | undefined, b: string | null | undefined): boolean {
  return stripVariationSelectors(a) === stripVariationSelectors(b);
}

/** Retire uniquement les sélecteurs de variante et le ZWJ, en gardant les emoji. */
export function stripVariationSelectors(s: string | null | undefined): string {
  if (s == null) return "";
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfe0f || c === 0xfe0e || c === 0x200d) continue;
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim();
}
