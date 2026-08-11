// Parseur des notifications du club @dzpk.
//
// Module PUR : pas de DB, pas de réseau, pas de process.env. La configuration
// (agent, libellé du club) est passée en argument. C'est ce qui permet de le
// tester exhaustivement sur les chaînes réelles, et de rejouer un parseur
// corrigé sur l'historique brut sans rien d'autre.
//
// ┌─ RÈGLE QUI PRIME SUR TOUT ─────────────────────────────────────────────────┐
// │ Un message non reconnu n'est JAMAIS jeté : il ressort en `unparsed` avec sa │
// │ raison, et il est compté à l'écran. Le club changera ses gabarits un jour ; │
// │ ce jour-là, l'anomalie doit être visible en quelques heures, pas se         │
// │ découvrir en constatant que le revenu attribué a fondu.                     │
// └─────────────────────────────────────────────────────────────────────────────┘

import { decoratedEquals, nameKey, nameKeyTight } from "./name-key";

export type ClubEventKind = "join" | "bound" | "commission" | "banned" | "unparsed";

export interface ParserConfig {
  /** Identifiant de l'agent dans le club, ex. "🍓". */
  agentName: string | null;
  /** Libellé du club, ex. "德州扑克 ♠️❤️ @dzpk". Facultatif — ancre de repli sinon. */
  clubLabel: string | null;
}

export interface ParsedNotification {
  kind: ClubEventKind;
  /** Nom du joueur, EXACTEMENT tel qu'écrit par le club. Jamais découpé. */
  playerNameRaw: string | null;
  /** Clé d'appariement dérivée du nom. */
  nameKey: string | null;
  nameKeyTight: string | null;
  /** Agent tel que reçu. `null` sur le gabarit « join », qui n'en porte pas. */
  agentNameRaw: string | null;
  /**
   * L'agent de ce message est-il le nôtre ?
   *  true  — filtre passé
   *  false — notification d'un AUTRE agent : à ne surtout pas s'attribuer
   *  null  — indéterminable (gabarit sans champ agent, ou agent non configuré)
   */
  agentIsMine: boolean | null;
  /** Gabarit 3 uniquement. */
  commission: ParsedCommission | null;
  /** Renseigné quand kind === "unparsed". */
  reason: string | null;
}

export interface ParsedCommission {
  requestedRaw: string;
  requestedAmount: number;
  paidRaw: string;
  paidAmount: number;
  currency: string;
}

/** Version du parseur, estampillée sur chaque message ingéré (rejeu, audit). */
export const PARSER_VERSION = 1;

// ── Marqueurs ─────────────────────────────────────────────
// Volontairement les formes LONGUES et distinctives. `绑定` seul apparaît aussi
// dans le gabarit « join » (« …即可绑定推广关系 ») : s'en contenter classerait
// un join en rattachement, donc en revenu.
const M_BOUND = "已绑定为代理";
const M_JOIN = "已进群";
const M_COMMISSION = "申请的分佣";
const M_BANNED_A = "已被封号";
const M_BANNED_B = "冻结";
const M_FIRST_GAME = "首次进入俱乐部游戏";
const M_PLAYER = "玩家";
const M_PROMOTED_USER = "推广的用户";
const M_AGENT = "代理";
const M_PAID = "已实际支付";

function unparsed(reason: string): ParsedNotification {
  return {
    kind: "unparsed", playerNameRaw: null, nameKey: null, nameKeyTight: null,
    agentNameRaw: null, agentIsMine: null, commission: null, reason,
  };
}

/** Texte entre deux bornes d'index, nettoyé de ses espaces de bord. */
function slice(text: string, from: number, to: number): string {
  return text.slice(from, to).trim();
}

/**
 * Convertit un montant en nombre, ou `null` si la forme n'est pas certaine.
 *
 * On normalise UNIQUEMENT les chiffres et le point pleine chasse — pas le texte
 * entier. Un NFKC global transformerait la virgule idéographique `，`, qui sépare
 * les propositions de la phrase, en virgule ASCII : le montant `811.62896` suivi
 * de `，俱乐部…` deviendrait un nombre à rallonge.
 *
 * Aucune tolérance au doute : une forme inattendue rend `null`, ce qui fait
 * basculer le message entier en `unparsed`. Sur de l'argent, un montant deviné
 * est pire qu'un montant manquant — le second se voit, le premier se comptabilise.
 */
export function parseAmount(raw: string): number | null {
  const s = raw
    .replace(/[０-９]/g, d => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".")
    .trim();

  // ⚠️ AUCUNE tolérance à la virgule, même en groupes de 3.
  //
  // Interpréter "811,628" comme un séparateur de milliers rend 811628 ; comme
  // un séparateur décimal, 811.628. Un facteur 1000 d'écart, et rien dans la
  // chaîne ne permet de trancher. C'était la SEULE branche capable de produire
  // un montant faux plutôt qu'un refus (audit money du 2026-08-12, F5).
  //
  // Aucun échantillon réel du club n'utilise de séparateur de milliers. Si ça
  // change un jour, le message tombera en `unparsed`, donc visible dans l'écran
  // en quelques heures — ce qui est exactement la doctrine annoncée en tête de
  // fichier : un montant deviné se comptabilise, un montant manquant se voit.
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Extrait le nom du joueur du gabarit « rattaché ».
 *
 * Deux ancres droites possibles, par ordre de force :
 *   1. le libellé du club — le plus sûr ;
 *   2. à défaut, le DERNIER `从` situé avant « 首次进入俱乐部游戏 ».
 *
 * Le repli n°2 est correct même quand le nom contient lui-même `从` : dans
 * « 玩家 从容 从 <club> 俱乐部 首次进入… », le dernier `从` avant le marqueur est
 * bien le séparateur, pas celui du prénom. Prendre le PREMIER couperait le nom.
 */
function extractBoundName(text: string, clubLabel: string | null): { name: string | null; reason?: string } {
  const startIdx = text.indexOf(M_PLAYER);
  if (startIdx === -1) return { name: null, reason: "marqueur 玩家 absent" };
  const nameFrom = startIdx + M_PLAYER.length;

  if (clubLabel) {
    const anchor = text.indexOf(`从 ${clubLabel}`, nameFrom);
    const anchorTight = anchor === -1 ? text.indexOf(`从${clubLabel}`, nameFrom) : anchor;
    if (anchorTight !== -1) return { name: slice(text, nameFrom, anchorTight) };
  }

  const gameIdx = text.indexOf(M_FIRST_GAME);
  if (gameIdx === -1) return { name: null, reason: "ni libellé de club ni marqueur 首次进入俱乐部游戏" };
  const sepIdx = text.lastIndexOf("从", gameIdx);
  if (sepIdx === -1 || sepIdx < nameFrom) return { name: null, reason: "séparateur 从 introuvable" };
  return { name: slice(text, nameFrom, sepIdx) };
}

/**
 * Point d'entrée unique.
 *
 * `text` est le message BRUT, jamais pré-normalisé par l'appelant : toute
 * transformation en amont serait invisible dans le stockage et rendrait le
 * rejeu du parseur non reproductible.
 */
export function parseClubNotification(text: string, cfg: ParserConfig): ParsedNotification {
  if (!text || !text.trim()) return unparsed("message vide");
  const t = text.trim();

  const withAgent = (agentRaw: string | null): boolean | null => {
    if (!agentRaw || !cfg.agentName) return null;
    return decoratedEquals(agentRaw, cfg.agentName);
  };
  const named = (kind: ClubEventKind, name: string, agentRaw: string | null): ParsedNotification => ({
    kind,
    playerNameRaw: name,
    nameKey: nameKey(name),
    nameKeyTight: nameKeyTight(name),
    agentNameRaw: agentRaw,
    agentIsMine: withAgent(agentRaw),
    commission: null,
    reason: null,
  });

  // ── Gabarit 2 — RATTACHÉ. Testé en premier : c'est le seul qui engage du
  // revenu, et le gabarit 1 contient « 绑定推广关系 », assez proche pour qu'un
  // ordre inverse et un marqueur trop court les confondent.
  if (t.includes(M_BOUND)) {
    const { name, reason } = extractBoundName(t, cfg.clubLabel);
    if (!name) return unparsed(`gabarit rattaché : ${reason}`);

    const aFrom = t.indexOf(M_BOUND) + M_BOUND.length;
    const aTo = t.indexOf("的推广", aFrom);
    if (aTo === -1) return unparsed("gabarit rattaché : borne 的推广 absente");
    const agent = slice(t, aFrom, aTo);
    if (!agent) return unparsed("gabarit rattaché : agent vide");

    return named("bound", name, agent);
  }

  // ── Gabarit 1 — JOIN. AUCUN champ agent : `agentIsMine` reste null.
  // Ce n'est pas une négligence de parsing, c'est une propriété du message ;
  // l'appartenance est présumée du canal (DM privé de l'agent), pas prouvée.
  if (t.includes(M_JOIN)) {
    const startIdx = t.indexOf(M_PLAYER);
    if (startIdx === -1) return unparsed("gabarit join : marqueur 玩家 absent");
    const nameFrom = startIdx + M_PLAYER.length;
    const joinIdx = t.indexOf(M_JOIN, nameFrom);
    if (joinIdx === -1) return unparsed("gabarit join : marqueur 已进群 mal placé");
    const name = slice(t, nameFrom, joinIdx);
    if (!name) return unparsed("gabarit join : nom vide");
    return named("join", name, null);
  }

  // ── Gabarit 3 — COMMISSION. Niveau agent, aucun joueur.
  //
  // Reconnaissance STRICTE, ancrée en début de message. Deux pièges que la
  // version tolérante laissait passer en silence (audit money du 2026-08-12) :
  //
  //   • « 尊敬的代理，代理 🍓 申请的分佣… » : un `indexOf` sur 代理 capturait
  //     « ，代理 🍓 » comme nom d'agent, donc NOTRE commission était écartée
  //     comme étrangère. Sous-comptage muet.
  //   • Un message groupant deux paiements : seul le premier était lu, le
  //     second disparaissait sans laisser de trace.
  //
  // Passer en `lastIndexOf` aurait été pire : « 代理 🍔 的上级代理 🍓 申请的分佣 »
  // nous aurait attribué la commission d'un autre. On refuse et on rend visible.
  if (t.includes(M_COMMISSION)) {
    if (t.indexOf(M_COMMISSION) !== t.lastIndexOf(M_COMMISSION)) {
      return unparsed("gabarit commission : plusieurs paiements dans un même message");
    }
    if (t.indexOf(M_PAID) !== t.lastIndexOf(M_PAID)) {
      return unparsed("gabarit commission : plusieurs montants payés dans un même message");
    }

    const head = /^\s*代理\s*(\S.*?)\s*申请的分佣/.exec(t);
    if (!head) return unparsed("gabarit commission : en-tête inattendu (le message ne commence pas par 代理)");
    const agent = head[1].trim();
    if (!agent) return unparsed("gabarit commission : agent vide");

    const req = /申请的分佣\s*([0-9０-９.,．]+)\s*([A-Za-z]{2,10})/.exec(t);
    const paid = /已实际支付\s*([0-9０-９.,．]+)\s*([A-Za-z]{2,10})/.exec(t);
    if (!req) return unparsed("gabarit commission : montant demandé illisible");
    if (!paid) return unparsed("gabarit commission : montant payé illisible");

    const requestedAmount = parseAmount(req[1]);
    const paidAmount = parseAmount(paid[1]);
    if (requestedAmount === null) return unparsed(`gabarit commission : montant demandé non numérique (${req[1]})`);
    if (paidAmount === null) return unparsed(`gabarit commission : montant payé non numérique (${paid[1]})`);

    // Deux devises différentes dans une même notification : on ne convertit
    // rien et on ne choisit pas. Invariant #3 — jamais d'agrégat inter-devises.
    const cur = req[2].toUpperCase();
    if (cur !== paid[2].toUpperCase()) {
      return unparsed(`gabarit commission : devises incohérentes (${req[2]} / ${paid[2]})`);
    }

    return {
      kind: "commission",
      playerNameRaw: null, nameKey: null, nameKeyTight: null,
      agentNameRaw: agent,
      agentIsMine: withAgent(agent),
      commission: {
        // Les chaînes brutes sont la source de vérité : les REAL servent aux
        // agrégats, elles ne remplacent pas ce que le club a réellement écrit.
        requestedRaw: req[1], requestedAmount,
        paidRaw: paid[1], paidAmount,
        currency: cur,
      },
      reason: null,
    };
  }

  // ── Gabarit 4 — BANNI.
  if (t.includes(M_BANNED_A) || t.includes(M_BANNED_B)) {
    const uFrom = t.indexOf(M_PROMOTED_USER);
    if (uFrom === -1) return unparsed("gabarit banni : marqueur 推广的用户 absent");
    const nameFrom = uFrom + M_PROMOTED_USER.length;
    let nameTo = t.indexOf(M_BANNED_A, nameFrom);
    if (nameTo === -1) nameTo = t.indexOf(M_BANNED_B, nameFrom);
    if (nameTo === -1) return unparsed("gabarit banni : borne de fin absente");
    const name = slice(t, nameFrom, nameTo);
    if (!name) return unparsed("gabarit banni : nom vide");

    const agentFrom = t.indexOf(M_AGENT);
    const agent = agentFrom !== -1 && agentFrom < uFrom
      ? slice(t, agentFrom + M_AGENT.length, uFrom)
      : null;

    return named("banned", name, agent);
  }

  return unparsed("aucun gabarit reconnu");
}
