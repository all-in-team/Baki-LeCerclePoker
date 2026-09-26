// Validation du HTML Telegram (parse_mode "HTML") — module PUR, importé aussi
// par l'écran pour l'aperçu. Aucun import : ne doit tirer ni base ni Node.
//
// Pourquoi valider avant Telegram : un 400 « can't parse entities » ne se voit
// qu'à l'envoi, et il frapperait tous les destinataires à l'identique. Le moteur
// met alors la diffusion en pause, mais le dire à la saisie est mieux.
//
// Règles (Bot API, « HTML style ») :
//  • balises admises : b strong i em u ins s strike del span.tg-spoiler
//    tg-spoiler a[href] tg-emoji[emoji-id] code pre blockquote[expandable] ;
//  • un « < » qui n'ouvre pas une balise doit être écrit &lt; — Telegram
//    refuserait le message. « & » et « > » isolés sont acceptés tels quels par
//    Telegram (tdlib les garde littéraux) : on les accepte aussi ;
//  • entités nommées limitées à &lt; &gt; &amp; &quot;, plus les numériques.
//
// L'arbre rendu sert à l'aperçu : l'écran le rend en React, jamais via
// innerHTML — seules les balises ci-dessus peuvent donc y apparaître.

export type HtmlNode =
  | { type: "text"; text: string }
  | { type: "el"; tag: string; attrs: Record<string, string>; children: HtmlNode[] };

export interface HtmlCheck {
  ok: boolean;
  errors: string[];
  nodes: HtmlNode[];
  /** Longueur du texte VISIBLE (balises retirées, entités décodées), en unités UTF-16. */
  visibleLength: number;
}

export const TELEGRAM_TEXT_LIMIT = 4096;

const SIMPLE_TAGS = new Set(["b", "strong", "i", "em", "u", "ins", "s", "strike", "del", "tg-spoiler"]);
const ALL_TAGS = new Set([...SIMPLE_TAGS, "span", "a", "tg-emoji", "code", "pre", "blockquote"]);

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"' };

function decodeEntity(raw: string): string | null {
  const m = /^&(?:(lt|gt|amp|quot)|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));$/.exec(raw);
  if (!m) return null;
  if (m[1]) return NAMED[m[1]];
  const cp = m[2] ? parseInt(m[2], 10) : parseInt(m[3], 16);
  if (!Number.isFinite(cp) || cp > 0x10ffff) return null;
  try { return String.fromCodePoint(cp); } catch { return null; }
}

function parseAttrs(src: string): Record<string, string> | null {
  const attrs: Record<string, string> = {};
  const re = /\s*([a-zA-Z][a-zA-Z0-9-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/y;
  let i = 0;
  while (i < src.length) {
    if (/^\s*$/.test(src.slice(i))) break;
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m || m[0].length === 0) return null;
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
    i = re.lastIndex;
  }
  return attrs;
}

/** Lien de texte admis par Telegram. Le bouton, lui, a sa propre règle (https seulement). */
function isAllowedHref(href: string): boolean {
  return /^(https?:\/\/|tg:\/\/|mailto:)/i.test(href.trim());
}

export function checkTelegramHtml(input: string): HtmlCheck {
  const errors: string[] = [];
  const root: HtmlNode[] = [];
  const stack: Array<{ tag: string; node: Extract<HtmlNode, { type: "el" }> }> = [];
  let visible = 0;
  let text = "";

  const current = () => (stack.length ? stack[stack.length - 1].node.children : root);
  const flush = () => {
    if (!text) return;
    current().push({ type: "text", text });
    visible += text.length;
    text = "";
  };

  let i = 0;
  while (i < input.length) {
    const ch = input[i];

    if (ch === "&") {
      const m = /^&[#a-zA-Z0-9]{1,10};/.exec(input.slice(i, i + 12));
      const decoded = m ? decodeEntity(m[0]) : null;
      if (!m || decoded === null) {
        // Littéral pour Telegram : « Q&A » passe tel quel.
        text += "&";
        i++;
        continue;
      }
      text += decoded;
      i += m[0].length;
      continue;
    }

    if (ch !== "<") {
      text += ch;
      i++;
      continue;
    }

    // Attributs : un « > » entre guillemets ne ferme pas la balise (href="…a>b").
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:[^<>"']|"[^"]*"|'[^']*')*)>/.exec(input.slice(i));
    if (!m) {
      errors.push(`« < » isolé (position ${i + 1}) : écris &lt; à la place`);
      text += "<";
      i++;
      continue;
    }
    flush();
    const closing = m[1] === "/";
    const tag = m[2].toLowerCase();
    i += m[0].length;

    if (!ALL_TAGS.has(tag)) {
      errors.push(`Balise <${tag}> non supportée par Telegram`);
      continue;
    }

    if (closing) {
      const top = stack[stack.length - 1];
      if (!top) {
        errors.push(`</${tag}> fermée sans avoir été ouverte`);
      } else if (top.tag !== tag) {
        errors.push(`</${tag}> ferme <${top.tag}> : balises croisées`);
      } else {
        stack.pop();
      }
      continue;
    }

    const attrs = parseAttrs(m[3]);
    if (attrs === null) {
      errors.push(`Attributs illisibles dans <${tag}>`);
      continue;
    }
    const keys = Object.keys(attrs);
    const parentTags = stack.map(s => s.tag);

    if (SIMPLE_TAGS.has(tag) && keys.length) errors.push(`<${tag}> n'accepte aucun attribut`);
    if (tag === "span" && !(keys.length === 1 && attrs.class === "tg-spoiler")) {
      errors.push(`<span> n'est admis que sous la forme <span class="tg-spoiler">`);
    }
    if (tag === "a") {
      if (!attrs.href) errors.push("<a> sans href");
      else if (!isAllowedHref(attrs.href)) errors.push(`Lien refusé : ${attrs.href} (http://, https://, tg:// ou mailto:)`);
    }
    if (tag === "tg-emoji" && !/^\d+$/.test(attrs["emoji-id"] ?? "")) {
      errors.push(`<tg-emoji> exige un emoji-id numérique`);
    }
    if (tag === "code" && keys.length && !(keys.length === 1 && /^language-[\w+-]+$/.test(attrs.class ?? "") && parentTags[parentTags.length - 1] === "pre")) {
      errors.push(`<code class="language-…"> n'est admis que directement dans <pre>`);
    }
    if (tag === "pre" && keys.length) errors.push(`<pre> n'accepte aucun attribut`);
    if (tag === "blockquote") {
      if (keys.some(k => k !== "expandable")) errors.push(`<blockquote> n'accepte que l'attribut expandable`);
      if (parentTags.includes("blockquote")) errors.push(`<blockquote> ne peut pas être imbriqué`);
    }
    if ((parentTags.includes("pre") || parentTags.includes("code")) && !(tag === "code" && parentTags[parentTags.length - 1] === "pre")) {
      errors.push(`<${tag}> ne peut pas apparaître dans <pre> ou <code>`);
    }

    const node: Extract<HtmlNode, { type: "el" }> = { type: "el", tag, attrs, children: [] };
    current().push(node);
    stack.push({ tag, node });
  }
  flush();

  for (const s of stack.reverse()) errors.push(`<${s.tag}> jamais fermée`);

  if (visible > TELEGRAM_TEXT_LIMIT) {
    errors.push(`Message trop long : ${visible} caractères visibles, maximum ${TELEGRAM_TEXT_LIMIT}`);
  }
  if (visible === 0 || /^\s*$/.test(collectText(root))) errors.push("Message vide");

  return { ok: errors.length === 0, errors, nodes: root, visibleLength: visible };
}

function collectText(nodes: HtmlNode[]): string {
  return nodes.map(n => n.type === "text" ? n.text : collectText(n.children)).join("");
}
