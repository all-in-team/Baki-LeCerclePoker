// Message OkPay TRANSFÉRÉ dans Telegram → grand livre du pool.
//
// Le canal principal de la v1 (arbitrage Baki 2026-09-13) : le joueur transfère
// sa page d'historique OkPay à Baki, Baki la transfère au bot ; Baki transfère
// aussi les pages des OkPay de compte depuis leurs sessions. Même tuyau, même
// parseur (lib/pool/okpay-parse), même ingestion (lib/pool/periods) que le
// textarea de secours de l'écran /ak-multi.
//
// Ce module ne fait QUE : reconnaître un message OkPay, l'ingérer, répondre ce
// qui a été fait. Aucune math d'argent — elle vit dans lib/pool/*.
import { getDb } from "@/lib/db";
import { OWNER_IDS, sendMsg } from "@/lib/telegram-commands/helpers";
import { ingestOkpayMessage, getLedger, walletOwnerOn } from "./periods";
import { checkLedgerChain } from "./engine";
import { parseOkpayMessage } from "./okpay-parse";

/** Reconnaissance rapide : l'en-tête « <Pseudo> Transaction:<id> » suffit à dire « c'est pour nous ». */
export function looksLikeOkpayMessage(text: string | undefined | null): boolean {
  return typeof text === "string" && /^.*Transaction\s*[:：]\s*\d{5,15}\s*$/im.test(text) && /^\s*Type\s*[:：]/im.test(text);
}

type TgMessage = {
  text?: string;
  chat?: { id: number | string; type?: string };
  from?: { id?: number; is_bot?: boolean };
  message_thread_id?: number;
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Qui a le droit d'alimenter le grand livre par Telegram : un propriétaire, ou un
 * joueur connu (players.telegram_id). Un inconnu qui transférerait une page OkPay
 * n'est pas une menace pour l'argent (les lignes sont des faits dédupliqués, et
 * une wallet inconnue ne compte dans aucun pool), mais on ne lui répond pas et on
 * n'ingère pas : le grand livre ne doit contenir que ce que Baki ou ses joueurs
 * ont envoyé.
 */
function senderAllowed(senderId: number | undefined): boolean {
  if (!senderId) return false;
  if (OWNER_IDS.has(senderId)) return true;
  const row = getDb().prepare(`SELECT 1 FROM players WHERE telegram_id = ?`).get(senderId);
  return !!row;
}

/**
 * Traite un message OkPay transféré. Rend true si le message était pour nous
 * (ingéré OU refusé avec explication) — le webhook s'arrête alors là.
 */
export async function handleOkpayForward(msg: TgMessage): Promise<boolean> {
  if (!looksLikeOkpayMessage(msg.text) || !msg.chat) return false;
  const chatId = msg.chat.id;
  const threadId = msg.message_thread_id;
  if (!senderAllowed(msg.from?.id)) {
    console.warn(`[POOL OKPAY] page transférée par un expéditeur inconnu (${msg.from?.id}) — ignorée`);
    return false;
  }

  const r = ingestOkpayMessage(msg.text!, "telegram_forward");
  if (!r.ok) {
    // Refus nommé du parseur : c'est ce que Baki doit lire pour fournir l'échantillon manquant.
    await sendMsg(chatId, `❌ Page OkPay refusée — ${esc(r.error)}`, threadId);
    return true;
  }

  const owner = r.owner.kind === "main" ? `main de <b>${esc(r.owner.player_name)}</b>`
    : r.owner.kind === "account" ? `${esc(r.owner.label)} de <b>${esc(r.owner.player_name)}</b>`
    : r.owner.kind === "agency" ? "wallet <b>agence</b>"
    : "wallet <b>inconnue</b> — à rattacher (main ou compte) sur /ak-multi";

  // La chaîne de CETTE wallet, sur tout ce qu'on en connaît : une rupture = une
  // page manquante entre deux dates, à réclamer.
  const lines = getLedger(r.wallet_tg_id);
  const breaks = checkLedgerChain(lines);
  const chain = breaks.length === 0
    ? `chaîne des soldes intacte (${lines.length} ligne${lines.length > 1 ? "s" : ""})`
    : `⚠️ ${breaks.length} rupture${breaks.length > 1 ? "s" : ""} de chaîne : ` + breaks.slice(0, 3)
        .map(b => `entre ${b.before.occurred_at} et ${b.after.occurred_at} (écart ${b.missing_delta >= 0 ? "+" : ""}${b.missing_delta.toFixed(6)})`)
        .join(" ; ") + (breaks.length > 3 ? " …" : "") + " — il manque une page.";

  const last = [...lines].sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))[0];
  const parts = [
    `✅ Page OkPay <b>${esc(r.wallet_label ?? r.wallet_tg_id)}</b> (${r.wallet_tg_id}) — ${owner}`,
    `${r.inserted} nouvelle${r.inserted > 1 ? "s" : ""} ligne${r.inserted > 1 ? "s" : ""}, ${r.ignored} déjà connue${r.ignored > 1 ? "s" : ""}`
      + (r.skipped_other_currency > 0 ? `, ${r.skipped_other_currency} hors USDT ignorée${r.skipped_other_currency > 1 ? "s" : ""}` : ""),
    last ? `dernier solde connu : <b>${last.balance_after.toFixed(6)}</b> USDT au ${last.occurred_at}` : null,
    chain,
    r.resolved_settlements > 0 ? `🔗 ${r.resolved_settlements} règlement${r.resolved_settlements > 1 ? "s" : ""} daté${r.resolved_settlements > 1 ? "s" : ""} à la seconde grâce à cette page` : null,
  ].filter(Boolean);
  await sendMsg(chatId, parts.join("\n"), threadId);
  return true;
}

/** Pour le textarea de secours : même chemin, source 'paste'. Exposé ici pour que la route reste fine. */
export function ingestPastedOkpay(text: string) {
  return ingestOkpayMessage(text, "paste");
}

export { parseOkpayMessage, walletOwnerOn };
