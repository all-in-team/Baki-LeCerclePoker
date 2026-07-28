// Socle i18n des funnels — PUR et AGNOSTIQUE : aucune référence à Nexa, QQPK ou
// à un quelconque funnel. Aucun accès DB, aucun import serveur → importable côté
// client comme serveur.
//
// Le copy d'un funnel vit dans son propre fichier (ex. lib/funnels/nexa/copy.ts),
// typé `Record<Lang, XxxCopy>`. Ce module ne fournit que la plomberie : la liste
// des langues, la coercition d'une valeur DB en `Lang`, le clavier du sélecteur
// et le picker de dictionnaire.
//
// ── AJOUTER UNE LANGUE (ex. espagnol) ────────────────────────────────────────
//   1. Ajouter une entrée dans LANGS ci-dessous.
//   2. TypeScript casse alors sur chaque `Record<Lang, XxxCopy>` tant que le bloc
//      `es` manque. C'est VOULU : une erreur de compilation vaut mieux qu'un
//      funnel « espagnol » qui répond en français en silence.
//   3. Rien d'autre à toucher — le sélecteur, le clavier et le prompt se
//      construisent à partir de LANGS.
//
// ── BRANCHER UN AUTRE FUNNEL (ex. QQPK) ──────────────────────────────────────
//   1. Colonne `lang` + `lang_chosen_at` sur sa table de leads.
//   2. `lib/funnels/qqpk/copy.ts` avec `Record<Lang, QqpkCopy>` + `dict(...)`.
//   3. `langKeyboard("qf_lang:")` et un case `qf_lang:` dans son handler de
//      callbacks. Ce fichier ne bouge pas.

/**
 * Langues supportées, dans l'ordre d'affichage du sélecteur.
 * `label` = texte du bouton · `prompt` = sa moitié de la question bilingue.
 */
export const LANGS = [
  { code: "fr", label: "🇫🇷 Français", prompt: "Choisis ta langue" },
  { code: "en", label: "🇬🇧 English", prompt: "Choose your language" },
] as const;

export type Lang = (typeof LANGS)[number]["code"];

/** Langue de repli — celle des leads créés avant l'arrivée du sélecteur. */
export const DEFAULT_LANG: Lang = "fr";

const LANG_CODES: readonly string[] = LANGS.map(l => l.code);

export function isLang(v: unknown): v is Lang {
  return typeof v === "string" && LANG_CODES.includes(v);
}

/**
 * Valeur venue de la DB (ou d'un callback Telegram) → `Lang` sûre.
 * Tout ce qui n'est pas une langue connue retombe sur DEFAULT_LANG : un lead ne
 * reste jamais sans message parce que sa colonne contient une valeur exotique.
 */
export function coerceLang(v: unknown): Lang {
  return isLang(v) ? v : DEFAULT_LANG;
}

/**
 * Question du sélecteur, dans TOUTES les langues à la fois — au moment où on la
 * pose, on ne sait justement pas laquelle le lead parle.
 */
export function langPromptText(): string {
  return `🌍 ${LANGS.map(l => `<b>${l.prompt}</b>`).join(" · ")}`;
}

/**
 * Clavier du sélecteur, une langue par ligne.
 * `prefix` est le préfixe de callback_data du funnel appelant (ex. "nf_lang:"),
 * ce qui évite toute collision entre funnels sur le même bot.
 */
export function langKeyboard(prefix: string): { text: string; callback_data: string }[][] {
  return LANGS.map(l => [{ text: l.label, callback_data: `${prefix}${l.code}` }]);
}

/** Extrait la langue d'un callback `<prefix><code>`, ou null si ce n'en est pas un. */
export function parseLangCallback(data: string, prefix: string): Lang | null {
  if (!data.startsWith(prefix)) return null;
  const code = data.slice(prefix.length);
  return isLang(code) ? code : null;
}

/**
 * Dictionnaire → sélecteur typé. `dict(NEXA_COPY)("en")` rend le bloc anglais.
 * La complétude est garantie à la compilation par `Record<Lang, T>` ; la
 * coercition ne sert qu'aux valeurs venues de la DB.
 */
export function dict<T>(dicts: Record<Lang, T>): (lang: unknown) => T {
  return (lang: unknown) => dicts[coerceLang(lang)];
}

/** Libellé court pour le back-office (badge langue sur la fiche/liste de leads). */
export function langLabel(lang: unknown): string {
  const code = coerceLang(lang);
  return LANGS.find(l => l.code === code)!.label;
}
