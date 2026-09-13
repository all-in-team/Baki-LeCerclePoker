// Parseur d'une page d'historique OkPay transférée dans Telegram — MODULE PUR.
//
// Aucun accès DB, aucune horloge. Entrée : le texte du message. Sortie : la
// wallet identifiée par l'en-tête, et ses lignes, prêtes pour okpay_ledger_lines.
// Même tuyau pour la main du joueur (qu'il transfère) et pour les OkPay des
// comptes (que Baki transfère depuis leurs sessions) : l'en-tête dit de quelle
// wallet il s'agit, le rattachement se fait en base.
//
// FORMAT — confronté à un VRAI message le 2026-09-13 (fixture dans
// scripts/pool-engine.test.ts). Ce qui a été VU, et rien d'autre, est accepté :
//
//   <Pseudo> Transaction:<telegram_id>          (un seul en-tête, en tête)
//
//   Type: ➕ | ➖                                (EMOJI U+2795 / U+2796 — pas « + », pas « − »)
//   Details: Transfer To : <pseudo>【ID <id>】    (sortant, anglais)
//            轉賬給 : <pseudo>【ID <id>】          (sortant, chinois)
//            Transfer From : <pseudo>【ID <id>】  (entrant, anglais)
//   Amount: 728.9                                (point décimal, jusqu'à 6 décimales)
//   Currency: USDT
//   Changed balance: 1539.817733                 (solde APRÈS — 6 DÉCIMALES, pas le centime)
//   date: 2026-09-13 11:21:10
//
// Les langues se MÉLANGENT dans un même message (anglais et chinois selon la
// ligne). La forme chinoise de l'entrant n'a pas encore été vue : elle n'est PAS
// devinée. Une mention inconnue est un REFUS nommant le bloc — Baki fournit un
// échantillon, on l'ajoute. (Arbitrage Baki 2026-09-13 : « ne devine pas ».)
//
// SIX DÉCIMALES. Les soldes OkPay sont au millionième d'USDT. Le grand livre
// (okpay_ledger_lines) les garde TELS QUELS — c'est un fait, et la chaîne
// solde[n] = solde[n−1] ± montant[n] ne tient qu'à cette précision. L'arrondi au
// centime n'a lieu qu'à la FRONTIÈRE ledger → solde de clôture du pool
// (engine.ts balanceAt().pool_balance), parce que le moteur de règlement travaille
// au centime. Jamais avant.
//
// DOCTRINE : REFUSER plutôt que réparer, comme parseBankrollAmount. Un bloc dont
// le montant ou le solde est illisible fait échouer TOUT le message — une
// ingestion partielle créerait une rupture de chaîne indistinguable de lignes
// réellement manquantes, et le mode audit réclamerait à Baki une page qu'il a
// déjà envoyée. Seule exception : une ligne dans une AUTRE devise que USDT est
// SAUTÉE et signalée — elle appartient à la chaîne d'une autre devise, pas à
// celle-ci (invariant #3 : jamais d'agrégat entre devises).
import { createHash } from "crypto";

export type ParsedOkpayLine = {
  direction: "+" | "-";
  amount: number;
  currency: "USDT";
  balance_after: number;
  /** « YYYY-MM-DD HH:MM:SS », tel que porté par le message. */
  occurred_at: string;
  counterparty_tg_id: string | null;
  counterparty_name: string | null;
  /** Le bloc source, pour okpay_ledger_lines.raw_text. */
  raw_text: string;
  /** sha1(wallet|occurred_at|direction|amount|balance_after) — l'UNIQUE de la table. */
  dedup_key: string;
};

export type OkpaySkipped = { block: number; reason: string };

export type OkpayParseResult =
  | {
      ok: true;
      wallet_tg_id: string;
      wallet_label: string | null;
      lines: ParsedOkpayLine[];
      /** Blocs volontairement écartés (autre devise). Jamais un bloc illisible : lui fait échouer le tout. */
      skipped: OkpaySkipped[];
    }
  | { ok: false; error: string };

// L'en-tête : « <Pseudo> Transaction:<tg_id> ». Deux-points ASCII ou pleine
// largeur, espaces tolérés. Un ID Telegram fait 5 à 15 chiffres en pratique.
const HEADER_RE_ALL = /^(.*?)\s*Transaction\s*[:：]\s*(\d{5,15})\s*$/gim;
// Les mentions VUES. Sens porté par la mention, à confronter au Type.
const DETAILS_OUT_RE = /^(Transfer\s+To|轉賬給)\s*[:：]/i;
const DETAILS_IN_RE = /^(Transfer\s+From)\s*[:：]/i;
// Un nombre OkPay : chiffres, point décimal optionnel, 1 à 6 décimales. Pas de
// séparateur de milliers vu → pas accepté (« 1,150.10 » serait ambigu).
const NUMBER_RE = /^\d+(\.\d{1,6})?$/;
// Une ligne « clé: valeur ». Les clés sont comparées en minuscules, sans espaces.
const KV_RE = /^([A-Za-z][A-Za-z ]*?)\s*[:：]\s*(.*)$/;
// « …【ID 1486389037】 ». Espaces et deux-points optionnels entre ID et le nombre.
const COUNTERPARTY_RE = /【\s*ID\s*[:：]?\s*(\d{5,15})\s*】/;
const DATE_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/** Le sens : ➕ (U+2795) ou ➖ (U+2796), avec ou sans sélecteur de variante U+FE0F. Rien d'autre. */
function parseDirection(raw: string): "+" | "-" | null {
  const s = raw.trim().replace(/\uFE0F/g, "");
  if (s === "\u2795") return "+";
  if (s === "\u2796") return "-";
  return null;
}

export type NumberRead = { ok: true; value: number } | { ok: false; reason: string };

/** « 728.9 » · « 1539.817733 » · « 550 » → nombre. Tout autre forme → refus nommé. */
export function parseOkpayNumber(raw: string): NumberRead {
  const s = raw.trim();
  if (!NUMBER_RE.test(s)) {
    return { ok: false, reason: `« ${s} » : attendu des chiffres avec au plus 6 décimales, point décimal, sans séparateur de milliers` };
  }
  const n = Number(s);
  return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: `« ${s} » : nombre non fini` };
}

/** « 轉賬給 : Bob【ID 987654321】 » → { id: "987654321", name: "Bob" }. Sans 【ID】 : id null, name = tout. */
export function parseCounterparty(details: string): { id: string | null; name: string | null } {
  const m = COUNTERPARTY_RE.exec(details);
  const beforeBracket = m ? details.slice(0, m.index) : details;
  // Le pseudo suit le premier « : » de la mention (« 轉賬給 : X », « Transfer From : X »).
  const colon = beforeBracket.search(/[:：]/);
  const name = (colon >= 0 ? beforeBracket.slice(colon + 1) : beforeBracket).trim();
  return { id: m ? m[1] : null, name: name === "" ? null : name };
}

export function okpayDedupKey(walletTgId: string, l: Pick<ParsedOkpayLine, "occurred_at" | "direction" | "amount" | "balance_after">): string {
  // toFixed(6) : la précision du grand livre. Au centime, deux soldes distincts
  // au millionième se confondraient.
  return createHash("sha1")
    .update([walletTgId, l.occurred_at, l.direction, l.amount.toFixed(6), l.balance_after.toFixed(6)].join("|"))
    .digest("hex");
}

/**
 * Parse un message OkPay transféré.
 *
 * Les blocs sont découpés sur les lignes « Type: » ; à l'intérieur, l'ordre des
 * clés est libre, une clé manquante est un refus nommé (numéro du bloc). Les
 * blocs peuvent être du plus récent au plus ancien : on ne trie pas ici, la
 * chronologie est l'affaire de sortLedger.
 */
export function parseOkpayMessage(text: string): OkpayParseResult {
  const src = text.replace(/\r\n?/g, "\n");
  // UN SEUL EN-TÊTE, et AVANT le premier bloc. Deux historiques collés (deux
  // en-têtes) attribuaient toutes les lignes à la PREMIÈRE wallet : la main
  // héritait du « Changed balance: 0 » d'une OkPay de compte, balanceAt rendait 0,
  // et je versais ma part d'une perte fictive. Un « Transaction: » dans un bloc
  // (ligne Details) pris pour en-tête, même faille. (Constat money-auditor
  // 2026-09-13, A1.) Le module promet de refuser plutôt que réparer : il refuse.
  const headers = [...src.matchAll(HEADER_RE_ALL)];
  if (headers.length === 0) {
    return { ok: false, error: "En-tête « <Pseudo> Transaction:<telegram_id> » introuvable — ce n'est pas une page d'historique OkPay." };
  }
  if (headers.length > 1) {
    return { ok: false, error: `${headers.length} en-têtes « Transaction:<id> » dans le même message (${headers.map(h => h[2]).join(", ")}) — `
                              + `deux historiques collés ? Transfère-les séparément : une page, une wallet.` };
  }
  const header = headers[0];
  const firstType = src.search(/^\s*Type\s*[:：]/im);
  if (firstType >= 0 && header.index! > firstType) {
    return { ok: false, error: `L'en-tête « Transaction:${header[2]} » apparaît APRÈS le premier bloc — format inattendu, message refusé.` };
  }
  const wallet_tg_id = header[2];
  const label = header[1].trim();
  const wallet_label = label === "" ? null : label;

  // Découpage en blocs : chaque ligne « Type: » ouvre un bloc, jusqu'au prochain.
  const lines = src.split("\n");
  const blocks: { start: number; lines: string[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (/^Type\s*[:：]/i.test(t)) blocks.push({ start: i + 1, lines: [] });
    if (blocks.length > 0 && t !== "") blocks[blocks.length - 1].lines.push(t);
  }
  if (blocks.length === 0) {
    return { ok: false, error: `Aucune ligne « Type: » dans le message de la wallet ${wallet_tg_id} — page vide ou format inconnu.` };
  }

  const out: ParsedOkpayLine[] = [];
  const skipped: OkpaySkipped[] = [];

  for (let b = 0; b < blocks.length; b++) {
    const blk = blocks[b];
    const kv = new Map<string, string>();
    const where = `bloc ${b + 1} (ligne ${blk.start})`;
    for (const l of blk.lines) {
      const m = KV_RE.exec(l);
      if (!m) continue; // texte libre dans un bloc (ligne de continuation) : ignoré
      const k = m[1].toLowerCase().replace(/\s+/g, " ").trim();
      // Deux « Amount: » dans un bloc : lequel est le bon ? Ni l'un ni l'autre — on
      // ne laisse pas « le dernier gagne » choisir un montant en silence.
      if (kv.has(k)) return { ok: false, error: `${where} : champ « ${m[1].trim()} » présent deux fois.` };
      kv.set(k, m[2].trim());
    }

    const need = (k: string): string | null => kv.get(k) ?? null;
    const rawType = need("type"), rawAmount = need("amount"), rawCurrency = need("currency"),
          rawBalance = need("changed balance"), rawDate = need("date");
    for (const [k, v] of [["Type", rawType], ["Amount", rawAmount], ["Currency", rawCurrency], ["Changed balance", rawBalance], ["date", rawDate]] as const) {
      if (v === null) return { ok: false, error: `${where} : champ « ${k} » manquant.` };
    }

    const currency = rawCurrency!.toUpperCase();
    if (currency !== "USDT") {
      // Autre devise : sa chaîne de solde n'est pas la nôtre. On saute, on le dit.
      skipped.push({ block: b + 1, reason: `devise ${rawCurrency} — seule la chaîne USDT est suivie` });
      continue;
    }

    const direction = parseDirection(rawType!);
    if (!direction) return { ok: false, error: `${where} : Type « ${rawType} » illisible (attendu ➕ ou ➖).` };

    const amount = parseOkpayNumber(rawAmount!);
    if (!amount.ok) return { ok: false, error: `${where} : Amount ${amount.reason}.` };
    const balance = parseOkpayNumber(rawBalance!);
    if (!balance.ok) return { ok: false, error: `${where} : Changed balance ${balance.reason}.` };

    if (!DATE_RE.test(rawDate!)) return { ok: false, error: `${where} : date « ${rawDate} » — attendu YYYY-MM-DD HH:MM:SS.` };
    // Calendrier strict : 2026-13-45 passe la regex mais n'existe pas.
    const d = new Date(rawDate!.replace(" ", "T") + "Z");
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 19).replace("T", " ") !== rawDate) {
      return { ok: false, error: `${where} : date « ${rawDate} » n'existe pas dans le calendrier.` };
    }

    const details = need("details");
    if (details === null) return { ok: false, error: `${where} : champ « Details » manquant.` };
    // La mention doit être CONNUE, et d'accord avec le Type. Une mention jamais vue
    // n'est pas devinée : refus nommé, Baki fournit l'échantillon.
    const mentionOut = DETAILS_OUT_RE.test(details), mentionIn = DETAILS_IN_RE.test(details);
    if (!mentionOut && !mentionIn) {
      return { ok: false, error: `${where} : mention inconnue dans Details (« ${details} ») — formes connues : « Transfer To : », « Transfer From : », « 轉賬給 : ». Fournis un échantillon pour l'ajouter.` };
    }
    if (direction === "-" && mentionIn) return { ok: false, error: `${where} : Type ➖ mais Details annonce une entrée (« ${details} ») — sens contradictoire, message refusé.` };
    if (direction === "+" && mentionOut) return { ok: false, error: `${where} : Type ➕ mais Details annonce une sortie (« ${details} ») — sens contradictoire, message refusé.` };
    const cp = parseCounterparty(details);
    if (cp.id === null) return { ok: false, error: `${where} : contrepartie sans « 【ID …】 » (« ${details} ») — forme inconnue, fournis un échantillon.` };
    const line: Omit<ParsedOkpayLine, "dedup_key"> = {
      direction, amount: amount.value, currency: "USDT", balance_after: balance.value,
      occurred_at: rawDate!, counterparty_tg_id: cp.id, counterparty_name: cp.name,
      raw_text: blk.lines.join("\n"),
    };
    out.push({ ...line, dedup_key: okpayDedupKey(wallet_tg_id, line) });
  }

  if (out.length === 0) {
    return { ok: false, error: `Aucune ligne USDT dans le message de la wallet ${wallet_tg_id} (${skipped.length} bloc(s) dans une autre devise).` };
  }
  return { ok: true, wallet_tg_id, wallet_label, lines: out, skipped };
}
